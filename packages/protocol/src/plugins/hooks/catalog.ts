import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { BackendTargetKeySchema } from '../../backends/targets/backendTargetRef.js';
import { BackendTargetRefV2Schema } from '../../backends/targets/backendTargetRefV2.js';
import {
  ExecutionRunClassSchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunRetentionPolicySchema,
} from '../../execution/runs/runPrimitives.js';
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
import { ActionIdSchema } from '../../actions/actionIds.js';
import { AgentIdV1Schema } from '../../agents/agentIdV1.js';

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
  'agent.composition.resolve',
  'agent.stream.token',
  'action.execute.before',
  'action.execute.after',
  'agent.tool.execute.before',
  'agent.tool.execute.after',
] as const;
export const PluginHookIdV1Schema = lazyZodSchema(() => z.enum(PLUGIN_HOOK_IDS_V1));
export type PluginHookIdV1 = z.infer<typeof PluginHookIdV1Schema>;

export const PluginHookScopeV1Schema = lazyZodSchema(() => z.enum([
  'machine',
  'project',
  'session',
  'agent',
  'daemon',
  'tool',
  'resource',
  'plugin',
]));
export type PluginHookScopeV1 = z.infer<typeof PluginHookScopeV1Schema>;

export const PluginHookAggregationKindV1Schema = lazyZodSchema(() => z.enum([
  'none',
  'orderedList',
  'mergeObject',
  'firstDecision',
  'allDecisions',
  'replace',
]));
export type PluginHookAggregationKindV1 = z.infer<typeof PluginHookAggregationKindV1Schema>;

export const PluginHookFailureModeV1Schema = lazyZodSchema(() => z.enum(['bestEffort', 'failClosed']));
export type PluginHookFailureModeV1 = z.infer<typeof PluginHookFailureModeV1Schema>;

export const PluginHookPurityV1Schema = lazyZodSchema(() => z.enum(['observer', 'participant']));
export type PluginHookPurityV1 = z.infer<typeof PluginHookPurityV1Schema>;

export const PluginHookSupportedRuntimeFamilyV1Schema = lazyZodSchema(() => z.enum([
  'hostSession',
  'acpSession',
  'pluginSession',
  'executionRun',
]));
export type PluginHookSupportedRuntimeFamilyV1 = z.infer<typeof PluginHookSupportedRuntimeFamilyV1Schema>;

export const PluginHookDecisionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('allow') }),
  z.strictObject({
    decision: z.literal('deny'),
    reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    errorMessage: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_048))),
  }),
  z.strictObject({ decision: z.literal('abstain') }),
]));
export type PluginHookDecisionResultV1 = z.infer<typeof PluginHookDecisionResultV1Schema>;

export const PluginExecutionInterceptionCapabilitySchema = lazyZodSchema(() => z.enum(['interceptable', 'observable']));
export type PluginExecutionInterceptionCapability = z.infer<typeof PluginExecutionInterceptionCapabilitySchema>;

export const PluginExecutionCallerSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }),
  z.strictObject({ kind: z.literal('session'), sessionId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({
    kind: z.literal('plugin'),
    pluginId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  }),
]));
export type PluginExecutionCaller = z.infer<typeof PluginExecutionCallerSchema>;

export const PluginExecutionInterceptionResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('continue'),
    input: PluginJsonValueV2Schema,
  }),
  z.strictObject({
    status: z.literal('rejected'),
    code: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    message: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_048))),
  }),
]));
export type PluginExecutionInterceptionResult = z.infer<typeof PluginExecutionInterceptionResultSchema>;

const PluginExecutionOutcomeSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded'), result: z.optional(PluginJsonValueV2Schema) }),
  z.strictObject({
    status: z.literal('failed'),
    code: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    message: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_048))),
  }),
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({
    status: z.literal('rejected'),
    code: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    message: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_048))),
  }),
]));

