import { z } from 'zod';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from './agentSessionLimitsV1.js';
import {
  AgentSessionProviderBindingV1Schema,
  type AgentSessionProviderBindingV1,
} from '../providers/sessions/bindingMetadataV1.js';
import { SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX } from '../sessions/runtime/activity/sessionRuntimeActivity.js';

const HOST_ID_MAX = LIMITS.hostIndexedIdMaxCodeUnits;
const PROVIDER_ID_MAX = LIMITS.providerIdMaxCodeUnits;
const INPUT_IDS_MAX = LIMITS.inputIdsMaxItems;
const NAME_MAX = LIMITS.toolNameMaxCodeUnits;
const MODEL_ID_MAX = LIMITS.modelIdMaxCodeUnits;
const SOURCE_MAX = LIMITS.usageSourceMaxCodeUnits;
const PATH_MAX = LIMITS.filePathMaxCodeUnits;
const DESCRIPTION_MAX = LIMITS.descriptionMaxCodeUnits;
const DELTA_MAX = LIMITS.deltaTextMaxCodeUnits;
const INPUT_TEXT_CANDIDATE_MAX = LIMITS.p0MeasuredCandidates.inputTextMaxCodeUnits;
const TRANSCRIPT_TEXT_CANDIDATE_MAX = LIMITS.p0MeasuredCandidates.transcriptTextMaxCodeUnits;
const COMPACT_INSTRUCTIONS_MAX = LIMITS.compactInstructionsMaxCodeUnits;
const EVENT_JSON_BYTES_CANDIDATE_MAX = LIMITS.p0MeasuredCandidates.eventMaxJsonBytes;
const SEND_JSON_BYTES_CANDIDATE_MAX = LIMITS.p0MeasuredCandidates.sendRequestMaxJsonBytes;

function exactString(max: number) {
  return z.string().min(1).max(max).refine(
    (value) => value === value.trim(),
    'Identifiers must not contain leading or trailing whitespace',
  );
}

function opaqueNonBlankString(max: number) {
  return z.string().min(1).max(max).refine(
    (value) => value.trim().length > 0,
    'Identifiers must contain a non-whitespace character',
  );
}

const HostIdSchema = exactString(HOST_ID_MAX);
const ProviderIdSchema = exactString(PROVIDER_ID_MAX);
const InputIdSchema = opaqueNonBlankString(HOST_ID_MAX);
const SafeIntegerSchema = z.number().int().nonnegative().max(LIMITS.safeIntegerMax);

type StrictJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly StrictJsonValue[]
  | { readonly [key: string]: StrictJsonValue };

function normalizeStrictJsonValue(input: unknown): StrictJsonValue {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const textEncoder = new TextEncoder();

  const visit = (value: unknown, depth: number): StrictJsonValue => {
    nodes += 1;
    if (nodes > LIMITS.json.maxNodes) throw new Error('JSON node limit exceeded');
    if (depth > LIMITS.json.maxDepth) throw new Error('JSON depth limit exceeded');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('JSON numbers must be finite');
      return value;
    }
    if (typeof value === 'string') {
      if (textEncoder.encode(value).byteLength > LIMITS.json.maxStringUtf8Bytes) {
        throw new Error('JSON string limit exceeded');
      }
      return value;
    }
    if (typeof value !== 'object') throw new Error('Value is not strict JSON');
    if (seen.has(value)) throw new Error('Cyclic JSON is not supported');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const ownKeys = Reflect.ownKeys(value);
        for (const key of ownKeys) {
          if (typeof key !== 'string') throw new Error('JSON symbols are not supported');
          if (key === 'length') continue;
          if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error('JSON arrays cannot have named properties');
        }
        const output: StrictJsonValue[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.hasOwn(value, index)) throw new Error('Sparse JSON arrays are not supported');
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor)) throw new Error('JSON accessors are not supported');
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('JSON objects must use a plain or null prototype');
      }
      const output = Object.create(null) as Record<string, StrictJsonValue>;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new Error('JSON symbols are not supported');
        if (textEncoder.encode(key).byteLength > LIMITS.json.maxKeyUtf8Bytes) {
          throw new Error('JSON key limit exceeded');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('JSON accessors are not supported');
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    } finally {
      seen.delete(value);
    }
  };

  const normalized = visit(input, 0);
  if (jsonByteLength(normalized) > LIMITS.p0MeasuredCandidates.jsonValueMaxJsonBytes) {
    throw new Error('JSON aggregate byte limit exceeded');
  }
  return normalized;
}

