import {
  toPluginHookObjectContext,
  toPluginHookPayloadEnvelope,
} from '@happier-dev/plugin-sdk';
import type {
  PluginApi,
  PluginApiHookRegistrationV1,
  PluginContextV1,
  PluginHookHandler,
} from '@happier-dev/plugin-sdk';

import { resolveOhMyPiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createOhMyPiBackendEngine } from './agent/runtime/engine.js';

type OhMyPiSpawnPrerequisiteHookEvent = Parameters<typeof resolveOhMyPiDaemonSpawnPrerequisites>[0];
type OhMyPiSpawnPrerequisiteHookContext = NonNullable<Parameters<typeof resolveOhMyPiDaemonSpawnPrerequisites>[1]>;

const resolveOhMyPiDaemonSpawnPrerequisitesHook: PluginHookHandler = (event, context) =>
  resolveOhMyPiDaemonSpawnPrerequisites(
    toPluginHookPayloadEnvelope<OhMyPiSpawnPrerequisiteHookEvent>(event),
    toPluginHookObjectContext<OhMyPiSpawnPrerequisiteHookContext>(context),
  );

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'ohMyPi',
    create: (ctx: PluginContextV1) => createOhMyPiBackendEngine(ctx),
  });
  api.registerHook({
    hookId: 'agent.resolvePrerequisites',
    category: 'decision',
    scope: 'agent',
    filters: { agentId: 'ohMyPi' },
    executionKind: 'decide',
    handler: resolveOhMyPiDaemonSpawnPrerequisitesHook,
  });
}
