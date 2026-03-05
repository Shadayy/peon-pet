'use strict';

// Drop-in replacement for deprecated "boolean" package (same API).
// Truthy: true, 'true', 't', 'yes', 'y', 'on', '1', 1 (and trimmed string variants).
// All other values (including undefined, null) => false.
const TRUTHY = new Set([
  true, 'true', 't', 'yes', 'y', 'on', '1',
  'TRUE', 'T', 'YES', 'Y', 'ON'
]);

// Booleanable = truthy set + falsy strings/numbers.
const FALSY_STRINGS = new Set([
  false, 'false', 'f', 'no', 'n', 'off', '0',
  'FALSE', 'F', 'NO', 'N', 'OFF'
]);

function parse(value) {
  if (value === true || value === 1) return true;
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') {
    const s = value.trim();
    return TRUTHY.has(s) || (s === '1');
  }
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'object' && value !== null) {
    const s = String(value).trim();
    return TRUTHY.has(s) || s === '1';
  }
  return false;
}

function isBooleanable(value) {
  if (value === true || value === 1 || value === false || value === 0) return true;
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') {
    const s = value.trim();
    return TRUTHY.has(s) || FALSY_STRINGS.has(s) || s === '0' || s === '1';
  }
  if (typeof value === 'number') return true;
  if (typeof value === 'object' && value !== null) {
    const s = String(value).trim();
    return TRUTHY.has(s) || FALSY_STRINGS.has(s) || s === '0' || s === '1';
  }
  return false;
}

module.exports = { boolean: parse, isBooleanable };
