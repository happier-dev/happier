import type { ResolvedMcpServerSpecV1 } from '@happier-dev/plugin-sdk/mcp';

import type { AntigravityLocalharnessMcpServerConfig } from '../client/protocol.js';

export type AntigravityLocalharnessUnsupportedMcpServer = Readonly<{
  id: string;
  name: string;
  transportKind: string;
  reason: 'invalid_url' | 'missing_url' | 'unsupported_stdio' | 'unsupported_transport';
}>;

export type AntigravityLocalharnessMcpMapping = Readonly<{
  configs: readonly AntigravityLocalharnessMcpServerConfig[];
  unsupported: readonly AntigravityLocalharnessUnsupportedMcpServer[];
}>;

const SAFE_REMOTE_MCP_PROTOCOLS = new Set(['http:', 'https:']);
const URL_WHITESPACE_PATTERN = /\s/u;

function readServerName(server: ResolvedMcpServerSpecV1): string {
  return server.name || server.id;
}

function readSafeRemoteUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || URL_WHITESPACE_PATTERN.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!SAFE_REMOTE_MCP_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  return parsed.href;
}

function unsupportedServer(
  server: ResolvedMcpServerSpecV1,
  reason: AntigravityLocalharnessUnsupportedMcpServer['reason'],
): AntigravityLocalharnessUnsupportedMcpServer {
  return Object.freeze({
    id: server.id,
    name: readServerName(server),
    transportKind: server.transport.kind,
    reason,
  });
}

export function mapMcpServersToLocalharnessConfig(
  servers: readonly ResolvedMcpServerSpecV1[],
): AntigravityLocalharnessMcpMapping {
  const configs: AntigravityLocalharnessMcpServerConfig[] = [];
  const unsupported: AntigravityLocalharnessUnsupportedMcpServer[] = [];

  for (const server of servers) {
    if (server.transport.kind === 'http' || server.transport.kind === 'sse') {
      const url = readSafeRemoteUrl(server.transport.url);
      if (!url) {
        unsupported.push(unsupportedServer(server, 'invalid_url'));
        continue;
      }
      configs.push(Object.freeze({
        name: readServerName(server),
        http: { url },
      }));
      continue;
    }

    if (server.transport.kind === 'managed') {
      const url = readSafeRemoteUrl(server.transport.url);
      if (!url) {
        unsupported.push(unsupportedServer(server, 'missing_url'));
        continue;
      }
      configs.push(Object.freeze({
        name: readServerName(server),
        http: { url },
      }));
      continue;
    }

    if (server.transport.kind === 'stdio') {
      unsupported.push(unsupportedServer(server, 'unsupported_stdio'));
      continue;
    }

    unsupported.push(unsupportedServer(server, 'unsupported_transport'));
  }

  return Object.freeze({
    configs: Object.freeze(configs),
    unsupported: Object.freeze(unsupported),
  });
}

export function formatUnsupportedMcpServersDiagnostic(
  unsupported: readonly AntigravityLocalharnessUnsupportedMcpServer[],
): string | null {
  if (unsupported.length === 0) return null;
  const details = unsupported
    .map((server) => `${server.name} (${server.transportKind}: ${server.reason})`)
    .join(', ');
  return `Antigravity localharness cannot attach these MCP servers: ${details}.`;
}
