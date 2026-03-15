type McpServersRecord = Record<string, unknown>;

/**
 * NOTE:
 * This helper exists ONLY for the Claude Agent SDK runner (remote mode) where we cannot pass
 * through raw CLI `--mcp-config` flags and must instead materialize an `mcpServers` object.
 *
 * For CLI-based spawns (local mode + legacy remote runner), Claude Code already merges multiple
 * `--mcp-config` inputs additively (last-write-wins on server name collisions). In those paths,
 * we intentionally avoid parsing/merging user JSON and instead append Happier's `--mcp-config`
 * after any user-provided passthrough flags.
 */
const FORBIDDEN_MCP_SERVER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeMcpServerName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return !FORBIDDEN_MCP_SERVER_NAMES.has(trimmed);
}

function extractMcpConfigJsonValues(args?: readonly string[] | null): { values: string[]; remainingArgs: string[] | undefined } {
  if (!args || args.length === 0) return { values: [], remainingArgs: args ? [] : undefined };

  const values: string[] = [];
  const remaining: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--mcp-config') {
      const next = args[index + 1];
      if (typeof next === 'string' && next.length > 0) {
        values.push(next);
        index += 1;
        continue;
      }
      remaining.push(arg);
      continue;
    }

    if (typeof arg === 'string' && arg.startsWith('--mcp-config=')) {
      const value = arg.slice('--mcp-config='.length);
      if (value.length > 0) {
        values.push(value);
        continue;
      }
    }

    remaining.push(arg);
  }

  return { values, remainingArgs: remaining };
}

function parseMcpServersFromConfigJson(configJson: string): McpServersRecord | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  // Defense-in-depth against prototype pollution payloads like {"mcpServers":{"__proto__":{...}}}.
  // JSON.parse can invoke the Object.prototype __proto__ setter, mutating the prototype chain such that
  // the forbidden key is no longer an enumerable own property. Reject any unexpected prototypes.
  const parsedProto = Object.getPrototypeOf(parsed);
  if (parsedProto !== Object.prototype && parsedProto !== null) return null;
  const servers = parsed.mcpServers;
  if (!isRecord(servers)) return null;
  const serversProto = Object.getPrototypeOf(servers);
  if (serversProto !== Object.prototype && serversProto !== null) return null;
  const out: McpServersRecord = Object.create(null);
  for (const [name, value] of Object.entries(servers)) {
    if (!isSafeMcpServerName(name)) return null;
    out[name] = value;
  }
  return out;
}

export function tryMergeUserMcpConfigArgsIntoHappierMcp(params: {
  baseMcpServers: McpServersRecord;
  claudeArgs?: readonly string[] | null;
}): { mergedMcpServers: McpServersRecord; mergedMcpConfigJson: string; filteredClaudeArgs: string[] | undefined } | null {
  const extracted = extractMcpConfigJsonValues(params.claudeArgs);
  if (extracted.values.length === 0) return null;

  const userServerSets: McpServersRecord[] = [];
  for (const value of extracted.values) {
    const servers = parseMcpServersFromConfigJson(value);
    if (!servers) return null;
    userServerSets.push(servers);
  }

  const merged: McpServersRecord = Object.create(null);
  for (const servers of userServerSets) {
    for (const [name, value] of Object.entries(servers)) {
      merged[name] = value;
    }
  }

  // Internal Happier MCP must always win over user-provided keys.
  for (const [name, value] of Object.entries(params.baseMcpServers)) {
    if (!isSafeMcpServerName(name)) continue;
    merged[name] = value;
  }

  return {
    mergedMcpServers: merged,
    mergedMcpConfigJson: JSON.stringify({ mcpServers: merged }),
    filteredClaudeArgs: extracted.remainingArgs,
  };
}