const PluginActionExecutionInvocationSchema = lazyZodSchema(() => z.strictObject({
  surface: z.enum(['ui', 'voice', 'agent', 'mcp', 'cli', 'rpc', 'api', 'plugin']),
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  caller: PluginExecutionCallerSchema,
}));

export const ActionExecuteBeforeHookPayloadSchema = lazyZodSchema(() => z.strictObject({
  actionId: ActionIdSchema,
  input: PluginJsonValueV2Schema,
  invocation: PluginActionExecutionInvocationSchema,
  timestampMs: z.number().check(z.int(), z.nonnegative()),
}));
export type ActionExecuteBeforeHookPayload = z.infer<typeof ActionExecuteBeforeHookPayloadSchema>;

export const ActionExecuteAfterHookPayloadSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ActionExecuteBeforeHookPayloadSchema, {
  outcome: PluginExecutionOutcomeSchema,
})));
export type ActionExecuteAfterHookPayload = z.infer<typeof ActionExecuteAfterHookPayloadSchema>;

const AgentToolExecutionBaseHookPayloadSchema = lazyZodSchema(() => z.strictObject({
  agentId: AgentIdV1Schema,
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  capability: PluginExecutionInterceptionCapabilitySchema,
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  tool: z.strictObject({
    callId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    name: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    input: PluginJsonValueV2Schema,
  }),
  timestampMs: z.number().check(z.int(), z.nonnegative()),
}));

export const AgentToolExecuteBeforeHookPayloadSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentToolExecutionBaseHookPayloadSchema, {
  capability: z.literal('interceptable'),
})));
export type AgentToolExecuteBeforeHookPayload = z.infer<typeof AgentToolExecuteBeforeHookPayloadSchema>;

export const AgentToolExecuteAfterHookPayloadSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentToolExecutionBaseHookPayloadSchema, {
  caller: PluginExecutionCallerSchema,
  outcome: PluginExecutionOutcomeSchema,
})));
export type AgentToolExecuteAfterHookPayload = z.infer<typeof AgentToolExecuteAfterHookPayloadSchema>;

const PluginHookAugmentationResultV1Schema = lazyZodSchema(() => z.record(z.string(), PluginJsonValueV2Schema));

export const PluginHookDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
  id: PluginHookIdV1Schema,
  category: HookCategoryV1Schema,
  scope: PluginHookScopeV1Schema,
  executionKind: HookExecutionKindV1Schema,
  aggregation: PluginHookAggregationKindV1Schema,
  failureMode: PluginHookFailureModeV1Schema,
  purity: z.optional(PluginHookPurityV1Schema),
  supportedRuntimes: z._default(z.array(PluginHookSupportedRuntimeFamilyV1Schema), []),
  payloadSchema: z._default(z.record(z.string(), z.unknown()), {}),
  resultSchema: z._default(z.record(z.string(), z.unknown()), {}),
}));
export type PluginHookDefinitionV1 = z.infer<typeof PluginHookDefinitionV1Schema>;

const NonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
const TimestampMsSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0)));
export const SessionSpawnedHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: NonEmptyStringSchema,
  agentId: NonEmptyStringSchema,
  runtimeTarget: BackendTargetRefV2Schema,
  modelId: z.optional(NonEmptyStringSchema),
  cwd: z.optional(z.string()),
  initialMessage: z.optional(z.string()),
  tag: z.optional(z.string()),
  host: z.optional(z.string()),
  machineId: z.optional(z.string()),
  timestampMs: TimestampMsSchema,
}));

export const SessionMessageSendHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: NonEmptyStringSchema,
  text: z.string(),
  source: z.enum(['user', 'plugin', 'system']),
  turnId: z.optional(z.string()),
  timestampMs: TimestampMsSchema,
}));

export const SessionInputTransformHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: NonEmptyStringSchema,
  localId: z.optional(NonEmptyStringSchema),
  text: z.string(),
  meta: z.optional(z.record(z.string(), z.unknown())),
  timestampMs: TimestampMsSchema,
}));

