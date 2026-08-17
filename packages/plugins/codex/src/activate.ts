import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  HookHandler,
} from '@happier-dev/plugin-sdk/hooks';

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

const resolveCodexDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveCodexDaemonSpawnPrerequisites(event, context);

const augmentCodexDaemonSpawnEnvHook: HookHandler = (event) =>
  augmentCodexDaemonSpawnEnv(event);

function readCodexConfigDiscoverySource(): typeof PLUGIN_MANIFEST.contributes.mcp.discoverySources[number] {
  const source = PLUGIN_MANIFEST.contributes.mcp.discoverySources.find((entry) => entry.id === 'config');
  if (!source) {
    throw new Error('Codex plugin manifest must declare codex.config MCP discovery source');
  }
  return source;
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
    {
      providerBinding: CODEX_PROVIDER_BINDING_ADAPTER_V1,
      sessionRunnerFactory: {
        module: './agent/runtime/engine',
        export: 'createCodexAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'codexExternalSessionsContribution',
      },
    },
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
  const configDiscoverySource = readCodexConfigDiscoverySource();
  api.mcp.registerDiscoverySource(configDiscoverySource.id, async () => {
      const detected = await readCodexMcpConfigServers({});
      return {
        items: [],
        endpoints: [],
        warnings: detected.warnings,
      };
  });
}
