import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';

import { antigravityExternalSessionObservationContribution } from './agent/cliPrint/observation.js';
import { ANTIGRAVITY_BACKEND_ID } from './agent/install/cliRuntime.js';
import { resolveAntigravityDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import {
  antigravityExternalSessionsContribution,
  createAntigravityAgentRuntime,
} from './agent/runtime/factory.js';

const resolveAntigravityDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveAntigravityDaemonSpawnPrerequisites(event, context);

export function activate(api: PluginApi): void {
  api.agents.register(ANTIGRAVITY_BACKEND_ID, createAntigravityAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/factory',
      export: 'createAntigravityAgentRuntime',
      runtimeApiVersion: 1,
      externalSessionsExport: 'antigravityExternalSessionsContribution',
    },
  });
  api.agents.registerExternalSessions(
    ANTIGRAVITY_BACKEND_ID,
    antigravityExternalSessionsContribution,
  );
  api.agents.registerExternalSessionObservation(
    ANTIGRAVITY_BACKEND_ID,
    antigravityExternalSessionObservationContribution,
  );
  api.hooks.register('resolve-prerequisites', resolveAntigravityDaemonSpawnPrerequisitesHook);
}
