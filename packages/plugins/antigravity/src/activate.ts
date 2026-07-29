import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/runtime';

import { antigravityExternalSessionsContribution } from './agent/cliPrint/externalSessions.js';
import { antigravityExternalSessionObservationContribution } from './agent/cliPrint/observation.js';
import { ANTIGRAVITY_BACKEND_ID } from './agent/install/cliRuntime.js';
import { resolveAntigravityDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createAntigravityNativeRuntime } from './agent/runtime/nativeRuntime.js';
import { createAntigravityNativeSessionRuntime } from './agent/runtime/nativeSession.js';

const resolveAntigravityDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveAntigravityDaemonSpawnPrerequisites(event, context);

export function activate(api: PluginApi): void {
  api.agents.register(ANTIGRAVITY_BACKEND_ID, () => createAntigravityNativeRuntime({
    openSession: createAntigravityNativeSessionRuntime,
  }));
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
