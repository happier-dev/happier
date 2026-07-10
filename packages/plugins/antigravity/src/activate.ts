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

import { ANTIGRAVITY_BACKEND_ID } from './agent/install/cliRuntime.js';
import { resolveAntigravityDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createAntigravityBackendEngine } from './agent/runtime/engine.js';
import { createAntigravityTerminalRuntimeSurface } from './agent/terminal/runtime.js';

type AntigravitySpawnPrerequisiteHookEvent = Parameters<typeof resolveAntigravityDaemonSpawnPrerequisites>[0];
type AntigravitySpawnPrerequisiteHookContext = NonNullable<Parameters<typeof resolveAntigravityDaemonSpawnPrerequisites>[1]>;

const resolveAntigravityDaemonSpawnPrerequisitesHook: PluginHookHandler = (event, context) =>
  resolveAntigravityDaemonSpawnPrerequisites(
    toPluginHookPayloadEnvelope<AntigravitySpawnPrerequisiteHookEvent>(event),
    toPluginHookObjectContext<AntigravitySpawnPrerequisiteHookContext>(context),
  );

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: ANTIGRAVITY_BACKEND_ID,
    create: (ctx: PluginContextV1) => ({
      ...createAntigravityBackendEngine(ctx),
      terminalRuntimeSurface: createAntigravityTerminalRuntimeSurface(),
    }),
  });
  api.registerHook({
    hookId: 'agent.resolvePrerequisites',
    category: 'decision',
    scope: 'agent',
    filters: { agentId: ANTIGRAVITY_BACKEND_ID },
    executionKind: 'decide',
    handler: resolveAntigravityDaemonSpawnPrerequisitesHook,
  });
}
