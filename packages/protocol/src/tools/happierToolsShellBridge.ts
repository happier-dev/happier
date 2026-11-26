import { tokenizeShellWords } from './shellWords.js';

export type HappierToolsShellBridgeCommand =
  | Readonly<{
      kind: 'list';
      rawCommand: string;
      sessionId: string | null;
      directory: string | null;
      json: boolean;
      /**
       * The `--agent-bridge` provenance marker the host stamps on every command
       * it generates for an Agent's shell. It states who is invoking the CLI, so
       * the dispatcher can keep the invocation on the Agent surface instead of
       * inheriting the human operator's CLI authority from the stored
       * credentials the process happens to be able to read.
       */
      agentBridge: boolean;
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
      agentBridge: boolean;
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
  agentBridge: boolean;
}>;

function parseBridgeFlags(subcommand: 'list' | 'call', tokens: readonly string[]): ParsedBridgeFlags | null {
  let sessionId: string | null = null;
  let directory: string | null = null;
  let source: string | null = null;
  let tool: string | null = null;
  let argsJson: string | null = null;
  let json = false;
  let agentBridge = false;
  const seen = new Set<string>();

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (seen.has(token)) return null;
    seen.add(token);

    switch (token) {
      case '--json':
        json = true;
        continue;
      case '--agent-bridge':
        agentBridge = true;
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

  return { sessionId, directory, source, tool, argsJson, json, agentBridge };
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

/** Display-only recognition. Script invocations never enter the trusted shell bridge. */
export function parseHappierToolsRunCommand(command: string): { code: string; raw: boolean } | null {
  const rawCommand = command.trim();
  const hereDoc = rawCommand.match(/^([^\r\n]+?)\s*<<\s*(['"])([a-zA-Z_][a-zA-Z0-9_]*)\2[ \t]*\r?\n([\s\S]*)\r?\n\3$/u);
  const invocation = (hereDoc?.[1] ?? rawCommand)
    .replace(/^(?:"\$HAPPIER_CLI_BIN"|\$HAPPIER_CLI_BIN)(?=[ \t])/u, 'happier');
  const rawTokens = tokenizeShellWords(invocation, { allowQuotedNewlines: true });
  if (!rawTokens) return null;
  const words = stripLeadingEnvAssignmentTokens(rawTokens);
  const launcher = getShellPathBasename(words[0] ?? '');
  const tokens = launcher === 'happier' || launcher === 'happier.exe'
    ? ['happier', ...words.slice(1)] : normalizeHappierToolsTokens(words);
  if (!tokens || tokens[1] !== 'tools' || tokens[2] !== 'run') return null;

  const args = tokens.slice(3);
  if (hereDoc && !args.includes('-')) return null;
  if (hereDoc && hereDoc[4]?.split(/\r?\n/u).includes(hereDoc[3]!)) return null;
  const inlineAt = args.findIndex(arg => arg === '--code' || arg.startsWith('--code='));
  const inlineFlag = args[inlineAt];
  const inline = inlineFlag === '--code' ? args[inlineAt + 1] : inlineFlag?.slice('--code='.length);
  const raw = args.some((arg, index) => arg === '--raw' && !(inlineFlag === '--code' && index === inlineAt + 1));
  return { code: hereDoc?.[4] ?? inline ?? rawCommand, raw };
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
      agentBridge: flags.agentBridge,
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
    agentBridge: flags.agentBridge,
  };
}