export const ExecutionRunStartedHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(NonEmptyStringSchema),
  runId: NonEmptyStringSchema,
  intent: ExecutionRunIntentSchema,
  runtimeTargetKeys: z.array(BackendTargetKeySchema),
  permissionMode: z.optional(z.string()),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  timestampMs: TimestampMsSchema,
}));

export const ExecutionRunMessageSentHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(NonEmptyStringSchema),
  runId: NonEmptyStringSchema,
  message: z.string(),
  resume: z.optional(z.boolean()),
  timestampMs: TimestampMsSchema,
}));

export const ExecutionRunStoppedHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(NonEmptyStringSchema),
  runId: NonEmptyStringSchema,
  reason: z.enum(['user', 'plugin', 'timeout', 'error']),
  timestampMs: TimestampMsSchema,
}));

export const ExecutionRunCompletedHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(NonEmptyStringSchema),
  runId: NonEmptyStringSchema,
  status: z.enum(['succeeded', 'failed', 'canceled']),
  errorCode: z.optional(z.string()),
  error: z.optional(z.string()),
  output: z.optional(z.unknown()),
  timestampMs: TimestampMsSchema,
}));

export const AgentResolvePrerequisitesHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  agentId: NonEmptyStringSchema,
  runtimeTarget: BackendTargetRefV2Schema,
  sessionId: z.optional(NonEmptyStringSchema),
  cwd: z.optional(z.string()),
  timestampMs: TimestampMsSchema,
}));

export const AgentSpawnEnvAugmentHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  agentId: NonEmptyStringSchema,
  sessionId: z.optional(NonEmptyStringSchema),
  cwd: z.optional(z.string()),
  timestampMs: TimestampMsSchema,
}));

const AgentMessageProjectionV1Schema = lazyZodSchema(() => z.looseObject({
  role: z.string().check(z.trim(), z.minLength(1)),
  content: z.unknown(),
}));

export const AgentContextBeforeHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: NonEmptyStringSchema,
  agentId: z.optional(NonEmptyStringSchema),
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  prompt: z.string(),
  messages: z.array(AgentMessageProjectionV1Schema),
  timestampMs: TimestampMsSchema,
}));

export const AgentRequestBeforeHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(NonEmptyStringSchema),
  agentId: z.optional(NonEmptyStringSchema),
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  method: NonEmptyStringSchema,
  request: z.record(z.string(), z.unknown()),
  timestampMs: TimestampMsSchema,
}));

const AgentCompositionLocalIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

/**
 * The only per-handler input for Agent turn composition. The host creates this
 * payload from the current manifest projection, so a plugin can make a choice
 * without receiving another plugin's catalog or a raw Session/runtime handle.
 */
export const PluginAgentCompositionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: NonEmptyStringSchema,
  agentId: NonEmptyStringSchema,
  runtimeFamily: z.enum(['hostSession', 'acpSession']),
  declaredToolIds: z.array(AgentCompositionLocalIdV1Schema).check(z.maxLength(128)),
  declaredPromptAssetIds: z.array(AgentCompositionLocalIdV1Schema).check(z.maxLength(128)),
}));
export type PluginAgentCompositionRequestV1 = z.infer<typeof PluginAgentCompositionRequestV1Schema>;

const MAX_PLUGIN_AGENT_COMPOSITION_INSTRUCTION_BYTES = 8 * 1024;

const PluginAgentCompositionInstructionsV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength > MAX_PLUGIN_AGENT_COMPOSITION_INSTRUCTION_BYTES) {
      context.addIssue({
        code: "custom",
        message: 'additionalInstructions must not exceed 8 KiB UTF-8',
      });
    }
  })));

/**
 * Bounded output for `agent.composition.resolve`. Selection authority remains
 * host-side: this schema deliberately carries local ids only, never a tool
 * definition, prompt replacement, runtime object, or persistence capability.
 */
