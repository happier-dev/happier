import type {
  McpServerSpecV1,
  PluginApiMcpDiscoveryProviderRegistrationV1,
  PluginDisposable,
} from '@happier-dev/plugin-sdk';
import type { BundledRegisterBackendEngineV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';

import { detectOpenCodeMcpServers } from './agent/mcp/discovery.js';
import { createOpenCodeBackendEngine } from './agent/runtime/engine.js';

type PluginApiForOpenCodeV1 = Readonly<{
  registerBackendEngine: (registration: BundledRegisterBackendEngineV1) => PluginDisposable | unknown;
  registerMcpDiscoveryProvider: (
    registration: PluginApiMcpDiscoveryProviderRegistrationV1,
  ) => PluginDisposable | unknown;
}>;

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

function toOpenCodeMcpServerSpec(server: Awaited<ReturnType<typeof detectOpenCodeMcpServers>>['servers'][number]): McpServerSpecV1 | null {
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

export function activate(api: PluginApiForOpenCodeV1): void {
  api.registerBackendEngine({
    backendId: 'opencode',
    create: async (ctx) => {
      ctx.logger.info('[plugins/opencode] Creating backend engine');
      return createOpenCodeBackendEngine(ctx);
    },
  });
  api.registerMcpDiscoveryProvider({
    id: 'opencode.config',
    discover: async (input) => {
      const detected = await detectOpenCodeMcpServers({
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
