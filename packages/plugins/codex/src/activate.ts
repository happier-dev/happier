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

import { readCodexMcpConfigServers } from './agent/mcp/configServers.js';
import { createCodexBackendEngine } from './agent/engine/createCodexBackendEngine.js';
import {
  augmentCodexDaemonSpawnEnv,
  resolveCodexDaemonSpawnPrerequisites,
} from './agent/lifecycle/spawnHooks.js';
import { PLUGIN_MANIFEST } from './manifest.js';

type CodexSpawnPrerequisiteHookEvent = Parameters<typeof resolveCodexDaemonSpawnPrerequisites>[0];
type CodexSpawnPrerequisiteHookContext = NonNullable<Parameters<typeof resolveCodexDaemonSpawnPrerequisites>[1]>;
type CodexSpawnEnvHookEvent = Parameters<typeof augmentCodexDaemonSpawnEnv>[0];

const resolveCodexDaemonSpawnPrerequisitesHook: PluginHookHandler = (event, context) =>
  resolveCodexDaemonSpawnPrerequisites(
    toPluginHookPayloadEnvelope<CodexSpawnPrerequisiteHookEvent>(event),
    toPluginHookObjectContext<CodexSpawnPrerequisiteHookContext>(context),
  );

const augmentCodexDaemonSpawnEnvHook: PluginHookHandler = (event) =>
  augmentCodexDaemonSpawnEnv(toPluginHookPayloadEnvelope<CodexSpawnEnvHookEvent>(event));

const refreshCodexDaemonAuthBridge: RegisterDaemonAuthBridgeV1['refresh'] = async () => {
  throw new Error('openai-codex daemon auth bridge is unavailable until the daemon binds registered bridges');
};

function toCodexMcpServerSpec(
  server: Awaited<ReturnType<typeof readCodexMcpConfigServers>>['servers'][number],
): McpServerSpecV1 | null {
  if (server.enabled === false) return null;
  if (server.transport !== 'stdio' || !server.stdio) return null;
  return {
    id: `codex.config.${server.name}`,
    name: server.name,
    transport: {
      kind: 'stdio',
      launch: {
        kind: 'binary',
        executablePath: server.stdio.command,
        args: server.stdio.args,
      },
    },
  };
}

function readCodexConfigDiscoveryProvider(): typeof PLUGIN_MANIFEST.contributes.mcp.discoveryProviders[number] {
  const provider = PLUGIN_MANIFEST.contributes.mcp.discoveryProviders.find((entry) => entry.id === 'codex.config');
  if (!provider) {
    throw new Error('Codex plugin manifest must declare codex.config MCP discovery provider');
  }
  return provider;
}

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'codex',
    create: createCodexBackendEngine,
  });
  api.registerDaemonAuthBridge({
    serviceId: 'openai-codex',
    refresh: refreshCodexDaemonAuthBridge,
  });
  api.registerHook({
    hookId: 'agent.resolvePrerequisites',
    category: 'decision',
    scope: 'agent',
    filters: { agentId: 'codex' },
    executionKind: 'decide',
    handler: resolveCodexDaemonSpawnPrerequisitesHook,
  });
  api.registerHook({
    hookId: 'agent.spawnEnv.augment',
    category: 'augmentation',
    scope: 'daemon',
    filters: { agentId: 'codex' },
    executionKind: 'augment',
    handler: augmentCodexDaemonSpawnEnvHook,
  });
  const configDiscoveryProvider = readCodexConfigDiscoveryProvider();
  api.registerMcpDiscoveryProvider({
    id: configDiscoveryProvider.id,
    discover: async () => {
      const detected = await readCodexMcpConfigServers({});
      return {
        servers: detected.servers
          .map(toCodexMcpServerSpec)
          .filter((server): server is McpServerSpecV1 => server !== null),
        warnings: detected.warnings,
      };
    },
  });
}
