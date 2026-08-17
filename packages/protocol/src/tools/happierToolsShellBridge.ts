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
    const next = command[index + 1] ?? '';

    if (ch === '\n' || ch === '\r') return null;

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

    if (!inSingle && ch === '`') return null;
    if (!inSingle && ch === '$' && next === '(') return null;
    if (!inSingle && !inDouble && (ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>')) {
      return null;
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

type ParsedBridgeFlags = Readonly<{
  sessionId: string | null;
  directory: string | null;
  source: string | null;
  tool: string | null;
  argsJson: string | null;
  json: boolean;
}>;

function parseBridgeFlags(subcommand: 'list' | 'call', tokens: readonly string[]): ParsedBridgeFlags | null {
  let sessionId: string | null = null;
  let directory: string | null = null;
  let source: string | null = null;
  let tool: string | null = null;
  let argsJson: string | null = null;
  let json = false;
  const seen = new Set<string>();

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (seen.has(token)) return null;
    seen.add(token);

    switch (token) {
      case '--json':
        json = true;
        continue;
      case '--session-id': {
        const value = tokens[index + 1];
        if (typeof value !== 'string' || value.trim().length === 0) return null;
        sessionId = value;
        index++;
        continue;
      }
      case '--directory': {
        const value = tokens[index + 1];
        if (typeof value !== 'string' || value.trim().length === 0) return null;
        directory = value;
        index++;
        continue;
      }
      case '--source': {
        if (subcommand !== 'call') return null;
        const value = tokens[index + 1];
        if (typeof value !== 'string' || value.trim().length === 0) return null;
        source = value;
        index++;
        continue;
      }
      case '--tool': {
        if (subcommand !== 'call') return null;
        const value = tokens[index + 1];
        if (typeof value !== 'string' || value.trim().length === 0) return null;
        tool = value;
        index++;
        continue;
      }
      case '--args-json': {
        if (subcommand !== 'call') return null;
        const value = tokens[index + 1];
        if (typeof value !== 'string' || value.trim().length === 0) return null;
        argsJson = value;
        index++;
        continue;
      }
      default:
        return null;
    }
  }

  return { sessionId, directory, source, tool, argsJson, json };
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

  const rawTokens = tokenizeShellWords(rawCommand);
  const tokens = rawTokens ? normalizeHappierToolsTokens(stripLeadingEnvAssignmentTokens(rawTokens)) : null;
  if (!tokens || tokens.length < 3) return null;

  const subcommand = tokens[2];
  if (subcommand !== 'list' && subcommand !== 'call') return null;

  const flags = parseBridgeFlags(subcommand, tokens.slice(3));
  if (!flags) return null;

  if (subcommand === 'list') {
    return {
      kind: 'list',
      rawCommand,
      sessionId: flags.sessionId,
      directory: flags.directory,
      json: flags.json,
    };
  }

  if (!flags.source || !flags.tool) return null;

  const argsJson = flags.argsJson;
  let args: unknown | null = null;
  if (argsJson != null) {
    try {
      args = JSON.parse(argsJson);
    } catch {
      return null;
    }
  }

  return {
    kind: 'call',
    rawCommand,
    sessionId: flags.sessionId,
    directory: flags.directory,
    source: flags.source,
    tool: flags.tool,
    argsJson,
    args,
    json: flags.json,
  };
}
