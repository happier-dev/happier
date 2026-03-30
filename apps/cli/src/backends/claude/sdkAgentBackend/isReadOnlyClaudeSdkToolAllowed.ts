import { extractShellCommand } from '@/agent/permissions/permissionToolIdentifier';
import { isShellCommandAllowed, splitShellCommandTopLevel } from '@/agent/permissions/shellCommandAllowlist';

const READ_ONLY_SAFE_TOOL_NAMES = new Set([
  'fetch',
  'read',
  'readnotebook',
  'search',
  'grep',
  'glob',
  'toolsearch',
  'ls',
  'list',
  'webfetch',
  'websearch',
  'todoread',
]);

const READ_ONLY_SHELL_TOOL_NAMES = new Set([
  'bash',
  'execute',
  'shell',
  'terminal',
]);

const READ_ONLY_SHELL_PATTERNS = [
  { kind: 'prefix', value: 'ls' },
  { kind: 'prefix', value: 'pwd' },
  { kind: 'prefix', value: 'cat ' },
  { kind: 'prefix', value: 'head ' },
  { kind: 'prefix', value: 'tail ' },
  { kind: 'prefix', value: 'wc ' },
  { kind: 'prefix', value: 'sort ' },
  { kind: 'prefix', value: 'uniq ' },
  { kind: 'prefix', value: 'cut ' },
  { kind: 'prefix', value: 'tr ' },
  { kind: 'prefix', value: 'echo ' },
  { kind: 'prefix', value: 'basename' },
  { kind: 'prefix', value: 'find ' },
  { kind: 'prefix', value: 'grep ' },
  { kind: 'prefix', value: 'rg ' },
  { kind: 'prefix', value: 'git status' },
  { kind: 'prefix', value: 'git diff' },
  { kind: 'prefix', value: 'git show' },
  { kind: 'prefix', value: 'git log' },
  { kind: 'prefix', value: 'git ls-files' },
  { kind: 'exact', value: 'git rev-parse --show-toplevel' },
  { kind: 'exact', value: 'git branch --show-current' },
  { kind: 'prefix', value: 'sed -n' },
] as const;

