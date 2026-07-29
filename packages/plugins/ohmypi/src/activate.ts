import {
  toPluginHookObjectContext,
  toPluginHookPayloadEnvelope,
} from '@happier-dev/plugin-sdk/experimental/hooks';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/runtime';

import { resolveOhMyPiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createOhMyPiAgentRuntime } from './agent/runtime/engine.js';
import { ohMyPiExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';
import {
  ohMyPiExternalSessionObservationContribution,
} from './agent/surfaces/sessions/external/observation.js';
import {
  ohMyPiExternalSessionTakeoverContribution,
} from './agent/surfaces/sessions/external/semantics.js';

type OhMyPiSpawnPrerequisiteHookEvent = Parameters<typeof resolveOhMyPiDaemonSpawnPrerequisites>[0];
type OhMyPiSpawnPrerequisiteHookContext = NonNullable<Parameters<typeof resolveOhMyPiDaemonSpawnPrerequisites>[1]>;

const resolveOhMyPiDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveOhMyPiDaemonSpawnPrerequisites(
    toPluginHookPayloadEnvelope<OhMyPiSpawnPrerequisiteHookEvent>(event),
    toPluginHookObjectContext<OhMyPiSpawnPrerequisiteHookContext>(context),
  );

export function activate(api: PluginApi): void {
  api.agents.register('ohmypi', createOhMyPiAgentRuntime);
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
