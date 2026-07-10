import {
  toPluginHookObjectContext,
  toPluginHookPayloadEnvelope,
} from '@happier-dev/plugin-sdk';
import type {
  PluginApi,
  McpServerSpecV1,
  PluginApiHookRegistrationV1,
  PluginHookHandler,
  RegisterDaemonAuthBridgeV1,
} from '@happier-dev/plugin-sdk';

import { readClaudeMcpConfigServers } from './agent/mcp/configServers.js';
import { createClaudeBackendEngine } from './agent/runtime/engine.js';
import {
  augmentClaudeDaemonSpawnEnv,
  resolveClaudeDaemonSpawnPrerequisites,
} from './agent/lifecycle/spawnHooks.js';
import { PLUGIN_MANIFEST } from './manifest.js';

type ClaudeSpawnPrerequisiteHookEvent = Parameters<typeof resolveClaudeDaemonSpawnPrerequisites>[0];
type ClaudeSpawnPrerequisiteHookContext = NonNullable<Parameters<typeof resolveClaudeDaemonSpawnPrerequisites>[1]>;
type ClaudeSpawnEnvHookEvent = Parameters<typeof augmentClaudeDaemonSpawnEnv>[0];

const resolveClaudeDaemonSpawnPrerequisitesHook: PluginHookHandler = (event, context) =>
  resolveClaudeDaemonSpawnPrerequisites(
    toPluginHookPayloadEnvelope<ClaudeSpawnPrerequisiteHookEvent>(event),
    toPluginHookObjectContext<ClaudeSpawnPrerequisiteHookContext>(context),
  );

const augmentClaudeDaemonSpawnEnvHook: PluginHookHandler = (event) =>
  augmentClaudeDaemonSpawnEnv(toPluginHookPayloadEnvelope<ClaudeSpawnEnvHookEvent>(event));

const refreshClaudeDaemonAuthBridge: RegisterDaemonAuthBridgeV1['refresh'] = async () => {
  throw new Error('claude-subscription daemon auth bridge is unavailable until the daemon binds registered bridges');
};

function toRedactedEnvKeys(envKeys: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (envKeys.length === 0) return undefined;
  return Object.freeze(Object.fromEntries(envKeys.map((key) => [key, ''])));
}

function toClaudeMcpServerSpec(
  server: Awaited<ReturnType<typeof readClaudeMcpConfigServers>>['servers'][number],
): McpServerSpecV1 | null {
  if (server.transport === 'stdio' && server.stdio) {
    return {
      id: `claude.config.${server.name}`,
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
  if ((server.transport === 'http' || server.transport === 'sse') && server.remote) {
    return {
      id: `claude.config.${server.name}`,
      name: server.name,
      transport: {
        kind: server.transport,
        url: server.remote.url,
      },
    };
  }
  return null;
}

function readClaudeConfigDiscoveryProvider(): typeof PLUGIN_MANIFEST.contributes.mcp.discoveryProviders[number] {
  const provider = PLUGIN_MANIFEST.contributes.mcp.discoveryProviders.find((entry) => entry.id === 'claude.config');
  if (!provider) {
    throw new Error('Claude plugin manifest must declare claude.config MCP discovery provider');
  }
  return provider;
}

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'claude',
    create: async (ctx) => {
      ctx.logger.debug('[plugins/claude] Creating backend engine');
      return createClaudeBackendEngine(ctx);
    },
  });
  api.registerDaemonAuthBridge({
    serviceId: 'claude-subscription',
    refresh: refreshClaudeDaemonAuthBridge,
  });
  api.registerHook({
    hookId: 'agent.resolvePrerequisites',
    category: 'decision',
    scope: 'agent',
    filters: { agentId: 'claude' },
    executionKind: 'decide',
    handler: resolveClaudeDaemonSpawnPrerequisitesHook,
  });
  api.registerHook({
    hookId: 'agent.spawnEnv.augment',
    category: 'augmentation',
    scope: 'daemon',
    filters: { agentId: 'claude' },
    executionKind: 'augment',
    handler: augmentClaudeDaemonSpawnEnvHook,
  });
  const configDiscoveryProvider = readClaudeConfigDiscoveryProvider();
  api.registerMcpDiscoveryProvider({
    id: configDiscoveryProvider.id,
    discover: async (input) => {
      const detected = await readClaudeMcpConfigServers({
        directory: input?.directory ?? null,
      });
      return {
        servers: detected.servers
          .map(toClaudeMcpServerSpec)
          .filter((server): server is McpServerSpecV1 => server !== null),
        warnings: detected.warnings,
      };
    },
  });
}
