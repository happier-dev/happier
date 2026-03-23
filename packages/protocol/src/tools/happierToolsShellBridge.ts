export type HappierToolsShellBridgeCommand =
  | Readonly<{
      kind: 'list';
      rawCommand: string;
      sessionId: string | null;
      directory: string | null;
      json: boolean;
    }>
  | Readonly<{
      kind: 'call';
      rawCommand: string;
      sessionId: string | null;
      directory: string | null;
      source: string;
      tool: string;
      argsJson: string | null;
      args: unknown | null;
      json: boolean;
    }>;

function normalizeShellPathLike(token: string): string {
  return String(token ?? '').trim().replaceAll('\\', '/').toLowerCase();
}

function getShellPathBasename(token: string): string {
  const normalized = normalizeShellPathLike(token);
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
}

function isRuntimeExecutableToken(token: string): boolean {
  const base = getShellPathBasename(token);
  return base === 'node' || base === 'node.exe' || base === 'bun' || base === 'bun.exe';
}

function isLikelyHappierCliEntrypointToken(token: string): boolean {
  const normalized = normalizeShellPathLike(token);
  const base = getShellPathBasename(token);
  if (base.includes('happier')) return true;
  if (normalized.includes('/@happier-dev/cli/')) return true;
  if (normalized.includes('/apps/cli/')) return true;
  return (base === 'index.mjs' || base === 'index.ts') && normalized.includes('/cli/');
}

function stripSimpleUnsetPrelude(command: string): string {
  const trimmed = command.trimStart();
  const match = trimmed.match(/^unset(?:\s+[A-Za-z_][A-Za-z0-9_]*)+\s*;\s*/);
  if (!match) return command;
  return trimmed.slice(match[0].length);
}

function tokenizeShellWords(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushCurrent = () => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };

  for (let index = 0; index < command.length; index++) {
    const ch = command[index] ?? '';

    if (escaped) {
      current += ch;
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

    if (!inSingle && !inDouble && /\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
  }

  if (escaped || inSingle || inDouble) return null;
  pushCurrent();
  return tokens;
}

function stripLeadingEnvAssignmentTokens(tokens: readonly string[]): string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) {
    index++;
  }
  return tokens.slice(index);
}

function readFlagValue(tokens: readonly string[], flag: string): string | null {
  const index = tokens.indexOf(flag);
  if (index === -1) return null;
  const value = tokens[index + 1];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeHappierToolsTokens(tokens: readonly string[]): string[] | null {
  if (tokens.length < 3) return null;
  if (tokens[0] === 'happier' && tokens[1] === 'tools') return [...tokens];
  if (!isRuntimeExecutableToken(tokens[0] ?? '')) return null;

  for (let index = 1; index < tokens.length - 2; index++) {
    if (!isLikelyHappierCliEntrypointToken(tokens[index] ?? '')) continue;
    if (tokens[index + 1] !== 'tools') continue;
    return ['happier', ...tokens.slice(index + 1)];
  }

  return null;
}

export function parseHappierToolsShellBridgeCommand(command: string): HappierToolsShellBridgeCommand | null {
  const rawCommand = String(command ?? '').trim();
  if (!rawCommand) return null;

  let stripped = rawCommand;
  for (let index = 0; index < 5; index++) {
    const next = stripSimpleUnsetPrelude(stripped).trim();
    if (next === stripped) break;
    stripped = next;
  }

  const rawTokens = tokenizeShellWords(stripped);
  const tokens = rawTokens ? normalizeHappierToolsTokens(stripLeadingEnvAssignmentTokens(rawTokens)) : null;
  if (!tokens || tokens.length < 3) return null;

  const subcommand = tokens[2];
  const json = tokens.includes('--json');
  const sessionId = readFlagValue(tokens, '--session-id');
  const directory = readFlagValue(tokens, '--directory');

  if (subcommand === 'list') {
    return {
      kind: 'list',
      rawCommand,
      sessionId,
      directory,
      json,
    };
  }

  if (subcommand !== 'call') return null;

  const source = readFlagValue(tokens, '--source');
  const tool = readFlagValue(tokens, '--tool');
  if (!source || !tool) return null;

  const argsJson = readFlagValue(tokens, '--args-json');
  let args: unknown | null = null;
  if (argsJson != null) {
    try {
      args = JSON.parse(argsJson);
    } catch {
      args = null;
    }
  }

  return {
    kind: 'call',
    rawCommand,
    sessionId,
    directory,
    source,
    tool,
    argsJson,
    args,
    json,
  };
}
