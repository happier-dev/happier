import type { PluginContextV1, ResolvedMcpServerSpecV1 } from '@happier-dev/plugin-sdk';

import { asRecord, normalizeString, readStringRecord } from './openCodeParsing.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';

type OpenCodeMcpRegistration = Readonly<{
  name: string;
  config: Readonly<Record<string, unknown>>;
}>;

const SAFE_REMOTE_MCP_PROTOCOLS = new Set(['http:', 'https:']);
const URL_WHITESPACE_PATTERN = /\s/u;

function readSafeRemoteMcpUrl(value: unknown): string | null {
  const url = normalizeString(value);
  if (!url || URL_WHITESPACE_PATTERN.test(url)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!SAFE_REMOTE_MCP_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  return parsed.href;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value
      .map((entry) => normalizeString(entry))
      .filter((entry) => entry.length > 0),
  );
}

function readEnvironment(value: unknown): Readonly<Record<string, string>> | null {
  const record = readStringRecord(value);
  const entries = Object.entries(record)
    .filter(([key, entry]) => key.length > 0 && typeof entry === 'string');
  if (entries.length === 0) return null;
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

export function readOpenCodeMcpRegistrations(raw: unknown): readonly OpenCodeMcpRegistration[] {
  const servers = asRecord(raw);
  if (!servers) return Object.freeze([]);

  const registrations: OpenCodeMcpRegistration[] = [];
  for (const [rawName, rawConfig] of Object.entries(servers)) {
    const name = normalizeString(rawName);
    const config = asRecord(rawConfig);
    const command = normalizeString(config?.command);
    if (!name || !command) continue;

    const args = readStringArray(config?.args);
    const environment = readEnvironment(config?.env);
    registrations.push(Object.freeze({
      name,
      config: Object.freeze({
        type: 'local',
        enabled: true,
        command: Object.freeze([command, ...args]),
        ...(environment ? { environment } : {}),
      }),
    }));
  }

  return Object.freeze(registrations);
}

function readResolvedRemoteRegistration(server: ResolvedMcpServerSpecV1): OpenCodeMcpRegistration | null {
  const name = normalizeString(server.name) || normalizeString(server.id);
  if (!name) return null;

  const transport = server.transport;
  if (transport.kind === 'http' || transport.kind === 'sse') {
    const url = readSafeRemoteMcpUrl(transport.url);
    if (!url) return null;
    return Object.freeze({
      name,
      config: Object.freeze({
        type: 'remote',
        enabled: true,
        url,
      }),
    });
  }

  if (transport.kind === 'managed') {
    const url = readSafeRemoteMcpUrl(transport.url);
    if (!url) return null;
    return Object.freeze({
      name,
      config: Object.freeze({
        type: 'remote',
        enabled: true,
        url,
      }),
    });
  }

  return null;
}

export function readResolvedOpenCodeMcpRegistrations(
  servers: readonly ResolvedMcpServerSpecV1[] | undefined,
): readonly OpenCodeMcpRegistration[] {
  const registrations: OpenCodeMcpRegistration[] = [];
  for (const server of servers ?? []) {
    const registration = readResolvedRemoteRegistration(server);
    if (registration) registrations.push(registration);
  }
  return Object.freeze(registrations);
}

function mergeOpenCodeMcpRegistrations(
  first: readonly OpenCodeMcpRegistration[],
  second: readonly OpenCodeMcpRegistration[],
): readonly OpenCodeMcpRegistration[] {
  const seen = new Set<string>();
  const merged: OpenCodeMcpRegistration[] = [];
  for (const registration of [...first, ...second]) {
    const key = registration.name;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(registration);
  }
  return Object.freeze(merged);
}

export async function registerOpenCodeMcpServers(params: Readonly<{
  ctx: PluginContextV1;
  client: OpenCodeServerClient;
  directory: string;
  mcpServers: unknown;
  resolvedMcpServers?: readonly ResolvedMcpServerSpecV1[];
}>): Promise<void> {
  const registrations = mergeOpenCodeMcpRegistrations(
    readOpenCodeMcpRegistrations(params.mcpServers),
    readResolvedOpenCodeMcpRegistrations(params.resolvedMcpServers),
  );
  for (const registration of registrations) {
    await params.client.mcpAdd({
      directory: params.directory,
      name: registration.name,
      config: registration.config,
    }).catch((error: unknown) => {
      params.ctx.logger.debug('[OpenCodeServer] Failed to register MCP server (non-fatal)', {
        serverName: registration.name,
        error,
      });
    });
  }
}

export function scheduleOpenCodeMcpServerRegistration(params: Readonly<{
  ctx: PluginContextV1;
  client: OpenCodeServerClient;
  directory: string;
  happierSessionId: string;
  mcpServers: unknown;
}>): void {
  void (async () => {
    const resolvedMcpServers = await params.ctx.mcp.resolveForSession({
      sessionId: params.happierSessionId,
      directory: params.directory,
    });
    await registerOpenCodeMcpServers({
      ctx: params.ctx,
      client: params.client,
      directory: params.directory,
      mcpServers: params.mcpServers,
      resolvedMcpServers,
    });
  })().catch((error: unknown) => {
    params.ctx.logger.debug('[OpenCodeServer] MCP server registration setup failed (non-fatal)', { error });
  });
}
