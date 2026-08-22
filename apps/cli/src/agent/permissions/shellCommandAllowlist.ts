type ShellSplitResult =
  | { ok: true; segments: string[] }
  | { ok: false };

type ShellSplitOp = 'seq' | 'pipe' | 'and' | 'or' | 'bg';
type ShellSplitItem = { segment: string; opBefore: ShellSplitOp | null };
type ShellSplitDetailedResult =
  | { ok: true; items: ShellSplitItem[] }
  | { ok: false };

function matchesPrefixTokenBoundary(command: string, prefix: string): boolean {
  if (!command || !prefix) return false;
  if (!command.startsWith(prefix)) return false;
  if (command.length === prefix.length) return true;
  if (prefix.endsWith(' ')) return true;
  return command[prefix.length] === ' ';
}

/**
 * Split a shell command into top-level segments by control operators (`&&`, `||`, `|`, `;`, `&`, newlines).
 *
 * This is a conservative parser:
 * - It respects single/double quotes and backslash escapes.
 * - If we detect command substitution/backticks (`$(` or `` ` ``), we fail-closed (ok: false).
 * - If quotes are unbalanced, we fail-closed (ok: false).
 */
export function splitShellCommandTopLevel(command: string): ShellSplitResult {
  const detailed = splitShellCommandTopLevelDetailed(command);
  if (!detailed.ok) return { ok: false };
  return { ok: true, segments: detailed.items.map((it) => it.segment) };
}

function splitShellCommandTopLevelDetailed(command: string): ShellSplitDetailedResult {
  const src = command.trim();
  if (!src) return { ok: true, items: [] };

  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const items: ShellSplitItem[] = [];
  let current = '';
  let currentOpBefore: ShellSplitOp | null = null;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) items.push({ segment: trimmed, opBefore: currentOpBefore });
    current = '';
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }

    if (!inDouble && ch === '\'') {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      // Fail-closed on command substitution / backticks: too hard to reason safely.
      if (ch === '`') return { ok: false };
      if (ch === '$' && src[i + 1] === '(') return { ok: false };
      // Fail-closed on process substitution: it embeds a command in an I/O redirection.
      if (ch === '<' && src[i + 1] === '(') return { ok: false };
      if (ch === '>' && src[i + 1] === '(') return { ok: false };

      // Control operators.
      if (ch === '\n' || ch === ';') {
        flush();
        currentOpBefore = 'seq';
        continue;
      }

      if (ch === '&') {
        const isAnd = src[i + 1] === '&';
        if (isAnd) i++; // consume second &
        flush();
        currentOpBefore = isAnd ? 'and' : 'bg';
        continue;
      }

      if (ch === '|') {
        const isOr = src[i + 1] === '|';
        if (isOr) i++; // consume second |
        flush();
        currentOpBefore = isOr ? 'or' : 'pipe';
        continue;
      }
    }

    current += ch;
  }

  if (escaped || inSingle || inDouble) return { ok: false };
  flush();
  return { ok: true, items };
}

type ShellAllowPattern =
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string };

function isSegmentAllowed(segment: string, patterns: ShellAllowPattern[]): boolean {
  const raw = segment.trim();
  if (!raw) return false;

  for (const p of patterns) {
    if (p.kind === 'exact') {
      if (raw === p.value) return true;
    }
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) return false;
  const effective = raw;
  const firstWord = effective.split(/\s+/).filter(Boolean)[0] ?? '';

  for (const p of patterns) {
    if (p.kind !== 'prefix') continue;
    const normalizedPrefix = p.value.trim();
    if (!normalizedPrefix) continue;

    // Command-name pattern: `git:*` should match `git ...` but not `github ...`.
    if (!/\s/.test(normalizedPrefix)) {
      if (firstWord === normalizedPrefix) return true;
      continue;
    }

    if (matchesPrefixTokenBoundary(effective, normalizedPrefix)) return true;
  }

  return false;
}

/**
 * Check whether a shell command is allowed by a set of explicit allow patterns.
 *
 * If the command contains control operators, we only allow it when *every* top-level segment is allowed.
 * This prevents `git:*` from accidentally allowing `git status && rm -rf ...`.
 */
export function isShellCommandAllowed(command: string, patterns: ShellAllowPattern[]): boolean {
  const raw = command.trim();
  if (!raw) return false;

  // Exact match on the full command always wins (including chained/piped commands).
  for (const p of patterns) {
    if (p.kind === 'exact' && p.value === raw) return true;
  }

  if (hasUnquotedRedirection(raw)) return false;

  const split = splitShellCommandTopLevelDetailed(raw);
  if (!split.ok) return false;

  for (const item of split.items) {
    if (!isSegmentAllowed(item.segment, patterns)) return false;
  }

  return split.items.length > 0;
}

function hasUnquotedRedirection(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && (ch === '<' || ch === '>')) return true;
  }

  return escaped || inSingle || inDouble;
}
