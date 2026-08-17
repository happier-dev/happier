import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  McpDiscoveredEndpoint as PluginMcpDiscoveredEndpoint,
} from '@happier-dev/plugin-sdk/mcp';

import { readOpenCodeMcpConfigServers } from './agent/mcp/discovery.js';
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1 } from './agent/providerBinding/adapter.js';
import { createOpenCodeAgentRuntime } from './agent/runtime/nativeRuntime.js';
import { openCodeExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';
import { openCodeExternalSessionObservationContribution } from './agent/surfaces/sessions/external/observation.js';
import { openCodeExternalSessionTakeoverContribution } from './agent/surfaces/sessions/external/provider.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function normalizeOpenCodeMcpServerIdSegment(name: string): string | null {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return normalized.length > 0 ? normalized : null;
}

function toOpenCodeMcpEndpoint(server: Awaited<ReturnType<typeof readOpenCodeMcpConfigServers>>['servers'][number]): PluginMcpDiscoveredEndpoint | null {
  if (server.enabled === false) return null;
  const idSegment = normalizeOpenCodeMcpServerIdSegment(server.name);
  if (!idSegment) return null;
  const id = `opencode.config.${idSegment}`;
  if ((server.transport === 'http' || server.transport === 'sse') && server.remote?.url) {
    return {
      id,
      name: server.name,
      kind: server.transport,
      url: server.remote.url,
    };
  }
  return null;
}

function readOpenCodeConfigDiscoverySource(): typeof PLUGIN_MANIFEST.contributes.mcp.discoverySources[number] {
  const source = PLUGIN_MANIFEST.contributes.mcp.discoverySources.find((entry) => entry.id === 'config');
  if (!source) {
    throw new Error('OpenCode plugin manifest must declare opencode.config MCP discovery source');
  }
  return source;
}

export function activate(api: PluginApi): void {
  api.agents.register(
    'opencode',
    createOpenCodeAgentRuntime,
    {
      providerBinding: OPENCODE_PROVIDER_BINDING_ADAPTER_V1,
      sessionRunnerFactory: {
        module: './agent/runtime/nativeRuntime',
        export: 'createOpenCodeAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'openCodeExternalSessionsContribution',
      },
    },
  );
  api.agents.registerExternalSessions('opencode', openCodeExternalSessionsContribution);
  api.agents.registerExternalSessionTakeover(
    'opencode',
    openCodeExternalSessionTakeoverContribution,
  );
  api.agents.registerExternalSessionObservation(
    'opencode',
    openCodeExternalSessionObservationContribution,
  );
  const configDiscoverySource = readOpenCodeConfigDiscoverySource();
  api.mcp.registerDiscoverySource(configDiscoverySource.id, async (input) => {
      const detected = await readOpenCodeMcpConfigServers({
        directory: input?.directory ?? null,
      });
      const endpoints = detected.servers
        .map(toOpenCodeMcpEndpoint)
        .filter((endpoint): endpoint is PluginMcpDiscoveredEndpoint => endpoint !== null);
      const countsById = new Map<string, number>();
      for (const endpoint of endpoints) {
        countsById.set(endpoint.id, (countsById.get(endpoint.id) ?? 0) + 1);
      }
      return {
        items: [],
        endpoints: endpoints.filter((endpoint) => countsById.get(endpoint.id) === 1),
        warnings: detected.warnings,
      };
  });
}
