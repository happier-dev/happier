import {
  toPluginHookObjectContext,
  toPluginHookPayloadEnvelope,
} from '@happier-dev/plugin-sdk';
import type {
  PluginApiHookRegistrationV1,
  PluginApi,
  PluginContextV1,
  PluginHookHandler,
} from '@happier-dev/plugin-sdk';

import { KIMI_ACP_BACKEND_SPEC } from './agent/acp/definition.js';
import { resolveKimiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';

type KimiSpawnPrerequisiteHookEvent = Parameters<typeof resolveKimiDaemonSpawnPrerequisites>[0];
type KimiSpawnPrerequisiteHookContext = NonNullable<Parameters<typeof resolveKimiDaemonSpawnPrerequisites>[1]>;

const resolveKimiDaemonSpawnPrerequisitesHook: PluginHookHandler<'agent.resolvePrerequisites'> = (event, context) =>
  resolveKimiDaemonSpawnPrerequisites(
    toPluginHookPayloadEnvelope<KimiSpawnPrerequisiteHookEvent>(event),
    toPluginHookObjectContext<KimiSpawnPrerequisiteHookContext>(context),
  );

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'kimi',
    create: (ctx: PluginContextV1) => ctx.agentRuntime.acp.defineAcpBackend(KIMI_ACP_BACKEND_SPEC),
  });
  api.registerHook({
    hookId: 'agent.resolvePrerequisites',
    category: 'decision',
    scope: 'agent',
    filters: { agentId: 'kimi' },
    executionKind: 'decide',
    handler: resolveKimiDaemonSpawnPrerequisitesHook,
  } satisfies PluginApiHookRegistrationV1<'agent.resolvePrerequisites'>);
}
