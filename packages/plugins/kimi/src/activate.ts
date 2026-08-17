import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { HookHandler,
} from '@happier-dev/plugin-sdk/hooks';

import { resolveKimiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createKimiAgentRuntime } from './agent/runtime/factory.js';

const resolveKimiDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveKimiDaemonSpawnPrerequisites(event, context);

export function activate(api: PluginApi): void {
  api.agents.register('kimi', createKimiAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/factory',
      export: 'createKimiAgentRuntime',
      runtimeApiVersion: 1,
    },
  });
  api.hooks.register('resolve-prerequisites', resolveKimiDaemonSpawnPrerequisitesHook);
}
