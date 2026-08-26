import {
  redactBugReportSensitiveText,
} from '../bugs/reports/redaction.js';
import {
  PLUGIN_ACTION_FAILURE_MESSAGE_MAX_UTF8_BYTES,
  projectPluginActionFailureMessage,
} from './actions/invocation.js';

export const PLUGIN_FAILURE_TEXT_MAX_UTF8_BYTES = PLUGIN_ACTION_FAILURE_MESSAGE_MAX_UTF8_BYTES;
const NEUTRAL_PLUGIN_FAILURE_TEXT = 'Plugin operation failed';
const REDACTED_PLUGIN_FAILURE_PATH = '[REDACTED_PATH]';

function isPluginFailurePathBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  const previous = value[index - 1] ?? '';
  return previous.trim().length === 0
    || previous === '"'
    || previous === "'"
    || previous === String.fromCharCode(96)
    || previous === '='
    || previous === '('
    || previous === ','
    || previous === '['
    || previous === '{'
    || previous === ';'
    || previous === '|'
    || previous === '&'
    || previous === '<'
    || previous === '>'
    || previous === ':';
}

function isPluginFailurePathSeparator(character: string | undefined): boolean {
  return character === '/' || character === '\\';
}

function isPluginFailurePathTerminator(character: string | undefined): boolean {
  return character === '"'
    || character === "'"
    || character === String.fromCharCode(96)
    || character === ';'
    || character === '|'
    || character === '&'
    || character === '<'
    || character === '>'
    || character === '('
    || character === ')'
    || character === '['
    || character === ']'
    || character === '{'
    || character === '}';
}

function isPluginFailureAsciiLetter(character: string | undefined): boolean {
  const code = character?.charCodeAt(0) ?? 0;
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function readPluginFailureAbsolutePathRootEnd(value: string, index: number): number | null {
  if (!isPluginFailurePathBoundary(value, index)) return null;
  if (
    value.slice(index, index + 'file:'.length).toLowerCase() === 'file:'
    && isPluginFailurePathSeparator(value[index + 'file:'.length])
  ) {
    return index + 'file:'.length + 1;
  }
  const character = value[index];
  const next = value[index + 1];
  if (
    isPluginFailureAsciiLetter(character)
    && next === ':'
    && isPluginFailurePathSeparator(value[index + 2])
  ) {
    return index + 3;
  }
  if (character === '\\') {
    return next === '\\' ? index + 2 : index + 1;
  }
  if (character === '/') {
    if (next !== '/') return index + 1;
    return value[index - 1] === ':' ? null : index + 2;
  }
  return null;
}

function readPluginFailureNextTokenStartsField(value: string, index: number): boolean {
  let cursor = index;
  while (
    cursor < value.length
    && (value[cursor] ?? '').trim().length > 0
    && !isPluginFailurePathTerminator(value[cursor])
  ) {
    if (value[cursor] === '=') return true;
    cursor += 1;
  }
  return false;
}

function readPluginFailureAbsolutePathEnd(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length) {
    const character = value[cursor];
    if (isPluginFailurePathTerminator(character)) return cursor;
    if ((character ?? '').trim().length > 0) {
      cursor += 1;
      continue;
    }

    let next = cursor;
    while (next < value.length && (value[next] ?? '').trim().length === 0) {
      next += 1;
    }
    if (
      next >= value.length
      || isPluginFailurePathTerminator(value[next])
      || readPluginFailureNextTokenStartsField(value, next)
    ) {
      return cursor;
    }
    cursor = next;
  }
  return cursor;
}

function redactPluginFailureAbsolutePaths(value: string): string {
  let redacted = '';
  let copyFrom = 0;
  let index = 0;
  while (index < value.length) {
    const rootEnd = readPluginFailureAbsolutePathRootEnd(value, index);
    if (rootEnd === null) {
      index += 1;
      continue;
    }
    const end = readPluginFailureAbsolutePathEnd(value, rootEnd);
    if (end <= rootEnd) {
      index += 1;
      continue;
    }
    redacted += value.slice(copyFrom, index) + REDACTED_PLUGIN_FAILURE_PATH;
    copyFrom = end;
    index = end;
  }
  return redacted + value.slice(copyFrom);
}

/**
 * The canonical public projection for arbitrary plugin/model failure text.
 * It admits only an Error message, strips credentials and local paths, and
 * applies the same bounded fallback behavior as plugin Action failures.
 */
export function projectPluginFailureText(error: unknown): string {
  try {
    return projectPluginFailureMessage(error instanceof Error ? error.message : '');
  } catch {
    return NEUTRAL_PLUGIN_FAILURE_TEXT;
  }
}

/**
 * The string form of the canonical plugin/model failure projection. Callers
 * supply a narrower published ceiling here rather than trimming after privacy
 * projection, so redaction and bounds remain a single owner.
 */
export function projectPluginFailureMessage(
  message: unknown,
  options: Readonly<{ maxUtf8Bytes?: number }> = {},
): string {
  try {
    if (typeof message !== 'string' || message.trim().length === 0) {
      return NEUTRAL_PLUGIN_FAILURE_TEXT;
    }
    const redacted = redactPluginFailureAbsolutePaths(
      redactBugReportSensitiveText(message),
    ).trim();
    if (!redacted) return NEUTRAL_PLUGIN_FAILURE_TEXT;
    return projectPluginActionFailureMessage(redacted, options);
  } catch {
    return NEUTRAL_PLUGIN_FAILURE_TEXT;
  }
}
