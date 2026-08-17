import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';

import { resolveOhMyPiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createOhMyPiAgentRuntime } from './agent/runtime/engine.js';
import { ohMyPiExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';
import {
  ohMyPiExternalSessionObservationContribution,
} from './agent/surfaces/sessions/external/observation.js';
import {
  ohMyPiExternalSessionTakeoverContribution,
} from './agent/surfaces/sessions/external/semantics.js';

const resolveOhMyPiDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveOhMyPiDaemonSpawnPrerequisites(event, context);

export function activate(api: PluginApi): void {
  api.agents.register('ohmypi', createOhMyPiAgentRuntime, {
    sessionRunnerFactory: {
      module: './agent/runtime/engine',
      export: 'createOhMyPiAgentRuntime',
      runtimeApiVersion: 1,
      externalSessionsExport: 'ohMyPiExternalSessionsContribution',
    },
  });
  api.agents.registerExternalSessions('ohmypi', ohMyPiExternalSessionsContribution);
  api.agents.registerExternalSessionTakeover(
    'ohmypi',
    ohMyPiExternalSessionTakeoverContribution,
  );
  api.agents.registerExternalSessionObservation(
    'ohmypi',
    ohMyPiExternalSessionObservationContribution,
  );
  api.hooks.register('resolve-prerequisites', resolveOhMyPiDaemonSpawnPrerequisitesHook);
}