export const AgentRuntimeJsonValueV1Schema = z.unknown().transform((value, context): StrictJsonValue => {
  try {
    return normalizeStrictJsonValue(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid strict JSON value',
    });
    return z.NEVER;
  }
});
export const AgentRuntimeJsonValueSchema = AgentRuntimeJsonValueV1Schema;

const JsonValueSchema = AgentRuntimeJsonValueV1Schema;
export const AgentSessionProviderCheckpointMaxJsonBytesV1 = 4_096;
export const AgentSessionProviderCheckpointV1Schema = AgentRuntimeJsonValueV1Schema.refine(
  (value) => (
    new TextEncoder().encode(JSON.stringify(value)).byteLength
    <= AgentSessionProviderCheckpointMaxJsonBytesV1
  ),
  'Provider checkpoint exceeds the Agent session byte bound',
);

const TimestampedAgentValueV1Schema = <ValueSchema extends z.ZodType>(
  value: ValueSchema,
) => z.object({
  value,
  updatedAtMs: SafeIntegerSchema,
}).strict();

const AgentLaunchEnvironmentCoreV1Schema = z.object({
  values: z.record(exactString(HOST_ID_MAX), z.string()),
  unset: z.array(exactString(HOST_ID_MAX)),
}).strict().superRefine((value, context) => {
  const seenUnset = new Set<string>();
  for (const key of value.unset) {
    if (seenUnset.has(key)) {
      context.addIssue({ code: 'custom', message: `Duplicate launch-environment unset key '${key}'` });
    }
    seenUnset.add(key);
    if (Object.hasOwn(value.values, key)) {
      context.addIssue({ code: 'custom', message: `Launch-environment key '${key}' cannot be set and unset` });
    }
  }
});

export const AgentLaunchEnvironmentV1Schema = AgentRuntimeJsonValueV1Schema.pipe(
  AgentLaunchEnvironmentCoreV1Schema,
);

const AgentConfigurationScalarV1Schema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const AgentPermissionIntentV1Schema = z.enum([
  'default',
  'read-only',
  'safe-yolo',
  'yolo',
  'plan',
]);
const AgentSessionConfigurationSnapshotCoreV1Schema = z.object({
  mode: TimestampedAgentValueV1Schema(exactString(MODEL_ID_MAX).nullable()),
  model: TimestampedAgentValueV1Schema(exactString(MODEL_ID_MAX).nullable()),
  permissionIntent: TimestampedAgentValueV1Schema(AgentPermissionIntentV1Schema.nullable()),
  options: z.record(
    exactString(HOST_ID_MAX),
    TimestampedAgentValueV1Schema(AgentConfigurationScalarV1Schema),
  ),
}).strict();

export const AgentSessionConfigurationSnapshotV1Schema = AgentRuntimeJsonValueV1Schema.pipe(
  AgentSessionConfigurationSnapshotCoreV1Schema,
);

export type AgentSessionConfigurationUpdateV1 = z.infer<
  typeof AgentSessionConfigurationSnapshotV1Schema
> & Readonly<{
  providerBinding?: AgentSessionProviderBindingV1;
}>;
export const AgentSessionConfigurationUpdateV1Schema =
  AgentRuntimeJsonValueV1Schema.pipe(
    AgentSessionConfigurationSnapshotCoreV1Schema.extend({
      providerBinding: AgentSessionProviderBindingV1Schema.optional(),
    }).strict(),
  ) as z.ZodType<AgentSessionConfigurationUpdateV1, AgentSessionConfigurationUpdateV1>;

const PluginContributionRefSchema = z.object({
  pluginId: exactString(PROVIDER_ID_MAX),
  localId: exactString(PROVIDER_ID_MAX),
}).strict();

const PluginRemediationDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retry') }).strict(),
  z.object({ kind: z.literal('openSettings'), path: z.string().max(PATH_MAX) }).strict(),
  z.object({ kind: z.literal('selectAccount'), service: PluginContributionRefSchema }).strict(),
  z.object({ kind: z.literal('installDependency'), dependencyId: exactString(PROVIDER_ID_MAX) }).strict(),
  z.object({ kind: z.literal('openUrl'), url: z.string().url() }).strict(),
]);

const PluginDiagnosticDataSchema = z.object({
  code: exactString(SOURCE_MAX),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().max(DESCRIPTION_MAX).optional(),
  details: JsonValueSchema.optional(),
  remediation: PluginRemediationDataSchema.optional(),
}).strict();

const EventBaseSchema = z.object({
  sequence: SafeIntegerSchema,
  sessionId: HostIdSchema,
  emittedAtMs: SafeIntegerSchema,
}).strict();

export const SESSION_RUNTIME_ACTIVITY_SLOT_ACTIVE_COUNT_MAX = Math.floor(
  SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX / 2,
);
const SessionRuntimeActivitySlotActiveCountSchema = SafeIntegerSchema.max(
  SESSION_RUNTIME_ACTIVITY_SLOT_ACTIVE_COUNT_MAX,
);
const RuntimeActivitySnapshotEventSchema = EventBaseSchema.extend({
  kind: z.literal('runtime-activity-snapshot'),
  state: z.enum(['active', 'idle', 'unknown']),
  activeCount: SessionRuntimeActivitySlotActiveCountSchema,
}).strict().superRefine((value, context) => {
  if (value.state === 'active') {
    if (value.activeCount <= 0) {
      context.addIssue({ code: 'custom', path: ['activeCount'], message: 'Active snapshots require a positive count' });
    }
    return;
  }
  if (value.activeCount !== 0) {
    context.addIssue({ code: 'custom', path: ['activeCount'], message: 'Idle and unknown snapshots require a zero count' });
  }
});

const TurnEventBaseShape = {
  sequence: SafeIntegerSchema,
  sessionId: HostIdSchema,
  emittedAtMs: SafeIntegerSchema,
  turnId: HostIdSchema,
  agentTurnId: ProviderIdSchema.optional(),
};

const InputIdsSchema = z.tuple([InputIdSchema], InputIdSchema)
  .refine((ids) => ids.length <= INPUT_IDS_MAX, 'Input id tuple limit exceeded')
  .refine((ids) => new Set(ids).size === ids.length, 'Input ids must be duplicate-free');

const UsageTokensSchema = z.object({
  input: SafeIntegerSchema,
  output: SafeIntegerSchema,
  reasoning: SafeIntegerSchema,
  cacheRead: SafeIntegerSchema,
  cacheWrite: SafeIntegerSchema,
  total: SafeIntegerSchema,
}).strict();

const UsageCostSchema = z.object({
  reportedUsd: z.number().finite().nonnegative(),
  estimatedUsd: z.number().finite().nonnegative(),
  invoiceUsd: z.number().finite().nonnegative().optional(),
  billingContext: z.enum([
    'api_usage',
    'subscription_included',
    'subscription_with_possible_overage',
    'unknown',
  ]).optional(),
  costSource: z.enum([
    'provider_reported',
    'provider_reported_api_equivalent',
    'pricing_estimate',
    'invoice',
    'none',
  ]).optional(),
  currency: exactString(LIMITS.usage.currencyMaxCodeUnits),
  breakdown: z.record(
    exactString(LIMITS.usage.breakdownKeyMaxCodeUnits),
    z.number().finite().nonnegative(),
  )
    .refine(
      (value) => Object.keys(value).length <= LIMITS.usage.breakdownMaxEntries,
      'Usage breakdown entry limit exceeded',
    )
    .optional(),
  effectiveUsd: z.number().finite().nonnegative().optional(),
}).strict();

