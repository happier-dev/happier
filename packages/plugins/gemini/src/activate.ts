import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';

import { resolveGeminiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createGeminiAgentRuntime } from './agent/runtime/factory.js';
import { geminiConnectedAccountRuntime } from './connectedAccounts/runtime.js';

const resolveGeminiDaemonSpawnPrerequisitesHook: HookHandler =
  (event, context) =>
    resolveGeminiDaemonSpawnPrerequisites(event, context);

export function activate(api: PluginApi): void {
  api.connectedAccounts.register(
    'gemini-account',
    geminiConnectedAccountRuntime,
  );
  api.agents.register('gemini', createGeminiAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/factory',
      export: 'createGeminiAgentRuntime',
      runtimeApiVersion: 1,
    },
  });
  api.hooks.register(
    'resolve-prerequisites',
    resolveGeminiDaemonSpawnPrerequisitesHook,
  );
}
