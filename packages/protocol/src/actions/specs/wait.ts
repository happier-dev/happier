import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import type { ActionCliProjection } from '../actionCliProjection.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';

const Id = z.string().check(z.trim(), z.minLength(1));
export const WaitTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('execution_run'), serverId: Id, machineId: Id, sessionId: z.optional(Id), runId: Id }),
  z.strictObject({ kind: z.literal('action_operation'), serverId: Id, machineId: Id, operationId: Id }),
  z.strictObject({ kind: z.literal('session'), serverId: Id, sessionId: Id }),
  z.strictObject({ kind: z.literal('workflow_run'), serverId: Id, runId: Id }),
  z.strictObject({ kind: z.literal('plugin_source'), serverId: Id, pluginId: asProtocolZod(PluginIdSchema), sourceId: Id }),
]));
export const WaitConditionV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.enum(['terminal', 'needs_attention', 'terminal_or_needs_attention', 'idle', 'ready']) }),
  z.strictObject({ kind: z.literal('turn_terminal'), turnId: Id }),
  // Discover the exact admitted Action; never derive a local id from a plugin id.
  z.strictObject({ kind: z.literal('plugin'), actionLocalId: asProtocolZod(PluginContributionLocalIdSchema), condition: Id }),
]));
export const WaitActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  target: WaitTargetV1Schema,
  condition: WaitConditionV1Schema,
  timeout: z.optional(z.strictObject({ durationMs: z.number().check(z.int(), z.positive(), z.int()) })),
}));
export const WaitDispositionV1Schema = lazyZodSchema(() => z.enum([
  'matched', 'observation_timeout', 'cancelled', 'target_unavailable',
  'permission_denied', 'unsupported_condition', 'disconnected',
  'outcome_uncertain',
]));
export const WaitActionResultV1Schema = lazyZodSchema(() => z.strictObject({
  target: WaitTargetV1Schema,
  condition: WaitConditionV1Schema,
  disposition: WaitDispositionV1Schema,
  snapshot: z.optional(StrictJsonValueSchema),
}));
export const WaitOwnerResultV1Schema = lazyZodSchema(() => z.omit(WaitActionResultV1Schema, { target: true, condition: true }));
export type WaitTargetV1 = z.infer<typeof WaitTargetV1Schema>;
export type WaitConditionV1 = z.infer<typeof WaitConditionV1Schema>;
export type WaitActionInputV1 = z.infer<typeof WaitActionInputV1Schema>;
export type WaitActionResultV1 = z.infer<typeof WaitActionResultV1Schema>;
export type WaitOwnerResultV1 = Pick<WaitActionResultV1, 'disposition' | 'snapshot'>;

export const WAIT_CLI_PROJECTION = {
  commands: [{ path: ['wait'], observation: 'condition', visibility: 'canonical' },
    { path: ['watch'], observation: 'changes', visibility: 'canonical' }],
  acceptsServerId: true,
  requiresServerId: true,
} satisfies ActionCliProjection;


function createWaitActionSpecs() {
  return Object.freeze([
  {
    id: 'wait', approval: {result: 'required'},
    title: 'Wait for work',
    description: 'Observe an existing Home-qualified handle without polling or stopping its work. Prefer notifyParentOnCompletion or Follow for parent delivery. Reuse the same handle after an observation timeout.',
    sideEffectClass: 'read',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    bindings: { mcpToolName: 'wait' },
    surfaces: { ui: false, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: WAIT_CLI_PROJECTION,
    inputSchema: WaitActionInputV1Schema,
    outputSchema: WaitActionResultV1Schema,
    inputHints: { fields: [
      { path: 'target', title: 'Home-qualified work handle', widget: 'json', required: true },
      { path: 'condition', title: 'Observation condition', widget: 'json', required: true },
      { path: 'timeout.durationMs', title: 'Observation timeout in milliseconds', widget: 'text' },
    ] },
  } satisfies PreNormalizedActionSpec,
] as const);
}

export const WAIT_ACTION_SPECS: ReturnType<typeof createWaitActionSpecs> = lazyActionSpecArray(createWaitActionSpecs);

