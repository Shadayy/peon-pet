'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SCAN_INTERVAL_MS = 1000;
const FILE_POLL_INTERVAL_MS = 500;
const SESSION_PRUNE_MS = 10 * 60 * 1000; // skip files older than 10min on startup
const PERMISSION_TIMEOUT_MS = 7000;
const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'Agent', 'AskUserQuestion']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionIdFromPath(filePath) {
  const base = path.basename(filePath, '.jsonl');
  return UUID_RE.test(base) ? base : null;
}

/**
 * Watches ~/.claude/projects/ for JSONL transcript files and emits events:
 *
 *   'session-event'  { sessionId, event, cwd, timestamp }
 *     events: SessionStart | SessionSeen | Stop | UserPromptSubmit | PermissionRequest | PostToolUseFailure
 *     - SessionSeen: file existed at startup (no animation, use timestamp as-is for tracker)
 *     - SessionStart: new file appeared while running (triggers waking animation)
 *
 *   'subagent-event' { sessionId, parentToolId, event }
 *     events: SubagentStart | SubagentStop
 */
class JsonlWatcher extends EventEmitter {
  constructor() {
    super();
    this._fileStates = new Map();  // filePath → FileState
    this._knownFiles = new Set();
    this._scanInterval = null;
    this._startupScanDone = false;
  }

  start() {
    this._scan();
    this._startupScanDone = true;
    this._scanInterval = setInterval(() => this._scan(), SCAN_INTERVAL_MS);
  }

  stop() {
    if (this._scanInterval) clearInterval(this._scanInterval);
    for (const state of this._fileStates.values()) this._teardownFile(state);
    this._fileStates.clear();
    this._knownFiles.clear();
  }

