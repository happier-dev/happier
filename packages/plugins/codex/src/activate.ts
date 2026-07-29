import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  HookHandler,
  PluginMcpDiscoveryResult,
} from '@happier-dev/plugin-sdk/runtime';

import { readCodexMcpConfigServers } from './agent/mcp/configServers.js';
import { CODEX_PROVIDER_BINDING_ADAPTER_V1 } from './agent/providerBinding/adapter.js';
import { createCodexAgentRuntime } from './agent/runtime/engine.js';
import { codexExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';
import { codexExternalSessionHooksContribution } from './agent/surfaces/sessions/external/externalSessionHooks.js';
import { codexExternalSessionObservationContribution } from './agent/surfaces/sessions/external/observation.js';
import { codexExternalSessionTakeoverContribution } from './agent/surfaces/sessions/external/takeover.js';
import {
  augmentCodexDaemonSpawnEnv,
  resolveCodexDaemonSpawnPrerequisites,
} from './agent/lifecycle/spawnHooks.js';
import { openAiCodexConnectedAccountRuntime } from './connectedAccounts/openAiCodexRuntime.js';
import { PLUGIN_MANIFEST } from './manifest.js';

type CodexMcpServerSpec = NonNullable<PluginMcpDiscoveryResult['servers']>[number];

const resolveCodexDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveCodexDaemonSpawnPrerequisites(event, context);

const augmentCodexDaemonSpawnEnvHook: HookHandler = (event) =>
  augmentCodexDaemonSpawnEnv(event);

function toCodexMcpServerSpec(
  server: Awaited<ReturnType<typeof readCodexMcpConfigServers>>['servers'][number],
): CodexMcpServerSpec | null {
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
  const provider = PLUGIN_MANIFEST.contributes.mcp.discoveryProviders.find((entry) => entry.id === 'config');
  if (!provider) {
    throw new Error('Codex plugin manifest must declare codex.config MCP discovery provider');
  }
  return provider;
}

export function activate(api: PluginApi): void {
  const connectedAccountDescriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(
    ({ id }) => id === 'openai-codex',
  );
  if (!connectedAccountDescriptor) {
    throw new Error('Codex plugin manifest must declare the OpenAI Codex Connected Account');
  }
  api.connectedAccounts.register(
    connectedAccountDescriptor.id,
    openAiCodexConnectedAccountRuntime,
  );
  api.agents.register(
    'codex',
    createCodexAgentRuntime,
    { providerBinding: CODEX_PROVIDER_BINDING_ADAPTER_V1 },
  );
  api.agents.registerExternalSessions('codex', codexExternalSessionsContribution);
  api.agents.registerExternalSessionTakeover(
    'codex',
    codexExternalSessionTakeoverContribution,
  );
  api.agents.registerExternalSessionHooks('codex', codexExternalSessionHooksContribution);
  api.agents.registerExternalSessionObservation(
    'codex',
    codexExternalSessionObservationContribution,
  );
  api.hooks.register('resolve-prerequisites', resolveCodexDaemonSpawnPrerequisitesHook);
  api.hooks.register('augment-spawn-env', augmentCodexDaemonSpawnEnvHook);
  const configDiscoveryProvider = readCodexConfigDiscoveryProvider();
  api.mcp.registerDiscoveryProvider(configDiscoveryProvider.id, async () => {
      const detected = await readCodexMcpConfigServers({});
      return {
        items: [],
        servers: detected.servers
          .map(toCodexMcpServerSpec)
          .filter((server): server is CodexMcpServerSpec => server !== null),
        warnings: detected.warnings,
      };
  });
}
