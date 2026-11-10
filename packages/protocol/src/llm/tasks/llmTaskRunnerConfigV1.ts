import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { BackendTargetRefSchema } from '../../backends/targets/backendTargetRef.js';
import { readBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { ConnectedServiceBindingsV2Schema } from '../../connect/connectedServiceBindings.js';
import { AcpConfigOptionOverridesV1Schema } from '../../sessions/metadata/metadataOverridesV1.js';

export const LlmTaskPermissionModeSchema = lazyZodSchema(() => z.enum([
  'no_tools',
  'read_only',
  'workspace_write',
  'full',
]));
export type LlmTaskPermissionMode = z.infer<typeof LlmTaskPermissionModeSchema>;

/**
 * One explicit runner choice: Agent + model (native or through a Provider
 * connection), the Agent's connected-service route, its config options such as
 * effort, and the permission level.
 */
export const LlmTaskRunnerConfigV1WriteSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    modelSelection: ProviderBoundModelRefSchema,
    /** Absent: the Account's default route for that Agent. Null: the machine's own sign-in. */
    connectedServices: z.optional(z.nullable(ConnectedServiceBindingsV2Schema)),
    sessionConfigOptionOverrides: z.optional(AcpConfigOptionOverridesV1Schema),
    permissionMode: z.optional(LlmTaskPermissionModeSchema),
  }));

const StoredRunnerSchema = createStoredReadSchema(LlmTaskRunnerConfigV1WriteSchema);
const StoredPredecessorTargetSchema = createStoredReadSchema(BackendTargetRefSchema);
/** Forward reader for the real 0.2 runner setting; writers emit only modelSelection. */
export const LlmTaskRunnerConfigV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'modelSelection')) return record;
  const target = StoredPredecessorTargetSchema.safeParse(record.backendTarget);
  if (!target.success) return value;
  const agentTargetKey = readBackendTargetKeyV2(target.data);
  if (!agentTargetKey) return value;
  return { v: record.v, modelSelection: {
    agentTargetKey,
    providerConnectionId: null,
    modelId: record.modelId === undefined ? 'default' : typeof record.modelId === 'string' ? record.modelId.trim() : record.modelId,
  }, ...(record.permissionMode === undefined ? {} : { permissionMode: record.permissionMode }) };
}), StoredRunnerSchema));

export type LlmTaskRunnerConfigV1 = z.infer<typeof LlmTaskRunnerConfigV1Schema>;

/** The person chose Auto: the task owner picks among what is ready on the executing machine. */
export const LlmTaskRunnerAutoV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  mode: z.literal('auto'),
  /** The person's effort for this task; absent: the picked model's lowest effort. */
  sessionConfigOptionOverrides: z.optional(AcpConfigOptionOverridesV1Schema),
  permissionMode: z.optional(LlmTaskPermissionModeSchema),
}));
export type LlmTaskRunnerAutoV1 = z.infer<typeof LlmTaskRunnerAutoV1Schema>;

/** A per-task runner setting: Auto, or one explicit runner. */
export const LlmTaskRunnerChoiceV1Schema = lazyZodSchema(() => z.union([
  createStoredReadSchema(LlmTaskRunnerAutoV1Schema),
  LlmTaskRunnerConfigV1Schema,
]));
export type LlmTaskRunnerChoiceV1 = z.infer<typeof LlmTaskRunnerChoiceV1Schema>;

export function isLlmTaskRunnerAutoV1(choice: LlmTaskRunnerChoiceV1 | null | undefined): choice is LlmTaskRunnerAutoV1 | null | undefined {
  return !choice || 'mode' in choice;
}