  _scan() {
    if (!fs.existsSync(PROJECTS_DIR)) return;
    try {
      const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(PROJECTS_DIR, d.name));

      for (const dir of projectDirs) {
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const filePath = path.join(dir, f);
          if (!this._knownFiles.has(filePath)) {
            this._knownFiles.add(filePath);
            this._watchFile(filePath);
          }
        }
      }
    } catch {}
  }

  _watchFile(filePath) {
    const sessionId = sessionIdFromPath(filePath);
    if (!sessionId) return;

    // Determine if this is a startup file or a new session
    const isStartup = !this._startupScanDone;

    let fileMtime;
    try {
      fileMtime = fs.statSync(filePath).mtimeMs;
    } catch { return; }

    // Skip stale files during startup — they can't be active sessions
    if (isStartup && (Date.now() - fileMtime) > SESSION_PRUNE_MS) return;

    const state = {
      sessionId,
      filePath,
      lineBuffer: '',
      offset: 0,
      fsWatcher: null,
      pollInterval: null,
      cwd: null,
      pendingTools: new Set(),
      permissionTimer: null,
      activeSubagentToolIds: new Set(),
    };

    // Emit session presence before reading content so tracker is populated
    this.emit('session-event', {
      sessionId,
      event: isStartup ? 'SessionSeen' : 'SessionStart',
      cwd: null,
      timestamp: isStartup ? fileMtime : Date.now(),
    });

    const readNew = () => this._readNewLines(state);
    try { state.fsWatcher = fs.watch(filePath, readNew); } catch {}
    state.pollInterval = setInterval(readNew, FILE_POLL_INTERVAL_MS);

    this._fileStates.set(filePath, state);
    readNew(); // read existing content to extract cwd
  }

  _teardownFile(state) {
    try { state.fsWatcher?.close(); } catch {}
    if (state.pollInterval) clearInterval(state.pollInterval);
    if (state.permissionTimer) clearTimeout(state.permissionTimer);
  }

  _readNewLines(state) {
    let buf;
    try {
      const fd = fs.openSync(state.filePath, 'r');
      const size = fs.fstatSync(fd).size;
      if (size <= state.offset) { fs.closeSync(fd); return; }
      buf = Buffer.alloc(size - state.offset);
      fs.readSync(fd, buf, 0, buf.length, state.offset);
      state.offset = size;
      fs.closeSync(fd);
    } catch { return; }

    const text = state.lineBuffer + buf.toString('utf8');
    const lines = text.split('\n');
    state.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) this._processLine(line, state);
    }
  }

  _processLine(line, state) {
    let record;
    try { record = JSON.parse(line); } catch { return; }

    // Extract cwd from the first record that has it and update the session
    if (!state.cwd && record.cwd) {
      state.cwd = record.cwd;
      this.emit('session-event', {
        sessionId: state.sessionId,
        event: 'SessionCwd',
        cwd: record.cwd,
        timestamp: Date.now(),
      });
    }

    const now = Date.now();

    switch (record.type) {
      case 'system':
        this._handleSystem(record, state, now);
        break;
      case 'assistant':
        this._handleAssistant(record, state, now);
        break;
      case 'user':
        this._handleUser(record, state, now);
        break;
      case 'progress':
        this._handleProgress(record, state);
        break;
    }
  }

  _handleSystem(record, state, now) {
    if (record.subtype === 'turn_duration') {
      state.pendingTools.clear();
      if (state.permissionTimer) {
        clearTimeout(state.permissionTimer);
        state.permissionTimer = null;
      }

      for (const parentToolId of state.activeSubagentToolIds) {
        this.emit('subagent-event', { sessionId: state.sessionId, parentToolId, event: 'SubagentStop' });
      }
      state.activeSubagentToolIds.clear();

      this.emit('session-event', { sessionId: state.sessionId, event: 'Stop', timestamp: now });
    }
  }

  _handleAssistant(record, state, now) {
    const content = record.message?.content;
    if (!Array.isArray(content)) return;

    const toolUses = content.filter(c => c.type === 'tool_use');
    const hasActivity = toolUses.length > 0 || content.some(c => c.type === 'text' && c.text?.trim());

    if (hasActivity) {
      this.emit('session-event', { sessionId: state.sessionId, event: 'UserPromptSubmit', timestamp: now });
    }

    for (const tool of toolUses) {
      if (!PERMISSION_EXEMPT_TOOLS.has(tool.name)) {
        state.pendingTools.add(tool.id);
      }
    }

    this._resetPermissionTimer(state);
  }

  _handleUser(record, state, now) {
    const content = record.message?.content;
    if (!Array.isArray(content)) return;

    let hadFailure = false;
    for (const item of content) {
      if (item.type === 'tool_result') {
        state.pendingTools.delete(item.tool_use_id);
        if (item.is_error) hadFailure = true;
      }
    }

    if (hadFailure) {
      this.emit('session-event', { sessionId: state.sessionId, event: 'PostToolUseFailure', timestamp: now });
    }

    if (state.pendingTools.size === 0 && state.permissionTimer) {
      clearTimeout(state.permissionTimer);
      state.permissionTimer = null;
    }
  }

  _handleProgress(record, state) {
    const data = record.data || {};

    if (data.type === 'agent_progress') {
      const parentToolId = record.toolUseId || data.parentToolId;
      if (parentToolId && !state.activeSubagentToolIds.has(parentToolId)) {
        state.activeSubagentToolIds.add(parentToolId);
        this.emit('subagent-event', { sessionId: state.sessionId, parentToolId, event: 'SubagentStart' });
      }
    }
  }

  _resetPermissionTimer(state) {
    if (state.pendingTools.size === 0) return;
    if (state.permissionTimer) return;

    state.permissionTimer = setTimeout(() => {
      state.permissionTimer = null;
      if (state.pendingTools.size > 0) {
        this.emit('session-event', { sessionId: state.sessionId, event: 'PermissionRequest', timestamp: Date.now() });
      }
    }, PERMISSION_TIMEOUT_MS);
  }
}

module.exports = { JsonlWatcher };