const DEV_NULL_REDIRECT_PATTERN = /(^|\s)(?:\d+)?>>?\s*\/dev\/null(?=$|\s)/g;
const UNSAFE_SHELL_SUBSTITUTION_PATTERN = /`|<\(|>\(/;
const READ_ONLY_SHELL_CONTROL_PREFIX_PATTERN = /^(?:do|then|else|if|elif)\b\s*/;
const READ_ONLY_SHELL_COMMENT_PATTERN = /^#.*$/;
const READ_ONLY_SHELL_TEST_PATTERN = /^\[\s*!?\s*-(?:d|e|f|L)\s+.+\s*\]$/;
const READ_ONLY_TEST_COMMAND_PATTERN = /^test\b\s+!?-?(?:d|e|f|L)\b(?:\s+.+)?$/;
const READ_ONLY_FOR_LOOP_PATTERN = /^for\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+.+$/;
const READ_ONLY_SHELL_ASSIGNMENT_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))(?:\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))*$/;

function normalizeToolNameForPolicy(toolName: string): string {
  return String(toolName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function stripAllowedDevNullRedirects(command: string): string {
  return command.replace(DEV_NULL_REDIRECT_PATTERN, ' ').replace(/[^\S\r\n]+/g, ' ').trim();
}

function hasUnsupportedRedirection(command: string): boolean {
  return /[<>]/.test(command);
}

function stripReadOnlyShellControlPrefixes(segment: string): string {
  let current = segment.trim();
  let previous = '';
  while (current && current !== previous) {
    previous = current;
    current = current.replace(READ_ONLY_SHELL_CONTROL_PREFIX_PATTERN, '').trim();
  }
  return current;
}

function isReadOnlyShellControlSegment(segment: string): boolean {
  const raw = segment.trim();
  if (!raw) return false;
  if (READ_ONLY_SHELL_COMMENT_PATTERN.test(raw)) return true;
  if (raw === 'fi' || raw === 'done') return true;
  if (READ_ONLY_FOR_LOOP_PATTERN.test(raw)) return true;
  if (READ_ONLY_SHELL_TEST_PATTERN.test(raw)) return true;
  if (READ_ONLY_TEST_COMMAND_PATTERN.test(raw)) return true;
  if (READ_ONLY_SHELL_ASSIGNMENT_PATTERN.test(raw)) return true;
  return false;
}

function normalizeReadOnlyStructuredShellCommand(command: string): string | null {
  if (!command.trim()) {
    return null;
  }

  let normalized = '';
  const substitutionCommands: string[] = [];
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  while (index < command.length) {
    const current = command[index];
    if (escaped) {
      normalized += current;
      escaped = false;
      index += 1;
      continue;
    }

    if (current === '\\') {
      normalized += current;
      escaped = true;
      index += 1;
      continue;
    }

    if (!inDouble && current === '\'') {
      inSingle = !inSingle;
      normalized += current;
      index += 1;
      continue;
    }

    if (!inSingle && current === '"') {
      inDouble = !inDouble;
      normalized += current;
      index += 1;
      continue;
    }

    if (
      !inSingle
      && !inDouble
      && current === '#'
      && (index === 0 || /[\s;]/.test(command[index - 1] ?? ''))
    ) {
      normalized += '#';
      index += 1;
      while (index < command.length && command[index] !== '\n') {
        index += 1;
      }
      if (index < command.length && command[index] === '\n') {
        normalized += '\n';
        index += 1;
      }
      continue;
    }

    if (!inSingle && command.startsWith('$(', index)) {
      let depth = 1;
      let inner = '';
      index += 2;
      let innerInSingle = false;
      let innerInDouble = false;
      let innerEscaped = false;
      for (; index < command.length; index += 1) {
        const innerChar = command[index];
        if (innerEscaped) {
          inner += innerChar;
          innerEscaped = false;
          continue;
        }
        if (innerChar === '\\') {
          inner += innerChar;
          innerEscaped = true;
          continue;
        }
        if (!innerInDouble && innerChar === '\'') {
          innerInSingle = !innerInSingle;
          inner += innerChar;
          continue;
        }
        if (!innerInSingle && innerChar === '"') {
          innerInDouble = !innerInDouble;
          inner += innerChar;
          continue;
        }
        if (!innerInSingle && command.startsWith('$(', index)) {
          depth += 1;
          inner += '$(';
          index += 1;
          continue;
        }
        if (!innerInSingle && !innerInDouble && innerChar === ')') {
          depth -= 1;
          if (depth === 0) {
            break;
          }
          inner += innerChar;
          continue;
        }
        inner += innerChar;
      }
      if (depth !== 0 || innerInSingle || innerInDouble || innerEscaped) {
        return null;
      }
      const normalizedInner = normalizeReadOnlyStructuredShellCommand(inner.trim());
      if (!normalizedInner) {
        return null;
      }
      substitutionCommands.push(normalizedInner);
      normalized += '__READ_ONLY_SUBSTITUTION__';
      index += 1;
      continue;
    }

    normalized += current;
    index += 1;
  }

  if (inSingle || inDouble || escaped) {
    return null;
  }

  if (UNSAFE_SHELL_SUBSTITUTION_PATTERN.test(normalized)) {
    return null;
  }

  for (const substitutionCommand of substitutionCommands) {
    if (!isReadOnlyStructuredShellCommandAllowed(substitutionCommand)) {
      return null;
    }
  }

  return normalized;
}

function isReadOnlyStructuredShellCommandAllowed(command: string): boolean {
  const normalized = normalizeReadOnlyStructuredShellCommand(command);
  if (!normalized) {
    return false;
  }

  const split = splitShellCommandTopLevel(normalized);
  if (!split.ok) {
    return false;
  }

  for (const rawSegment of split.segments) {
    const segment = stripReadOnlyShellControlPrefixes(rawSegment);
    if (!segment) {
      continue;
    }
    if (isReadOnlyShellControlSegment(segment)) {
      continue;
    }
    if (!isShellCommandAllowed(segment, [...READ_ONLY_SHELL_PATTERNS])) {
      return false;
    }
  }

  return split.segments.length > 0;
}

export function isReadOnlyClaudeSdkToolAllowed(toolName: string, input: unknown): boolean {
  const normalizedToolName = normalizeToolNameForPolicy(toolName);
  if (READ_ONLY_SAFE_TOOL_NAMES.has(normalizedToolName)) {
    return true;
  }

  if (!READ_ONLY_SHELL_TOOL_NAMES.has(normalizedToolName)) {
    return false;
  }

  const command = extractShellCommand(input);
  if (!command) {
    return false;
  }

  const strippedCommand = stripAllowedDevNullRedirects(command);
  if (!strippedCommand) {
    return false;
  }

  if (hasUnsupportedRedirection(strippedCommand)) {
    return false;
  }

  if (isShellCommandAllowed(strippedCommand, [...READ_ONLY_SHELL_PATTERNS])) {
    return true;
  }

  return isReadOnlyStructuredShellCommandAllowed(strippedCommand);
}
