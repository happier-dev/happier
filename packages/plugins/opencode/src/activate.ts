import type {
  PluginApi,
  McpServerSpecV1,
} from '@happier-dev/plugin-sdk';

import { readOpenCodeMcpConfigServers } from './agent/mcp/discovery.js';
import { createOpenCodeBackendEngine } from './agent/runtime/engine.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function toRedactedEnvKeys(envKeys: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (envKeys.length === 0) return undefined;
  return Object.freeze(Object.fromEntries(envKeys.map((key) => [key, ''])));
}

function normalizeOpenCodeMcpServerIdSegment(name: string): string | null {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return normalized.length > 0 ? normalized : null;
}

function toOpenCodeMcpServerSpec(server: Awaited<ReturnType<typeof readOpenCodeMcpConfigServers>>['servers'][number]): McpServerSpecV1 | null {
  if (server.enabled === false) return null;
  const idSegment = normalizeOpenCodeMcpServerIdSegment(server.name);
  if (!idSegment) return null;
  const id = `opencode.config.${idSegment}`;
  if (server.transport === 'stdio' && server.stdio) {
    return {
      id,
      name: server.name,
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'binary',
          executablePath: server.stdio.command,
          args: server.stdio.args,
          ...(toRedactedEnvKeys(server.envKeys) ? { env: toRedactedEnvKeys(server.envKeys) } : {}),
        },
      },
    };
  }
  if ((server.transport === 'http' || server.transport === 'sse') && server.remote?.url) {
    return {
      id,
      name: server.name,
      transport: {
        kind: server.transport,
        url: server.remote.url,
      },
    };
  }
  return null;
}

function readOpenCodeConfigDiscoveryProvider(): typeof PLUGIN_MANIFEST.contributes.mcp.discoveryProviders[number] {
  const provider = PLUGIN_MANIFEST.contributes.mcp.discoveryProviders.find((entry) => entry.id === 'opencode.config');
  if (!provider) {
    throw new Error('OpenCode plugin manifest must declare opencode.config MCP discovery provider');
  }
  return provider;
}

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'opencode',
    create: async (ctx) => {
      ctx.logger.debug('[plugins/opencode] Creating backend engine');
      return createOpenCodeBackendEngine(ctx);
    },
  });
  const configDiscoveryProvider = readOpenCodeConfigDiscoveryProvider();
  api.registerMcpDiscoveryProvider({
    id: configDiscoveryProvider.id,
    discover: async (input) => {
      const detected = await readOpenCodeMcpConfigServers({
        directory: input?.directory ?? null,
      });
      const servers = detected.servers
        .map(toOpenCodeMcpServerSpec)
        .filter((server): server is McpServerSpecV1 => server !== null);
      const countsById = new Map<string, number>();
      for (const server of servers) {
        countsById.set(server.id, (countsById.get(server.id) ?? 0) + 1);
      }
      return {
        servers: servers.filter((server) => countsById.get(server.id) === 1),
        warnings: detected.warnings,
      };
    },
  });
}
