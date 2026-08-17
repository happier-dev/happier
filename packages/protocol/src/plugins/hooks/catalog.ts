import { z } from 'zod';

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

export const PluginExecutionInterceptionCapabilitySchema = z.enum(['interceptable', 'observable']);
export type PluginExecutionInterceptionCapability = z.infer<typeof PluginExecutionInterceptionCapabilitySchema>;

export const PluginExecutionCallerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host') }).strict(),
  z.object({
    kind: z.literal('plugin'),
    pluginId: z.string().trim().min(1).max(256),
  }).strict(),
]);
export type PluginExecutionCaller = z.infer<typeof PluginExecutionCallerSchema>;

export const PluginExecutionInterceptionResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('continue'),
    input: PluginJsonValueV2Schema,
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    code: z.string().trim().min(1).max(256).optional(),
    message: z.string().trim().min(1).max(2_048).optional(),
  }).strict(),
]);
export type PluginExecutionInterceptionResult = z.infer<typeof PluginExecutionInterceptionResultSchema>;

const PluginExecutionOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('succeeded'), result: PluginJsonValueV2Schema.optional() }).strict(),
  z.object({
    status: z.literal('failed'),
    code: z.string().trim().min(1).max(256),
    message: z.string().trim().min(1).max(2_048).optional(),
  }).strict(),
  z.object({ status: z.literal('cancelled') }).strict(),
  z.object({
    status: z.literal('rejected'),
    code: z.string().trim().min(1).max(256).optional(),
    message: z.string().trim().min(1).max(2_048).optional(),
  }).strict(),
]);

const PluginActionExecutionInvocationSchema = z.object({
  surface: z.enum(['ui', 'voice', 'agent', 'mcp', 'cli', 'rpc', 'sdk', 'plugin']),
  sessionId: z.string().trim().min(1).optional(),
  caller: PluginExecutionCallerSchema,
}).strict();

export const ActionExecuteBeforeHookPayloadSchema = z.object({
  actionId: ActionIdSchema,
  input: PluginJsonValueV2Schema,
  invocation: PluginActionExecutionInvocationSchema,
  timestampMs: z.number().int().nonnegative(),
}).strict();
export type ActionExecuteBeforeHookPayload = z.infer<typeof ActionExecuteBeforeHookPayloadSchema>;

export const ActionExecuteAfterHookPayloadSchema = ActionExecuteBeforeHookPayloadSchema.extend({
  outcome: PluginExecutionOutcomeSchema,
}).strict();
export type ActionExecuteAfterHookPayload = z.infer<typeof ActionExecuteAfterHookPayloadSchema>;

const AgentToolExecutionBaseHookPayloadSchema = z.object({
  agentId: z.string().trim().min(1).max(256),
  runtimeFamily: PluginHookSupportedRuntimeFamilyV1Schema,
  capability: PluginExecutionInterceptionCapabilitySchema,
  sessionId: z.string().trim().min(1).optional(),
  turnId: z.string().trim().min(1).optional(),
  tool: z.object({
    callId: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(512),
    input: PluginJsonValueV2Schema,
  }).strict(),
  timestampMs: z.number().int().nonnegative(),
}).strict();

export const AgentToolExecuteBeforeHookPayloadSchema = AgentToolExecutionBaseHookPayloadSchema.extend({
  capability: z.literal('interceptable'),
}).strict();
export type AgentToolExecuteBeforeHookPayload = z.infer<typeof AgentToolExecuteBeforeHookPayloadSchema>;

export const AgentToolExecuteAfterHookPayloadSchema = AgentToolExecutionBaseHookPayloadSchema.extend({
  caller: PluginExecutionCallerSchema,
  outcome: PluginExecutionOutcomeSchema,
}).strict();
export type AgentToolExecuteAfterHookPayload = z.infer<typeof AgentToolExecuteAfterHookPayloadSchema>;

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

const AgentCompositionLocalIdV1Schema = z.string().trim().min(1).max(256);

/**
 * The only per-handler input for Agent turn composition. The host creates this
 * payload from the current manifest projection, so a plugin can make a choice
 * without receiving another plugin's catalog or a raw Session/runtime handle.
 */
export const PluginAgentCompositionRequestV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  agentId: NonEmptyStringSchema,
  runtimeFamily: z.enum(['hostSession', 'acpSession']),
  declaredToolIds: z.array(AgentCompositionLocalIdV1Schema).max(128),
  declaredPromptAssetIds: z.array(AgentCompositionLocalIdV1Schema).max(128),
}).strict();
export type PluginAgentCompositionRequestV1 = z.infer<typeof PluginAgentCompositionRequestV1Schema>;

const MAX_PLUGIN_AGENT_COMPOSITION_INSTRUCTION_BYTES = 8 * 1024;

const PluginAgentCompositionInstructionsV1Schema = z.string().trim().min(1)
  .superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength > MAX_PLUGIN_AGENT_COMPOSITION_INSTRUCTION_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'additionalInstructions must not exceed 8 KiB UTF-8',
      });
    }
  });

/**
 * Bounded output for `agent.composition.resolve`. Selection authority remains
 * host-side: this schema deliberately carries local ids only, never a tool
 * definition, prompt replacement, runtime object, or persistence capability.
 */
export const PluginAgentCompositionResultV1Schema = z.object({
  enabledToolIds: z.array(AgentCompositionLocalIdV1Schema).max(128).optional(),
  enabledPromptAssetIds: z.array(AgentCompositionLocalIdV1Schema).max(128).optional(),
  additionalInstructions: PluginAgentCompositionInstructionsV1Schema.optional(),
}).strict();
export type PluginAgentCompositionResultV1 = z.infer<typeof PluginAgentCompositionResultV1Schema>;

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
  'agent.composition.resolve': PluginAgentCompositionRequestV1Schema,
  'agent.stream.token': AgentStreamTokenHookPayloadV1Schema,
  'action.execute.before': ActionExecuteBeforeHookPayloadSchema,
  'action.execute.after': ActionExecuteAfterHookPayloadSchema,
  'agent.tool.execute.before': AgentToolExecuteBeforeHookPayloadSchema,
  'agent.tool.execute.after': AgentToolExecuteAfterHookPayloadSchema,
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
