import { z } from 'zod';

import { BackendTargetKeySchema } from '../../backends/targets/backendTargetRef.js';
import { BackendTargetRefV2Schema } from '../../backends/targets/backendTargetRefV2.js';
import {
  ExecutionRunClassSchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunRetentionPolicySchema,
} from '../../execution/runs/startRequest.js';
import {
  HookCategoryV1Schema,
  type HookCategoryV1,
} from '../../hooks/hookCategories.js';
import {
  HookExecutionKindV1Schema,
  type HookExecutionKindV1,
  resolveHookExecutionKindForCategoryV1,
} from '../../hooks/hookExecutionSemantics.js';
import { PluginJsonValueV2Schema } from '../contributions/publicTypes.js';

export const PLUGIN_HOOK_IDS_V1 = [
  'session.spawned',
  'session.message.send',
  'session.input.transform',
  'executionRun.started',
  'executionRun.messageSent',
  'executionRun.stopped',
  'executionRun.completed',
  'agent.resolvePrerequisites',
  'agent.spawnEnv.augment',
  'agent.context.before',
  'agent.request.before',
  'agent.stream.token',
] as const;
export const PluginHookIdV1Schema = z.enum(PLUGIN_HOOK_IDS_V1);
export type PluginHookIdV1 = z.infer<typeof PluginHookIdV1Schema>;

export const PluginHookScopeV1Schema = z.enum([
  'machine',
  'project',
  'session',
  'agent',
  'daemon',
  'tool',
  'resource',
  'plugin',
]);
export type PluginHookScopeV1 = z.infer<typeof PluginHookScopeV1Schema>;

export const PluginHookAggregationKindV1Schema = z.enum([
  'none',
  'orderedList',
  'mergeObject',
  'firstDecision',
  'allDecisions',
  'replace',
]);
export type PluginHookAggregationKindV1 = z.infer<typeof PluginHookAggregationKindV1Schema>;

export const PluginHookFailureModeV1Schema = z.enum(['bestEffort', 'failClosed']);
export type PluginHookFailureModeV1 = z.infer<typeof PluginHookFailureModeV1Schema>;

export const PluginHookPurityV1Schema = z.enum(['observer', 'participant']);
export type PluginHookPurityV1 = z.infer<typeof PluginHookPurityV1Schema>;

export const PluginHookSupportedRuntimeFamilyV1Schema = z.enum([
  'hostSession',
  'acpSession',
  'pluginSession',
  'executionRun',
]);
export type PluginHookSupportedRuntimeFamilyV1 = z.infer<typeof PluginHookSupportedRuntimeFamilyV1Schema>;

export const PluginHookDecisionResultV1Schema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow') }).strict(),
  z.object({
    decision: z.literal('deny'),
    reasonCode: z.string().trim().min(1).max(256).optional(),
    errorMessage: z.string().trim().min(1).max(2_048).optional(),
  }).strict(),
  z.object({ decision: z.literal('abstain') }).strict(),
]);
export type PluginHookDecisionResultV1 = z.infer<typeof PluginHookDecisionResultV1Schema>;

const PluginHookAugmentationResultV1Schema = z.record(z.string(), PluginJsonValueV2Schema);