const ContextUsageSchema = z.object({
  v: z.literal(1),
  modelId: exactString(MODEL_ID_MAX).nullable(),
  usedTokens: SafeIntegerSchema,
  windowTokens: SafeIntegerSchema.nullable(),
  totalProcessedTokens: SafeIntegerSchema.nullable(),
  baselineTokens: SafeIntegerSchema.nullable(),
  isAutoCompactEnabled: z.boolean().nullable(),
  categories: z.array(z.object({
    key: exactString(LIMITS.usage.contextCategoryKeyMaxCodeUnits),
    label: z.string().max(LIMITS.usage.contextCategoryLabelMaxCodeUnits).nullable(),
    tokens: SafeIntegerSchema,
  }).strict()).max(LIMITS.usage.contextCategoriesMaxItems).nullable(),
  observedAtMs: SafeIntegerSchema,
  source: z.enum(['provider_live', 'provider_turn', 'derived_estimate']),
}).strict();

const UsageMeasurementShape = {
  tokens: UsageTokensSchema.optional(),
  cost: UsageCostSchema.optional(),
  context: ContextUsageSchema.optional(),
};

const InputCustodySchemas = [
  EventBaseSchema.extend({
    kind: z.literal('input-accepted'),
    inputIds: InputIdsSchema,
    delivery: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('newTurn'), turnId: HostIdSchema }).strict(),
      z.object({ kind: z.literal('followUp'), turnId: HostIdSchema }).strict(),
      z.object({ kind: z.literal('steer'), turnId: HostIdSchema }).strict(),
    ]),
  }).strict(),
  EventBaseSchema.extend({
    kind: z.literal('input-rejected'),
    inputIds: InputIdsSchema,
    diagnostic: PluginDiagnosticDataSchema,
    retryable: z.boolean(),
  }).strict(),
  EventBaseSchema.extend({
    kind: z.literal('input-custody-unknown'),
    inputIds: InputIdsSchema,
    issue: PluginDiagnosticDataSchema,
  }).strict(),
  EventBaseSchema.extend({
    kind: z.literal('input-delivery-failed'),
    inputIds: InputIdsSchema,
    delivery: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('newTurn'), turnId: HostIdSchema }).strict(),
      z.object({ kind: z.literal('followUp'), turnId: HostIdSchema }).strict(),
    ]),
    issue: PluginDiagnosticDataSchema,
    duplicateRisk: z.enum(['possible', 'likely', 'unknown']),
  }).strict(),
] as const;

const LifecycleSchemas = [
  EventBaseSchema.extend({ kind: z.literal('provider-session-id'), providerSessionId: ProviderIdSchema }).strict(),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('turn-start'),
    startedBy: z.enum(['host', 'provider']),
    causedByTurnId: HostIdSchema.optional(),
  }).strict(),
  z.object({ ...TurnEventBaseShape, kind: z.literal('turn-progress') }).strict(),
  z.object({ ...TurnEventBaseShape, kind: z.literal('turn-agent-id-observed'), agentTurnId: ProviderIdSchema }).strict(),
  z.object({ ...TurnEventBaseShape, kind: z.literal('turn-complete') }).strict(),
  z.object({ ...TurnEventBaseShape, kind: z.literal('turn-failed'), diagnostic: PluginDiagnosticDataSchema }).strict(),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('turn-cancelled'),
    cause: z.enum([
      'user',
      'hostShutdown',
      'sessionDispose',
      'runtimeRecovery',
      'providerCancelled',
      'providerInterrupted',
      'unknown',
    ]),
    diagnostic: PluginDiagnosticDataSchema.optional(),
  }).strict(),
  EventBaseSchema.extend({
    kind: z.literal('runtime-ended'),
    cause: z.enum(['providerEnded', 'connectionLost', 'processExited', 'protocolError', 'unknown']),
    retryable: z.boolean(),
    diagnostic: PluginDiagnosticDataSchema.optional(),
  }).strict(),
] as const;

