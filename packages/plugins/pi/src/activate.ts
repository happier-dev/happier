import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';

import { piExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { piExternalSessionObservationContribution } from './agent/externalSessions/observation.js';
import { resolvePiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createPiAgentRuntime } from './agent/runtime/engine.js';

const resolvePiDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolvePiDaemonSpawnPrerequisites(event, context);

export function activate(api: PluginApi): void {
  api.agents.register('pi', createPiAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/engine',
      export: 'createPiAgentRuntime',
      runtimeApiVersion: 1,
      externalSessionsExport: 'piExternalSessionsContribution',
    },
  });
  api.agents.registerExternalSessions('pi', piExternalSessionsContribution);
  api.agents.registerExternalSessionObservation(
    'pi',
    piExternalSessionObservationContribution,
  );
  api.hooks.register('resolve-prerequisites', resolvePiDaemonSpawnPrerequisitesHook);
}