export const PluginHookDefinitionV1Schema = z.object({
  id: PluginHookIdV1Schema,
  category: HookCategoryV1Schema,
  scope: PluginHookScopeV1Schema,
  executionKind: HookExecutionKindV1Schema,
  aggregation: PluginHookAggregationKindV1Schema,
  failureMode: PluginHookFailureModeV1Schema,
  purity: PluginHookPurityV1Schema.optional(),
  supportedRuntimes: z.array(PluginHookSupportedRuntimeFamilyV1Schema).default([]),
  payloadSchema: z.record(z.string(), z.unknown()).default({}),
  resultSchema: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type PluginHookDefinitionV1 = z.infer<typeof PluginHookDefinitionV1Schema>;

const NonEmptyStringSchema = z.string().min(1);
const TimestampMsSchema = z.number().int().min(0);
export const SessionSpawnedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  agentId: NonEmptyStringSchema,
  runtimeTarget: BackendTargetRefV2Schema,
  modelId: NonEmptyStringSchema.optional(),
  cwd: z.string().optional(),
  initialMessage: z.string().optional(),
  tag: z.string().optional(),
  host: z.string().optional(),
  machineId: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const SessionMessageSendHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  text: z.string(),
  source: z.enum(['user', 'plugin', 'system']),
  turnId: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const SessionInputTransformHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  localId: NonEmptyStringSchema.optional(),
  text: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ExecutionRunStartedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  runId: NonEmptyStringSchema,
  intent: ExecutionRunIntentSchema,
  runtimeTargetKeys: z.array(BackendTargetKeySchema),
  permissionMode: z.string().optional(),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ExecutionRunMessageSentHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  runId: NonEmptyStringSchema,
  message: z.string(),
  resume: z.boolean().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ExecutionRunStoppedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  runId: NonEmptyStringSchema,
  reason: z.enum(['user', 'plugin', 'timeout', 'error']),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const ExecutionRunCompletedHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  runId: NonEmptyStringSchema,
  status: z.enum(['succeeded', 'failed', 'canceled']),
  errorCode: z.string().optional(),
  error: z.string().optional(),
  output: z.unknown().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AgentResolvePrerequisitesHookPayloadV1Schema = z.object({
  agentId: NonEmptyStringSchema,
  runtimeTarget: BackendTargetRefV2Schema,
  sessionId: NonEmptyStringSchema.optional(),
  cwd: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AgentSpawnEnvAugmentHookPayloadV1Schema = z.object({
  agentId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema.optional(),
  cwd: z.string().optional(),
  timestampMs: TimestampMsSchema,
}).passthrough();

const AgentMessageProjectionV1Schema = z.object({
  role: z.string().trim().min(1),
  content: z.unknown(),
}).passthrough();

export const AgentContextBeforeHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  agentId: NonEmptyStringSchema.optional(),
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  prompt: z.string(),
  messages: z.array(AgentMessageProjectionV1Schema),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AgentRequestBeforeHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema.optional(),
  agentId: NonEmptyStringSchema.optional(),
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  method: NonEmptyStringSchema,
  request: z.record(z.string(), z.unknown()),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const AgentStreamTokenHookPayloadV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  agentId: NonEmptyStringSchema.optional(),
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  turnId: NonEmptyStringSchema,
  tokenText: z.string(),
  streamKind: z.enum(['assistant', 'thinking', 'unknown']),
  timestampMs: TimestampMsSchema,
}).passthrough();

export const PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1 = Object.freeze({
  'session.spawned': SessionSpawnedHookPayloadV1Schema,
  'session.message.send': SessionMessageSendHookPayloadV1Schema,
  'session.input.transform': SessionInputTransformHookPayloadV1Schema,
  'executionRun.started': ExecutionRunStartedHookPayloadV1Schema,
  'executionRun.messageSent': ExecutionRunMessageSentHookPayloadV1Schema,
  'executionRun.stopped': ExecutionRunStoppedHookPayloadV1Schema,
  'executionRun.completed': ExecutionRunCompletedHookPayloadV1Schema,
  'agent.resolvePrerequisites': AgentResolvePrerequisitesHookPayloadV1Schema,
  'agent.spawnEnv.augment': AgentSpawnEnvAugmentHookPayloadV1Schema,
  'agent.context.before': AgentContextBeforeHookPayloadV1Schema,
  'agent.request.before': AgentRequestBeforeHookPayloadV1Schema,
  'agent.stream.token': AgentStreamTokenHookPayloadV1Schema,
} satisfies Readonly<Record<PluginHookIdV1, z.ZodType<unknown>>>);

export type PluginHookPayloadSchemaMapV1 = typeof PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1;
export type PluginHookPayloadMapV1 = Readonly<{
  [THookId in PluginHookIdV1]: z.infer<PluginHookPayloadSchemaMapV1[THookId]>;
}>;

export function validatePluginHookPayloadV1(params: Readonly<{
  hookId: string;
  payload: unknown;
}>): Readonly<
  | { success: true; payload: unknown }
  | { success: false; message: string }
> {
  const hookId = PluginHookIdV1Schema.safeParse(params.hookId);
  if (!hookId.success) {
    return {
      success: false,
      message: `Unsupported plugin hook id '${params.hookId}'`,
    };
  }
  const schema = PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1[hookId.data];
  const parsed = schema.safeParse(params.payload);
  if (parsed.success) {
    return {
      success: true,
      payload: parsed.data,
    };
  }
  return {
    success: false,
    message: `Invalid payload for plugin hook '${hookId.data}': ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
  };
}

export function validatePluginHookResultV1(params: Readonly<{
  hookId: string;
  result: unknown;
}>): Readonly<
  | { success: true; result: unknown }
  | { success: false; message: string }
> {
  const hookId = PluginHookIdV1Schema.safeParse(params.hookId);
  if (!hookId.success) {
    return {
      success: false,
      message: `Unsupported plugin hook id '${params.hookId}'`,
    };
  }
  const definition = getPluginHookDefinitionV1(hookId.data);
  if (!definition) {
    return {
      success: false,
      message: `Unsupported plugin hook id '${params.hookId}'`,
    };
  }

  if (definition.executionKind === 'decide') {
    const parsed = PluginHookDecisionResultV1Schema.safeParse(params.result);
    return parsed.success
      ? { success: true, result: parsed.data }
      : { success: false, message: `Invalid result for plugin hook '${hookId.data}': ${parsed.error.issues.map((issue) => issue.message).join('; ')}` };
  }

  if (definition.aggregation === 'replace') {
    if (typeof params.result === 'undefined') return { success: true, result: undefined };
    const jsonSafe = PluginJsonValueV2Schema.safeParse(params.result);
    if (!jsonSafe.success) {
      return {
        success: false,
        message: `Invalid result for plugin hook '${hookId.data}': replacement payload must be JSON-safe`,
      };
    }
    const schema = PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1[hookId.data];
    const parsed = schema.safeParse(jsonSafe.data);
    return parsed.success
      ? { success: true, result: parsed.data }
      : { success: false, message: `Invalid result for plugin hook '${hookId.data}': ${parsed.error.issues.map((issue) => issue.message).join('; ')}` };
  }

  if (definition.executionKind === 'augment') {
    if (typeof params.result === 'undefined') return { success: true, result: undefined };
    const parsed = PluginHookAugmentationResultV1Schema.safeParse(params.result);
    return parsed.success
      ? { success: true, result: parsed.data }
      : { success: false, message: `Invalid result for plugin hook '${hookId.data}': ${parsed.error.issues.map((issue) => issue.message).join('; ')}` };
  }

  if (typeof params.result === 'undefined') {
    return { success: true, result: undefined };
  }
  return {
    success: false,
    message: `Invalid result for plugin hook '${hookId.data}': observation hooks must not return a value`,
  };
}

function definePluginHookDefinitionV1(input: Readonly<{
  id: PluginHookIdV1;
  category: HookCategoryV1;
  scope: PluginHookScopeV1;
  aggregation: PluginHookAggregationKindV1;
  failureMode: PluginHookFailureModeV1;
  purity?: PluginHookPurityV1;
  supportedRuntimes?: readonly PluginHookSupportedRuntimeFamilyV1[];
  payloadSchema?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
}>): PluginHookDefinitionV1 {
  const executionKind = resolveHookExecutionKindForCategoryV1(input.category) as HookExecutionKindV1;
  return PluginHookDefinitionV1Schema.parse({
    ...input,
    executionKind,
    supportedRuntimes: input.supportedRuntimes ?? [],
    payloadSchema: input.payloadSchema ?? {},
    resultSchema: input.resultSchema ?? {},
  });
}

const lifecycle = (params: Readonly<{
  id: PluginHookIdV1;
  scope: PluginHookScopeV1;
  purity?: PluginHookPurityV1;
  supportedRuntimes?: readonly PluginHookSupportedRuntimeFamilyV1[];
}>): PluginHookDefinitionV1 => definePluginHookDefinitionV1({
  id: params.id,
  category: 'lifecycle',
  scope: params.scope,
  aggregation: 'orderedList',
  failureMode: 'bestEffort',
  ...(params.purity ? { purity: params.purity } : {}),
  ...(params.supportedRuntimes ? { supportedRuntimes: params.supportedRuntimes } : {}),
});

export const PLUGIN_HOOK_CATALOG_V1 = [
  lifecycle({ id: 'session.spawned', scope: 'session' }),
  lifecycle({ id: 'session.message.send', scope: 'session' }),
  definePluginHookDefinitionV1({
    id: 'session.input.transform',
    category: 'augmentation',
    scope: 'session',
    aggregation: 'replace',
    failureMode: 'bestEffort',
    supportedRuntimes: ['hostSession'],
  }),
  lifecycle({ id: 'executionRun.started', scope: 'session' }),
  lifecycle({ id: 'executionRun.messageSent', scope: 'session' }),
  lifecycle({ id: 'executionRun.stopped', scope: 'session' }),
  lifecycle({ id: 'executionRun.completed', scope: 'session' }),
  definePluginHookDefinitionV1({
    id: 'agent.resolvePrerequisites',
    category: 'decision',
    scope: 'agent',
    aggregation: 'firstDecision',
    failureMode: 'failClosed',
  }),
  definePluginHookDefinitionV1({
    id: 'agent.spawnEnv.augment',
    category: 'augmentation',
    scope: 'daemon',
    aggregation: 'mergeObject',
    failureMode: 'bestEffort',
  }),
  definePluginHookDefinitionV1({
    id: 'agent.context.before',
    category: 'augmentation',
    scope: 'agent',
    aggregation: 'replace',
    failureMode: 'bestEffort',
    supportedRuntimes: ['hostSession'],
  }),
  definePluginHookDefinitionV1({
    id: 'agent.request.before',
    category: 'augmentation',
    scope: 'agent',
    aggregation: 'replace',
    failureMode: 'bestEffort',
    supportedRuntimes: ['acpSession'],
  }),
  lifecycle({
    id: 'agent.stream.token',
    scope: 'agent',
    purity: 'observer',
    supportedRuntimes: ['hostSession'],
  }),
] as const satisfies readonly PluginHookDefinitionV1[];

const PLUGIN_HOOK_CATALOG_BY_ID_V1: ReadonlyMap<string, PluginHookDefinitionV1> = new Map(
  PLUGIN_HOOK_CATALOG_V1.map((entry) => [entry.id, entry]),
);

export function getPluginHookDefinitionV1(id: string): PluginHookDefinitionV1 | null {
  return PLUGIN_HOOK_CATALOG_BY_ID_V1.get(id) ?? null;
}