const OutputSchemas = [
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('message-delta'),
    channel: z.enum(['assistant', 'reasoning']),
    text: z.string().max(DELTA_MAX),
    sidechainId: HostIdSchema.optional(),
  }).strict(),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('tool-call'),
    toolCallId: ProviderIdSchema,
    toolName: exactString(NAME_MAX),
    input: JsonValueSchema,
    sidechainId: HostIdSchema.optional(),
  }).strict(),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('tool-progress'),
    toolCallId: ProviderIdSchema,
    progress: JsonValueSchema,
    sidechainId: HostIdSchema.optional(),
  }).strict(),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('tool-result'),
    toolCallId: ProviderIdSchema,
    output: JsonValueSchema,
    isError: z.boolean().optional(),
    sidechainId: HostIdSchema.optional(),
  }).strict(),
  EventBaseSchema.extend({
    kind: z.literal('transcript-message-committed'),
    messageId: ProviderIdSchema,
    role: z.enum(['user', 'assistant', 'reasoning']),
    text: z.string().max(TRANSCRIPT_TEXT_CANDIDATE_MAX),
    turnId: HostIdSchema.optional(),
    sidechainId: HostIdSchema.optional(),
  }).strict(),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('file-edit'),
    editId: ProviderIdSchema,
    path: z.string().max(PATH_MAX),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    diff: z.string().max(LIMITS.p0MeasuredCandidates.fileEditMemberMaxCodeUnits).optional(),
    oldContent: z.string().max(LIMITS.p0MeasuredCandidates.fileEditMemberMaxCodeUnits).optional(),
    newContent: z.string().max(LIMITS.p0MeasuredCandidates.fileEditMemberMaxCodeUnits).optional(),
    sidechainId: HostIdSchema.optional(),
  }).strict().refine(
    (value) => jsonByteLength({
      diff: value.diff,
      oldContent: value.oldContent,
      newContent: value.newContent,
    }) <= LIMITS.p0MeasuredCandidates.fileEditContentMaxJsonBytes,
    'File-edit content exceeds the CORE-A candidate byte bound',
  ),
  EventBaseSchema.extend({
    kind: z.literal('usage-observed'),
    observationId: ProviderIdSchema,
    turnId: HostIdSchema.optional(),
    source: exactString(SOURCE_MAX),
    scope: z.enum(['turn_delta', 'session_cumulative', 'session_final']),
    modelId: exactString(MODEL_ID_MAX).optional(),
    ...UsageMeasurementShape,
  }).strict().refine(
    (value) => value.tokens !== undefined || value.cost !== undefined || value.context !== undefined,
    'At least one usage measurement is required',
  ),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('turn-rollback-boundary'),
    agentRollbackOrdinal: SafeIntegerSchema.optional(),
    providerCheckpoint: AgentSessionProviderCheckpointV1Schema.optional(),
  }).strict(),
] as const;

const CompactionCommonShape = {
  sequence: SafeIntegerSchema,
  sessionId: HostIdSchema,
  emittedAtMs: SafeIntegerSchema,
  kind: z.literal('context-compaction'),
  compactionId: HostIdSchema,
  turnId: HostIdSchema.optional(),
  trigger: z.enum(['manual', 'automatic', 'threshold', 'overflow', 'unknown']),
  retryAttempt: SafeIntegerSchema.optional(),
};

