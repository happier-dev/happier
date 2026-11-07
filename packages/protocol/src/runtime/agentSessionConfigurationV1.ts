import * as zMini from 'zod/mini';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { withStrictJsonInput } from '../json/strictJsonValue.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { AgentSessionProviderBindingV1Schema, type AgentSessionProviderBindingV1 } from '../providers/sessions/agentSessionProviderBindingV1.js';
import { McpToolLaunchPoliciesV1Schema, type McpToolLaunchPolicyV1 } from '../mcp/servers/tools/resolveMcpToolDecisionV1.js';
import { AgentPermissionIntentV1Schema, AgentSessionToolPolicyShapeV1 } from './permissionIntentV1.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from './agentSessionLimitsV1.js';
import { exactString, ProviderIdSchema, SafeIntegerSchema } from './agentSessionScalarsV1.js';

// Creation provenance consumes configuration without the runtime event graph.
const TimestampedAgentValueV1Schema = <ValueSchema extends z.core.SomeType>(
  value: ValueSchema,
) => z.strictObject({
  value,
  updatedAtMs: SafeIntegerSchema,
});

const AgentConfigurationScalarV1Schema = lazyZodSchema(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]));
export const AgentSessionProviderResumeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('provider_session.v1'),
  providerSessionId: ProviderIdSchema,
}));
export type AgentSessionProviderResumeV1 = z.infer<typeof AgentSessionProviderResumeV1Schema>;


const AgentSessionConfigurationSnapshotCoreV1Schema = lazyZodSchema(() => z.strictObject({
  ...AgentSessionToolPolicyShapeV1,
  mode: TimestampedAgentValueV1Schema(z.nullable(exactString(LIMITS.modelIdMaxCodeUnits))),
  model: z.strictObject({
    ...TimestampedAgentValueV1Schema(z.nullable(exactString(LIMITS.modelIdMaxCodeUnits))).shape,
    selectionSource: z.optional(z.enum(['explicit', 'inherited'])),
  }),
  permissionIntent: TimestampedAgentValueV1Schema(zMini.nullable(asProtocolZod(AgentPermissionIntentV1Schema))),
  /** Host role restriction; independent of the permission intent used as delegation ceiling. */
  workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
  options: z.record(
    exactString(LIMITS.hostIndexedIdMaxCodeUnits),
    TimestampedAgentValueV1Schema(AgentConfigurationScalarV1Schema),
  ),
  /** Stable provider-owned continuation identity; never an opaque credential payload. */
  providerSessionResume: z.optional(AgentSessionProviderResumeV1Schema),
}));

export const AgentSessionConfigurationSnapshotV1Schema = lazyZodSchema(() => withStrictJsonInput(AgentSessionConfigurationSnapshotCoreV1Schema));

export type AgentSessionConfigurationUpdateV1 = z.infer<
  typeof AgentSessionConfigurationSnapshotV1Schema
> & Readonly<{
  providerBinding?: AgentSessionProviderBindingV1;
  mcpToolPolicy?: Readonly<Record<string, McpToolLaunchPolicyV1>>;
}>;
export const AgentSessionConfigurationUpdateV1Schema =
  withStrictJsonInput(lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSessionConfigurationSnapshotCoreV1Schema, {
      providerBinding: zMini.optional(AgentSessionProviderBindingV1Schema),
      mcpToolPolicy: zMini.optional(McpToolLaunchPoliciesV1Schema),
    })))) as z.ZodMiniType<AgentSessionConfigurationUpdateV1, AgentSessionConfigurationUpdateV1>;

export type AgentSessionConfigurationSnapshotV1 = z.infer<typeof AgentSessionConfigurationSnapshotV1Schema>;
export type AgentConfigurationScalarV1 = z.infer<typeof AgentConfigurationScalarV1Schema>;