export const PluginAgentCompositionResultV1Schema = lazyZodSchema(() => z.strictObject({
  enabledToolIds: z.optional(z.array(AgentCompositionLocalIdV1Schema).check(z.maxLength(128))),
  enabledPromptAssetIds: z.optional(z.array(AgentCompositionLocalIdV1Schema).check(z.maxLength(128))),
  additionalInstructions: z.optional(PluginAgentCompositionInstructionsV1Schema),
}));
export type PluginAgentCompositionResultV1 = z.infer<typeof PluginAgentCompositionResultV1Schema>;

export const AgentStreamTokenHookPayloadV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: NonEmptyStringSchema,
  agentId: z.optional(NonEmptyStringSchema),
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  turnId: NonEmptyStringSchema,
  tokenText: z.string(),
  streamKind: z.enum(['assistant', 'thinking', 'unknown']),
  timestampMs: TimestampMsSchema,
}));

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
  'agent.composition.resolve': PluginAgentCompositionRequestV1Schema,
  'agent.stream.token': AgentStreamTokenHookPayloadV1Schema,
  'action.execute.before': ActionExecuteBeforeHookPayloadSchema,
  'action.execute.after': ActionExecuteAfterHookPayloadSchema,
  'agent.tool.execute.before': AgentToolExecuteBeforeHookPayloadSchema,
  'agent.tool.execute.after': AgentToolExecuteAfterHookPayloadSchema,
} satisfies Readonly<Record<PluginHookIdV1, z.ZodMiniType<unknown>>>);

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

  if (hookId.data === 'action.execute.before' || hookId.data === 'agent.tool.execute.before') {
    const parsed = PluginExecutionInterceptionResultSchema.safeParse(params.result);
    return parsed.success
      ? { success: true, result: parsed.data }
      : { success: false, message: `Invalid result for plugin hook '${hookId.data}': ${parsed.error.issues.map((issue) => issue.message).join('; ')}` };
  }

  if (hookId.data === 'agent.composition.resolve') {
    if (typeof params.result === 'undefined') return { success: true, result: undefined };
    const parsed = PluginAgentCompositionResultV1Schema.safeParse(params.result);
    return parsed.success
      ? { success: true, result: parsed.data }
      : { success: false, message: `Invalid result for plugin hook '${hookId.data}': ${parsed.error.issues.map((issue) => issue.message).join('; ')}` };
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
  definePluginHookDefinitionV1({
    id: 'agent.composition.resolve',
    category: 'augmentation',
    scope: 'agent',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
    supportedRuntimes: ['hostSession', 'acpSession'],
  }),
  lifecycle({
    id: 'agent.stream.token',
    scope: 'agent',
    purity: 'observer',
    supportedRuntimes: ['hostSession'],
  }),
  definePluginHookDefinitionV1({
    id: 'action.execute.before',
    category: 'augmentation',
    scope: 'tool',
    aggregation: 'replace',
    failureMode: 'failClosed',
    purity: 'participant',
  }),
  lifecycle({ id: 'action.execute.after', scope: 'tool', purity: 'observer' }),
  definePluginHookDefinitionV1({
    id: 'agent.tool.execute.before',
    category: 'augmentation',
    scope: 'tool',
    aggregation: 'replace',
    failureMode: 'failClosed',
    purity: 'participant',
  }),
  lifecycle({ id: 'agent.tool.execute.after', scope: 'tool', purity: 'observer' }),
] as const satisfies readonly PluginHookDefinitionV1[];

const PLUGIN_HOOK_CATALOG_BY_ID_V1: ReadonlyMap<string, PluginHookDefinitionV1> = new Map(
  PLUGIN_HOOK_CATALOG_V1.map((entry) => [entry.id, entry]),
);

export function getPluginHookDefinitionV1(id: string): PluginHookDefinitionV1 | null {
  return PLUGIN_HOOK_CATALOG_BY_ID_V1.get(id) ?? null;
}
