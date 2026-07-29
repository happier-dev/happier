import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  HookHandler,
  PluginMcpDiscoveryResult,
} from '@happier-dev/plugin-sdk/runtime';

import { readClaudeMcpConfigServers } from './agent/mcp/configServers.js';
import { CLAUDE_PROVIDER_BINDING_ADAPTER_V1 } from './agent/providerBinding/adapter.js';
import { createClaudeAgentRuntime } from './agent/runtime/nativeRuntime.js';
import { claudeExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';
import { claudeExternalSessionHooksContribution } from './agent/surfaces/sessions/external/hooks.js';
import { claudeExternalSessionObservationContribution } from './agent/surfaces/sessions/external/observation.js';
import { claudeExternalSessionTakeoverContribution } from './agent/surfaces/sessions/external/takeover.js';
import {
  augmentClaudeDaemonSpawnEnv,
  resolveClaudeDaemonSpawnPrerequisites,
} from './agent/lifecycle/spawnHooks.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { anthropicConnectedAccountRuntime } from './connectedAccounts/anthropicRuntime.js';
import {
  claudeSubscriptionConnectedAccountRuntime,
} from './connectedAccounts/claudeSubscriptionRuntime.js';

type ClaudeMcpServerSpec = NonNullable<PluginMcpDiscoveryResult['servers']>[number];

const resolveClaudeDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveClaudeDaemonSpawnPrerequisites(event, context);

const augmentClaudeDaemonSpawnEnvHook: HookHandler = (event) =>
  augmentClaudeDaemonSpawnEnv(event);

function toRedactedEnvKeys(envKeys: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (envKeys.length === 0) return undefined;
  return Object.freeze(Object.fromEntries(envKeys.map((key) => [key, ''])));
}

function toClaudeMcpServerSpec(
  server: Awaited<ReturnType<typeof readClaudeMcpConfigServers>>['servers'][number],
): ClaudeMcpServerSpec | null {
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
  const provider = PLUGIN_MANIFEST.contributes.mcp.discoveryProviders.find((entry) => entry.id === 'config');
  if (!provider) {
    throw new Error('Claude plugin manifest must declare claude.config MCP discovery provider');
  }
  return provider;
}

export function activate(api: PluginApi): void {
  const claudeSubscriptionDescriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(
    ({ id }) => id === 'claude-subscription',
  );
  if (!claudeSubscriptionDescriptor) {
    throw new Error('Claude plugin manifest must declare the Claude Subscription Connected Account');
  }
  const anthropicDescriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(
    ({ id }) => id === 'anthropic',
  );
  if (!anthropicDescriptor) {
    throw new Error('Claude plugin manifest must declare the Anthropic Connected Account');
  }
  api.connectedAccounts.register(anthropicDescriptor.id, anthropicConnectedAccountRuntime);
  api.connectedAccounts.register(
    claudeSubscriptionDescriptor.id,
    claudeSubscriptionConnectedAccountRuntime,
  );
  api.agents.register('claude', createClaudeAgentRuntime, {
    providerBinding: CLAUDE_PROVIDER_BINDING_ADAPTER_V1,
  });
  api.agents.registerExternalSessions('claude', claudeExternalSessionsContribution);
  api.agents.registerExternalSessionTakeover(
    'claude',
    claudeExternalSessionTakeoverContribution,
  );
  api.agents.registerExternalSessionHooks(
    'claude',
    claudeExternalSessionHooksContribution,
  );
  api.agents.registerExternalSessionObservation(
    'claude',
    claudeExternalSessionObservationContribution,
  );
  api.hooks.register('resolve-prerequisites', resolveClaudeDaemonSpawnPrerequisitesHook);
  api.hooks.register('augment-spawn-env', augmentClaudeDaemonSpawnEnvHook);
  const configDiscoveryProvider = readClaudeConfigDiscoveryProvider();
  api.mcp.registerDiscoveryProvider(configDiscoveryProvider.id, async (input) => {
      const detected = await readClaudeMcpConfigServers({
        directory: input?.directory ?? null,
      });
      return {
        items: [],
        servers: detected.servers
          .map(toClaudeMcpServerSpec)
          .filter((server): server is ClaudeMcpServerSpec => server !== null),
        warnings: detected.warnings,
      };
  });
}