const TokenCountSourceSchema = z.enum(['providerReported', 'providerEstimated', 'derivedEstimate']);
const CompactionSchemas = [
  z.object({
    ...CompactionCommonShape,
    phase: z.literal('started'),
    tokenCountBefore: SafeIntegerSchema.optional(),
    tokenCountSource: TokenCountSourceSchema.optional(),
  }).strict().superRefine((value, context) => {
    if ((value.tokenCountBefore === undefined) !== (value.tokenCountSource === undefined)) {
      context.addIssue({ code: 'custom', message: 'Token count and source must be supplied together' });
    }
  }),
  z.object({ ...CompactionCommonShape, phase: z.literal('progress') }).strict(),
  z.object({
    ...CompactionCommonShape,
    phase: z.literal('completed'),
    tokenCountBefore: SafeIntegerSchema.optional(),
    tokenCountAfter: SafeIntegerSchema.optional(),
    tokenCountSource: TokenCountSourceSchema.optional(),
    continuation: z.literal('paused').optional(),
    pauseReason: z.literal('agentIdleAfterCompaction').optional(),
  }).strict().superRefine((value, context) => {
    const hasCount = value.tokenCountBefore !== undefined || value.tokenCountAfter !== undefined;
    if (hasCount !== (value.tokenCountSource !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Token counts require their source' });
    }
    if (value.pauseReason !== undefined && value.continuation !== 'paused') {
      context.addIssue({ code: 'custom', message: 'Pause reason requires paused continuation' });
    }
  }),
  z.object({ ...CompactionCommonShape, phase: z.literal('failed'), diagnostic: PluginDiagnosticDataSchema }).strict(),
  z.object({ ...CompactionCommonShape, phase: z.literal('cancelled'), diagnostic: PluginDiagnosticDataSchema.optional() }).strict(),
  z.object({ ...CompactionCommonShape, phase: z.literal('outcomeUnknown'), diagnostic: PluginDiagnosticDataSchema }).strict(),
] as const;

const AgentSessionRuntimeNonCompactionEventV1Schema = z.discriminatedUnion('kind', [
  ...InputCustodySchemas,
  ...LifecycleSchemas,
  ...OutputSchemas,
  RuntimeActivitySnapshotEventSchema,
]);
const AgentSessionCompactionEventV1Schema = z.discriminatedUnion('phase', CompactionSchemas);
const AgentSessionRuntimeEventCoreV1Schema = z.union([
  AgentSessionRuntimeNonCompactionEventV1Schema,
  AgentSessionCompactionEventV1Schema,
]);

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export const AgentSessionRuntimeEventV1Schema = AgentSessionRuntimeEventCoreV1Schema.superRefine((value, context) => {
  if (jsonByteLength(value) > EVENT_JSON_BYTES_CANDIDATE_MAX) {
    context.addIssue({ code: 'custom', message: 'Agent runtime event exceeds the CORE-A candidate byte bound' });
  }
});
export const AgentSessionRuntimeEventSchema = AgentSessionRuntimeEventV1Schema;

const AgentSessionInputV1Schema = z.object({
  text: z.string().max(INPUT_TEXT_CANDIDATE_MAX),
  structuredInput: JsonValueSchema.optional(),
}).strict();

const AgentSessionDeliveryV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('newTurn'), turnId: HostIdSchema }).strict(),
  z.object({ kind: z.literal('steer'), turnId: HostIdSchema }).strict(),
  z.object({ kind: z.literal('followUp'), turnId: HostIdSchema, afterTurnId: HostIdSchema }).strict(),
]);

export const AgentSessionSendRequestV1Schema = z.object({
  inputIds: InputIdsSchema,
  input: AgentSessionInputV1Schema,
  delivery: AgentSessionDeliveryV1Schema,
}).strict().superRefine((value, context) => {
  if (jsonByteLength(value) > SEND_JSON_BYTES_CANDIDATE_MAX) {
    context.addIssue({ code: 'custom', message: 'Agent runtime send request exceeds the CORE-A candidate byte bound' });
  }
});

export const AgentSessionCompactRequestV1Schema = z.object({
  compactionId: HostIdSchema,
  trigger: z.literal('manual'),
  instructions: z.string().max(COMPACT_INSTRUCTIONS_MAX).optional(),
}).strict();

const AgentSessionConversationRollbackAffectedTurnV1Schema = z.object({
  turnId: HostIdSchema,
  providerCheckpoint: AgentSessionProviderCheckpointV1Schema.optional(),
}).strict();

export const AgentSessionConversationRollbackRequestV1Schema = z.object({
  operationId: HostIdSchema,
  target: z.object({ kind: z.literal('beforeTurn'), turnId: HostIdSchema }).strict(),
  affectedTurns: z.tuple(
    [AgentSessionConversationRollbackAffectedTurnV1Schema],
    AgentSessionConversationRollbackAffectedTurnV1Schema,
  )
    .refine(
      (turns) => turns.length <= LIMITS.p0MeasuredCandidates.conversationRollbackMaxAffectedTurns,
      'Conversation rollback affected-turn limit exceeded',
    )
    .refine(
      (turns) => new Set(turns.map((turn) => turn.turnId)).size === turns.length,
      'Affected turns must be duplicate-free',
    ),
  providerSessionId: ProviderIdSchema,
  runtimeIncarnationId: HostIdSchema,
  managedServerInstanceId: HostIdSchema.optional(),
}).strict();

const AgentSessionControlFailureV1Schema = z.union([
  z.object({
    status: z.enum(['rejected', 'unavailable']),
    diagnostic: PluginDiagnosticDataSchema,
    retryable: z.boolean(),
  }).strict(),
  z.object({ status: z.literal('unsupported'), diagnostic: PluginDiagnosticDataSchema }).strict(),
]);

export const AgentSessionConversationRollbackResultV1Schema = z.union([
  z.object({ status: z.literal('applied') }).strict(),
  z.object({ status: z.literal('outcomeUnknown'), diagnostic: PluginDiagnosticDataSchema }).strict(),
  AgentSessionControlFailureV1Schema,
]);

export const AgentSessionConversationRollbackReconciliationResultV1Schema = z.union([
  z.object({ status: z.enum(['applied', 'notApplied']) }).strict(),
  z.object({ status: z.literal('outcomeUnknown'), diagnostic: PluginDiagnosticDataSchema }).strict(),
  z.object({
    status: z.literal('unavailable'),
    diagnostic: PluginDiagnosticDataSchema,
    retryable: z.boolean(),
  }).strict(),
]);

export type AgentSessionRuntimeEvent = z.infer<typeof AgentSessionRuntimeEventV1Schema>;
export type AgentSessionRuntimeEventV1 = AgentSessionRuntimeEvent;
export type AgentLaunchEnvironmentV1 = z.infer<typeof AgentLaunchEnvironmentV1Schema>;
export type AgentConfigurationScalarV1 = z.infer<typeof AgentConfigurationScalarV1Schema>;
export type AgentPermissionIntentV1 = z.infer<typeof AgentPermissionIntentV1Schema>;
export type AgentSessionConfigurationSnapshotV1 = z.infer<
  typeof AgentSessionConfigurationSnapshotV1Schema
>;
export const AGENT_SESSION_RUNTIME_EVENT_KINDS_V1 = Object.freeze([
  'input-accepted',
  'input-rejected',
  'input-custody-unknown',
  'input-delivery-failed',
  'provider-session-id',
  'turn-start',
  'turn-progress',
  'turn-agent-id-observed',
  'turn-complete',
  'turn-failed',
  'turn-cancelled',
  'runtime-ended',
  'runtime-activity-snapshot',
  'message-delta',
  'tool-call',
  'tool-progress',
  'tool-result',
  'transcript-message-committed',
  'file-edit',
  'usage-observed',
  'turn-rollback-boundary',
  'context-compaction',
] as const satisfies readonly AgentSessionRuntimeEventV1['kind'][]);
export type AgentSessionSendRequest = z.infer<typeof AgentSessionSendRequestV1Schema>;
export type AgentSessionSendRequestV1 = AgentSessionSendRequest;
export type AgentSessionCompactRequest = z.infer<typeof AgentSessionCompactRequestV1Schema>;
export type AgentSessionCompactRequestV1 = AgentSessionCompactRequest;
export type AgentSessionConversationRollbackRequest = z.infer<
  typeof AgentSessionConversationRollbackRequestV1Schema
>;
export type AgentSessionConversationRollbackRequestV1 = AgentSessionConversationRollbackRequest;
export type AgentSessionConversationRollbackResult = z.infer<
  typeof AgentSessionConversationRollbackResultV1Schema
>;
export type AgentSessionConversationRollbackResultV1 = AgentSessionConversationRollbackResult;
export type AgentSessionConversationRollbackReconciliationResult = z.infer<
  typeof AgentSessionConversationRollbackReconciliationResultV1Schema
>;
export type AgentSessionConversationRollbackReconciliationResultV1 =
  AgentSessionConversationRollbackReconciliationResult;
