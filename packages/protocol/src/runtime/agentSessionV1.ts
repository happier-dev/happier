import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from './agentSessionLimitsV1.js';
import {
  AgentSessionProviderBindingV1Schema,
  type AgentSessionProviderBindingV1,
} from '../providers/sessions/agentSessionProviderBindingV1.js';
import { SessionInputCausalPermissionAuthorityV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import {
  AgentPermissionIntentV1Schema,
  AgentSessionToolPolicyShapeV1,
  type AgentPermissionIntentV1 as CanonicalAgentPermissionIntentV1,
} from './permissionIntentV1.js';
import { SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX } from '../sessions/runtime/activity/sessionRuntimeActivity.js';
import { StrictJsonValueSchema, withStrictJsonInput, type JsonValue as StrictJsonValue } from '../json/strictJsonValue.js';
import { AGENT_SESSION_RUNTIME_EVENT_KINDS_V1 } from './eventKindsV1.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { AgentRuntimeDiagnosticDataV1Schema } from './agentRuntimeDiagnosticV1.js';
import { NonBlankOpaqueIdentifierSchema } from '../strings/opaqueIdentifier.js';
import { UsagePromptCacheSchema, UsageRequestAttributionSchema } from '../usage/usageAnalyticsContracts.js';
import { McpToolLaunchPoliciesV1Schema, type McpToolLaunchPolicyV1 } from '../mcp/servers/tools/resolveMcpToolDecisionV1.js';
import { TranscriptPeerSenderV1Schema } from '../sessions/messages/transcriptPeerSenderV1.js';

export { AGENT_SESSION_RUNTIME_EVENT_KINDS_V1 } from './eventKindsV1.js';
export { AgentRuntimeDiagnosticDataV1Schema } from './agentRuntimeDiagnosticV1.js';

const HOST_ID_MAX = LIMITS.hostIndexedIdMaxCodeUnits;
const PROVIDER_ID_MAX = LIMITS.providerIdMaxCodeUnits;
const INPUT_IDS_MAX = LIMITS.inputIdsMaxItems;
const NAME_MAX = LIMITS.toolNameMaxCodeUnits;
const MODEL_ID_MAX = LIMITS.modelIdMaxCodeUnits;
const SOURCE_MAX = LIMITS.usageSourceMaxCodeUnits;
const PATH_MAX = LIMITS.filePathMaxCodeUnits;
const DESCRIPTION_MAX = LIMITS.descriptionMaxCodeUnits;
const INPUT_TEXT_CANDIDATE_MAX = LIMITS.p0MeasuredCandidates.inputTextMaxCodeUnits;
const TRANSCRIPT_TEXT_CANDIDATE_MAX = LIMITS.p0MeasuredCandidates.transcriptTextMaxCodeUnits;
const COMPACT_INSTRUCTIONS_MAX = LIMITS.compactInstructionsMaxCodeUnits;
const EVENT_JSON_BYTES_CANDIDATE_MAX = LIMITS.p0MeasuredCandidates.eventMaxJsonBytes;
const SEND_JSON_BYTES_CANDIDATE_MAX = LIMITS.p0MeasuredCandidates.sendRequestMaxJsonBytes;

function exactString(max: number) {
  return z.string().check(z.minLength(1), maxCodeUnits(max), z.refine((value) => value === value.trim(), 'Identifiers must not contain leading or trailing whitespace'));
}

function opaqueNonBlankString(max: number) {
  return lazyZodSchema(() => NonBlankOpaqueIdentifierSchema.check(maxCodeUnits(max)));
}

const HostIdSchema = lazyZodSchema(() => exactString(HOST_ID_MAX));
/**
 * Identifiers the Agent mints — session, turn, tool-call, message, edit and
 * observation ids. Happier correlates and replays them, never re-canonicalizes
 * them, so they are validated for presence and carried byte for byte.
 */
const ProviderIdSchema = lazyZodSchema(() => opaqueNonBlankString(PROVIDER_ID_MAX));
const InputIdSchema = lazyZodSchema(() => opaqueNonBlankString(HOST_ID_MAX));
const SafeIntegerSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(LIMITS.safeIntegerMax)));
/**
 * The strict runtime JSON value used at admission boundaries. Aggregate byte
 * limits belong to a real transport, persistence, or external contract owner;
 * this shared vocabulary enforces JSON safety without inventing one.
 */
export const AgentRuntimeJsonValueV1Schema: z.ZodMiniType<StrictJsonValue, unknown> = StrictJsonValueSchema;

/**
 * The strict JSON value on the canonical runtime **event** union, where
 * the boundary is the event's own `eventMaxJsonBytes` ceiling and nothing else.
 *
 * The distinction remains important. `AgentSessionRuntimeEventV1Schema` is parsed
 * on read — Host Event dispatch (`plugins/events/hostV1.ts`), external-session
 * transcript replay (`apps/cli/src/session/external/terminalFollowProjection.ts`)
 * — so a tool payload that was admissible when the event was written has to
 * stay readable. Applying a smaller unrelated ceiling here would retroactively
 * refuse already-written payloads; a ~1.5 MB tool result is an ordinary size
 * for a file read or a search. The event bound is
 * the ceiling that was in force when the event was produced, so it is the only
 * one a reader may enforce.
 */
const AgentRuntimeEventJsonValueV1Schema: z.ZodMiniType<StrictJsonValue, unknown> = StrictJsonValueSchema;
export const AgentRuntimeJsonValueSchema = AgentRuntimeJsonValueV1Schema;

export const AgentSessionProviderCheckpointMaxJsonBytesV1 = 4_096;
export const AgentSessionProviderCheckpointV1Schema = lazyZodSchema(() => AgentRuntimeJsonValueV1Schema.check(zMini.refine((value) => (
    new TextEncoder().encode(JSON.stringify(value)).byteLength
    <= AgentSessionProviderCheckpointMaxJsonBytesV1
  ), 'Provider checkpoint exceeds the Agent session byte bound')));
export type AgentSessionProviderCheckpointV1 = z.infer<
  typeof AgentSessionProviderCheckpointV1Schema
>;

const TimestampedAgentValueV1Schema = <ValueSchema extends z.core.SomeType>(
  value: ValueSchema,
) => z.strictObject({
  value,
  updatedAtMs: SafeIntegerSchema,
});

const AgentLaunchEnvironmentCoreV1Schema = lazyZodSchema(() => z.strictObject({
  values: z.record(exactString(HOST_ID_MAX), z.string()),
  unset: z.array(exactString(HOST_ID_MAX)),
}).check(z.superRefine((value, context) => {
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
})));

export const AgentLaunchEnvironmentV1Schema = lazyZodSchema(() => zMini.pipe(AgentRuntimeJsonValueV1Schema, AgentLaunchEnvironmentCoreV1Schema));

const AgentConfigurationScalarV1Schema = lazyZodSchema(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]));
export {
  AGENT_PERMISSION_INTENTS_V1,
  AgentPermissionIntentV1Schema,
  parseAgentPermissionIntentV1Alias,
} from './permissionIntentV1.js';
export const AgentSessionProviderResumeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('provider_session.v1'),
  providerSessionId: ProviderIdSchema,
}));
export type AgentSessionProviderResumeV1 = z.infer<typeof AgentSessionProviderResumeV1Schema>;

export { AgentSessionToolPolicyShapeV1 } from './permissionIntentV1.js';

const AgentSessionConfigurationSnapshotCoreV1Schema = lazyZodSchema(() => z.strictObject({
  ...AgentSessionToolPolicyShapeV1,
  mode: TimestampedAgentValueV1Schema(z.nullable(exactString(MODEL_ID_MAX))),
  model: TimestampedAgentValueV1Schema(z.nullable(exactString(MODEL_ID_MAX))),
  permissionIntent: TimestampedAgentValueV1Schema(zMini.nullable(asProtocolZod(AgentPermissionIntentV1Schema))),
  /** Host role restriction; independent of the permission intent used as delegation ceiling. */
  workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
  options: z.record(
    exactString(HOST_ID_MAX),
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

const EventBaseSchema = lazyZodSchema(() => z.strictObject({
  sequence: SafeIntegerSchema,
  sessionId: HostIdSchema,
  emittedAtMs: SafeIntegerSchema,
}));

export const SESSION_RUNTIME_ACTIVITY_SLOT_ACTIVE_COUNT_MAX = Math.floor(
  SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX / 2,
);
const SessionRuntimeActivitySlotActiveCountSchema = lazyZodSchema(() => SafeIntegerSchema.check(z.maximum(SESSION_RUNTIME_ACTIVITY_SLOT_ACTIVE_COUNT_MAX)));
const RuntimeActivitySnapshotEventSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EventBaseSchema, {
  kind: z.literal('runtime-activity-snapshot'),
  state: z.enum(['active', 'idle', 'unknown']),
  activeCount: SessionRuntimeActivitySlotActiveCountSchema,
})).check(z.superRefine((value, context) => {
  if (value.state === 'active') {
    if (value.activeCount <= 0) {
      context.addIssue({ code: 'custom', path: ['activeCount'], message: 'Active snapshots require a positive count' });
    }
    return;
  }
  if (value.activeCount !== 0) {
    context.addIssue({ code: 'custom', path: ['activeCount'], message: 'Idle and unknown snapshots require a zero count' });
  }
})));

const TurnEventBaseShape = {
  sequence: SafeIntegerSchema,
  sessionId: HostIdSchema,
  emittedAtMs: SafeIntegerSchema,
  turnId: HostIdSchema,
  agentTurnId: zMini.optional(ProviderIdSchema),
};

const InputIdsSchema = lazyZodSchema(() => z.tuple([InputIdSchema], InputIdSchema).check(z.refine((ids) => ids.length <= INPUT_IDS_MAX, 'Input id tuple limit exceeded'), z.refine((ids) => new Set(ids).size === ids.length, 'Input ids must be duplicate-free')));

const UsageTokensSchema = lazyZodSchema(() => z.strictObject({
  input: SafeIntegerSchema,
  output: SafeIntegerSchema,
  reasoning: SafeIntegerSchema,
  cacheRead: SafeIntegerSchema,
  cacheWrite: SafeIntegerSchema,
  total: SafeIntegerSchema,
}));

const UsageCostSchema = lazyZodSchema(() => z.strictObject({
  reportedUsd: z.number().check(z.nonnegative()),
  estimatedUsd: z.number().check(z.nonnegative()),
  invoiceUsd: z.optional(z.number().check(z.nonnegative())),
  billingContext: z.optional(z.enum([
    'api_usage',
    'subscription_included',
    'subscription_with_possible_overage',
    'unknown',
  ])),
  costSource: z.optional(z.enum([
    'provider_reported',
    'provider_reported_api_equivalent',
    'pricing_estimate',
    'invoice',
    'none',
  ])),
  currency: exactString(LIMITS.usage.currencyMaxCodeUnits),
  breakdown: z.optional(z.record(
    exactString(LIMITS.usage.breakdownKeyMaxCodeUnits),
    z.number().check(z.nonnegative()),
  ).check(z.refine((value) => Object.keys(value).length <= LIMITS.usage.breakdownMaxEntries, 'Usage breakdown entry limit exceeded'))),
  effectiveUsd: z.optional(z.number().check(z.nonnegative())),
}));

const ContextUsageSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  modelId: z.nullable(exactString(MODEL_ID_MAX)),
  usedTokens: SafeIntegerSchema,
  windowTokens: z.nullable(SafeIntegerSchema),
  totalProcessedTokens: z.nullable(SafeIntegerSchema),
  baselineTokens: z.nullable(SafeIntegerSchema),
  isAutoCompactEnabled: z.nullable(z.boolean()),
  categories: z.nullable(z.array(z.strictObject({
    key: exactString(LIMITS.usage.contextCategoryKeyMaxCodeUnits),
    label: z.nullable(z.string().check(maxCodeUnits(LIMITS.usage.contextCategoryLabelMaxCodeUnits))),
    tokens: SafeIntegerSchema,
  })).check(z.maxLength(LIMITS.usage.contextCategoriesMaxItems))),
  observedAtMs: SafeIntegerSchema,
  source: z.enum(['provider_live', 'provider_turn', 'derived_estimate']),
}));

const UsageMeasurementShape = {
  promptCache: z.optional(UsagePromptCacheSchema),
  tokens: z.optional(UsageTokensSchema),
  cost: z.optional(UsageCostSchema),
  context: z.optional(ContextUsageSchema),
};

const InputCustodySchemas = [
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EventBaseSchema, {
    kind: z.literal('input-accepted'),
    inputIds: InputIdsSchema,
    delivery: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('newTurn'), turnId: HostIdSchema }),
      z.strictObject({ kind: z.literal('followUp'), turnId: HostIdSchema }),
      z.strictObject({ kind: z.literal('steer'), turnId: HostIdSchema }),
    ]),
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EventBaseSchema, {
    kind: z.literal('input-rejected'),
    inputIds: InputIdsSchema,
    diagnostic: AgentRuntimeDiagnosticDataV1Schema,
    retryable: z.boolean(),
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EventBaseSchema, {
    kind: z.literal('input-custody-unknown'),
    inputIds: InputIdsSchema,
    issue: AgentRuntimeDiagnosticDataV1Schema,
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EventBaseSchema, {
    kind: z.literal('input-delivery-failed'),
    inputIds: InputIdsSchema,
    delivery: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('newTurn'), turnId: HostIdSchema }),
      z.strictObject({ kind: z.literal('followUp'), turnId: HostIdSchema }),
    ]),
    issue: AgentRuntimeDiagnosticDataV1Schema,
    duplicateRisk: z.enum(['possible', 'likely', 'unknown']),
  }))),
] as const;

const LifecycleSchemas = [
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EventBaseSchema, {
    kind: z.literal('provider-session-id'),
    providerSessionId: ProviderIdSchema,
    /**
     * Where this Agent keeps its OWN session log for the id in this event, when
     * the runtime knows the path. MACHINE-LOCAL: it is only meaningful on the
     * machine that produced it.
     *
     * It rides the same event as the id because the path names one specific
     * conversation — published on its own it could be matched to a later,
     * different id and would then point a reader at the wrong log. Omitted
     * means "no log path", never "unchanged".
     *
     * This is a POINTER, not a resume gate (`AM-24`): its only consumer is the
     * handoff brief, which offers the successor Agent the predecessor's log.
     */
    nativeSessionLogPath: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4_096))),
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EventBaseSchema, {
    kind: z.literal('available-commands'),
    commands: z.array(z.strictObject({
      name: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
      description: z.optional(z.string().check(z.maxLength(20_000))),
    })).check(z.maxLength(4_096)),
  }))),
  lazyZodSchema(() => z.strictObject({
    ...TurnEventBaseShape,
    kind: z.literal('turn-start'),
    startedBy: z.enum(['host', 'provider']),
    causedByTurnId: z.optional(HostIdSchema),
  })),
  lazyZodSchema(() => z.strictObject({ ...TurnEventBaseShape, kind: z.literal('turn-progress') })),
  lazyZodSchema(() => z.strictObject({ ...TurnEventBaseShape, kind: z.literal('turn-agent-id-observed'), agentTurnId: ProviderIdSchema })),
  lazyZodSchema(() => z.strictObject({ ...TurnEventBaseShape, kind: z.literal('turn-complete') })),
  lazyZodSchema(() => z.strictObject({ ...TurnEventBaseShape, kind: z.literal('turn-failed'), diagnostic: AgentRuntimeDiagnosticDataV1Schema })),
  lazyZodSchema(() => z.strictObject({
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
    diagnostic: zMini.optional(AgentRuntimeDiagnosticDataV1Schema),
  })),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EventBaseSchema, {
    kind: z.literal('runtime-ended'),
    cause: z.enum(['providerEnded', 'connectionLost', 'processExited', 'protocolError', 'unknown']),
    retryable: z.boolean(),
    diagnostic: zMini.optional(AgentRuntimeDiagnosticDataV1Schema),
  }))),
] as const;

const OutputSchemas = [
  lazyZodSchema(() => z.strictObject({
    ...TurnEventBaseShape, kind: z.literal('skill-usage'),
    skills: z.array(z.strictObject({ name: exactString(NAME_MAX), path: z.optional(exactString(PATH_MAX)) })),
  })),
  lazyZodSchema(() => z.strictObject({
    ...TurnEventBaseShape, kind: z.literal('mcp-tool-usage'),
    queuedTurnCount: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    window: z.strictObject({ startMs: z.number().check(z.int(), z.nonnegative(), z.int()), endMs: z.number().check(z.int(), z.nonnegative(), z.int()) }),
    coverage: z.enum(['complete', 'partial']),
    servers: z.array(z.strictObject({ serverName: exactString(NAME_MAX), toolCallCount: z.number().check(z.int(), z.nonnegative(), z.int()),
      schemaBytes: z.nullable(z.number().check(z.int(), z.nonnegative(), z.int())) })),
  })),
  lazyZodSchema(() => z.strictObject({
    ...TurnEventBaseShape,
    turnId: z.optional(HostIdSchema),
    kind: z.literal('message-delta'),
    messageId: zMini.optional(ProviderIdSchema),
    channel: z.enum(['assistant', 'reasoning']),
    text: z.string(),
    sidechainId: z.optional(HostIdSchema),
  })),
  lazyZodSchema(() => z.strictObject({
    ...TurnEventBaseShape,
    turnId: z.optional(HostIdSchema),
    kind: z.literal('tool-call'),
    toolCallId: ProviderIdSchema,
    toolName: exactString(NAME_MAX),
    input: AgentRuntimeEventJsonValueV1Schema,
    sidechainId: z.optional(HostIdSchema),
  })),
  lazyZodSchema(() => z.strictObject({
    ...TurnEventBaseShape,
    turnId: z.optional(HostIdSchema),
    kind: z.literal('tool-progress'),
    toolCallId: ProviderIdSchema,
    progress: AgentRuntimeEventJsonValueV1Schema,
    sidechainId: z.optional(HostIdSchema),
  })),
  lazyZodSchema(() => z.strictObject({
    ...TurnEventBaseShape,
    turnId: z.optional(HostIdSchema),
    kind: z.literal('tool-result'),
    toolCallId: ProviderIdSchema,
    output: AgentRuntimeEventJsonValueV1Schema,
    isError: z.optional(z.boolean()),
    sidechainId: z.optional(HostIdSchema),
  })),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EventBaseSchema, {
    kind: z.literal('transcript-message-committed'),
    messageId: ProviderIdSchema,
    role: z.enum(['user', 'assistant', 'reasoning']),
    text: z.string().check(maxCodeUnits(TRANSCRIPT_TEXT_CANDIDATE_MAX)),
    turnId: z.optional(HostIdSchema),
    sidechainId: z.optional(HostIdSchema),
    /** Assistant-channel text delivered by another agent (teammate or subagent hand-back), not the Agent's reply. */
    peer: z.optional(TranscriptPeerSenderV1Schema),
  }).check(z.refine((value) => value.peer === undefined || (value.role === 'assistant' && value.turnId === undefined),
    'Peer-delivered text is Session-scoped assistant-channel text')))),
  lazyZodSchema(() => z.strictObject({
    ...TurnEventBaseShape,
    turnId: z.optional(HostIdSchema),
    kind: z.literal('file-edit'),
    editId: ProviderIdSchema,
    path: z.string().check(maxCodeUnits(PATH_MAX)),
    description: z.optional(z.string().check(maxCodeUnits(DESCRIPTION_MAX))),
    diff: z.optional(z.string().check(maxCodeUnits(LIMITS.p0MeasuredCandidates.fileEditMemberMaxCodeUnits))),
    oldContent: z.optional(z.string().check(maxCodeUnits(LIMITS.p0MeasuredCandidates.fileEditMemberMaxCodeUnits))),
    newContent: z.optional(z.string().check(maxCodeUnits(LIMITS.p0MeasuredCandidates.fileEditMemberMaxCodeUnits))),
    sidechainId: z.optional(HostIdSchema),
  }).check(z.refine((value) => jsonByteLength({
      diff: value.diff,
      oldContent: value.oldContent,
      newContent: value.newContent,
    }) <= LIMITS.p0MeasuredCandidates.fileEditContentMaxJsonBytes, 'File-edit content exceeds the CORE-A candidate byte bound'))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EventBaseSchema, {
    kind: z.literal('usage-observed'),
    observationId: ProviderIdSchema,
    attribution: zMini.optional(UsageRequestAttributionSchema),
    turnId: z.optional(HostIdSchema),
    source: exactString(SOURCE_MAX),
    scope: z.enum(['turn_delta', 'session_cumulative', 'session_final']),
    modelId: z.optional(exactString(MODEL_ID_MAX)),
    accounting: z.optional(z.strictObject({
      nativeSessionId: zMini.optional(ProviderIdSchema),
      inferenceId: zMini.optional(ProviderIdSchema),
      inputIncludesCache: z.optional(z.boolean()),
      outputIncludesReasoning: z.optional(z.boolean()),
      historyComplete: z.optional(z.boolean()),
    })),
    ...UsageMeasurementShape,
  })).check(z.refine((value) => value.tokens !== undefined || value.cost !== undefined || value.context !== undefined, 'At least one usage measurement is required'))),
  lazyZodSchema(() => z.strictObject({
    ...TurnEventBaseShape,
    kind: z.literal('turn-rollback-boundary'),
    agentRollbackOrdinal: z.optional(SafeIntegerSchema),
    providerCheckpoint: zMini.optional(AgentSessionProviderCheckpointV1Schema),
  })),
] as const;

const CompactionCommonShape = {
  sequence: SafeIntegerSchema,
  sessionId: HostIdSchema,
  emittedAtMs: SafeIntegerSchema,
  kind: lazyZodSchema(() => z.literal('context-compaction')),
  compactionId: HostIdSchema,
  turnId: z.optional(HostIdSchema),
  trigger: lazyZodSchema(() => z.enum(['manual', 'idle', 'automatic', 'threshold', 'overflow', 'unknown'])),
  retryAttempt: z.optional(SafeIntegerSchema),
};

const TokenCountSourceSchema = lazyZodSchema(() => z.enum(['providerReported', 'providerEstimated', 'derivedEstimate']));
const CompactionSchemas = [
  lazyZodSchema(() => z.strictObject({
    ...CompactionCommonShape,
    phase: z.literal('started'),
    tokenCountBefore: z.optional(SafeIntegerSchema),
    tokenCountSource: z.optional(TokenCountSourceSchema),
  }).check(z.superRefine((value, context) => {
    if ((value.tokenCountBefore === undefined) !== (value.tokenCountSource === undefined)) {
      context.addIssue({ code: 'custom', message: 'Token count and source must be supplied together' });
    }
  }))),
  lazyZodSchema(() => z.strictObject({ ...CompactionCommonShape, phase: z.literal('progress') })),
  lazyZodSchema(() => z.strictObject({
    ...CompactionCommonShape,
    phase: z.literal('completed'),
    tokenCountBefore: z.optional(SafeIntegerSchema),
    tokenCountAfter: z.optional(SafeIntegerSchema),
    tokenCountSource: z.optional(TokenCountSourceSchema),
    continuation: z.optional(z.literal('paused')),
    pauseReason: z.optional(z.literal('agentIdleAfterCompaction')),
  }).check(z.superRefine((value, context) => {
    const hasCount = value.tokenCountBefore !== undefined || value.tokenCountAfter !== undefined;
    if (hasCount !== (value.tokenCountSource !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Token counts require their source' });
    }
    if (value.pauseReason !== undefined && value.continuation !== 'paused') {
      context.addIssue({ code: 'custom', message: 'Pause reason requires paused continuation' });
    }
  }))),
  lazyZodSchema(() => z.strictObject({ ...CompactionCommonShape, phase: z.literal('failed'), diagnostic: AgentRuntimeDiagnosticDataV1Schema })),
  lazyZodSchema(() => z.strictObject({ ...CompactionCommonShape, phase: z.literal('cancelled'), diagnostic: zMini.optional(AgentRuntimeDiagnosticDataV1Schema) })),
  lazyZodSchema(() => z.strictObject({ ...CompactionCommonShape, phase: z.literal('outcomeUnknown'), diagnostic: AgentRuntimeDiagnosticDataV1Schema })),
] as const;

const AgentSessionRuntimeNonCompactionEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ...InputCustodySchemas,
  ...LifecycleSchemas,
  ...OutputSchemas,
  RuntimeActivitySnapshotEventSchema,
]));
const AgentSessionCompactionEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('phase', CompactionSchemas));
const AgentSessionRuntimeEventCoreV1Schema = lazyZodSchema(() => z.union([
  AgentSessionRuntimeNonCompactionEventV1Schema,
  AgentSessionCompactionEventV1Schema,
]));

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export const AgentSessionRuntimeEventV1Schema = lazyZodSchema(() => AgentSessionRuntimeEventCoreV1Schema.check(z.superRefine((value, context) => {
  if (jsonByteLength(value) > EVENT_JSON_BYTES_CANDIDATE_MAX) {
    context.addIssue({ code: 'custom', message: 'Agent runtime event exceeds the CORE-A candidate byte bound' });
  }
})));
export const AgentSessionRuntimeEventSchema = AgentSessionRuntimeEventV1Schema;

const AgentSessionInputV1Schema = lazyZodSchema(() => z.strictObject({
  text: z.string().check(maxCodeUnits(INPUT_TEXT_CANDIDATE_MAX)),
  structuredInput: zMini.optional(AgentRuntimeJsonValueV1Schema),
}));

const AgentSessionDeliveryV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('newTurn'), turnId: HostIdSchema }),
  z.strictObject({ kind: z.literal('steer'), turnId: HostIdSchema }),
  z.strictObject({ kind: z.literal('followUp'), turnId: HostIdSchema, afterTurnId: HostIdSchema }),
]));

export const AgentSessionSendRequestV1Schema = lazyZodSchema(() => z.strictObject({
  inputIds: InputIdsSchema,
  input: AgentSessionInputV1Schema,
  delivery: AgentSessionDeliveryV1Schema,
  /** Immutable authority for the exact admitted input; absent for legacy/host sends. */
  causalPermissionAuthority: zMini.optional(SessionInputCausalPermissionAuthorityV1Schema),
}).check(z.superRefine((value, context) => {
  if (jsonByteLength(value) > SEND_JSON_BYTES_CANDIDATE_MAX) {
    context.addIssue({ code: 'custom', message: 'Agent runtime send request exceeds the CORE-A candidate byte bound' });
  }
})));

export const AgentSessionCompactRequestV1Schema = lazyZodSchema(() => z.strictObject({
  compactionId: HostIdSchema,
  trigger: z.enum(['manual', 'idle']),
  instructions: z.optional(z.string().check(maxCodeUnits(COMPACT_INSTRUCTIONS_MAX))),
}));

const AgentSessionConversationRollbackAffectedTurnV1Schema = lazyZodSchema(() => z.strictObject({
  turnId: HostIdSchema,
  providerCheckpoint: zMini.optional(AgentSessionProviderCheckpointV1Schema),
}));

export const AgentSessionConversationRollbackRequestV1Schema = lazyZodSchema(() => z.strictObject({
  operationId: HostIdSchema,
  target: z.strictObject({ kind: z.literal('beforeTurn'), turnId: HostIdSchema }),
  affectedTurns: z.tuple(
    [AgentSessionConversationRollbackAffectedTurnV1Schema],
    AgentSessionConversationRollbackAffectedTurnV1Schema,
  ).check(z.refine((turns) => turns.length <= LIMITS.p0MeasuredCandidates.conversationRollbackMaxAffectedTurns, 'Conversation rollback affected-turn limit exceeded'), z.refine((turns) => new Set(turns.map((turn) => turn.turnId)).size === turns.length, 'Affected turns must be duplicate-free')),
  providerSessionId: ProviderIdSchema,
  runtimeIncarnationId: HostIdSchema,
  managedServerInstanceId: z.optional(HostIdSchema),
}));

const AgentSessionControlFailureV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    status: z.enum(['rejected', 'unavailable']),
    diagnostic: AgentRuntimeDiagnosticDataV1Schema,
    retryable: z.boolean(),
  }),
  z.strictObject({ status: z.literal('unsupported'), diagnostic: AgentRuntimeDiagnosticDataV1Schema }),
]));

export const AgentSessionConversationRollbackResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('applied') }),
  z.strictObject({ status: z.literal('outcomeUnknown'), diagnostic: AgentRuntimeDiagnosticDataV1Schema }),
  AgentSessionControlFailureV1Schema,
]));

export const AgentSessionConversationRollbackReconciliationResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['applied', 'notApplied']) }),
  z.strictObject({ status: z.literal('outcomeUnknown'), diagnostic: AgentRuntimeDiagnosticDataV1Schema }),
  z.strictObject({
    status: z.literal('unavailable'),
    diagnostic: AgentRuntimeDiagnosticDataV1Schema,
    retryable: z.boolean(),
  }),
]));

export type AgentSessionRuntimeEvent = z.infer<typeof AgentSessionRuntimeEventV1Schema>;
export type AgentSessionRuntimeEventV1 = AgentSessionRuntimeEvent;
AGENT_SESSION_RUNTIME_EVENT_KINDS_V1 satisfies readonly AgentSessionRuntimeEventV1['kind'][];
export type AgentLaunchEnvironmentV1 = z.infer<typeof AgentLaunchEnvironmentV1Schema>;
export type AgentConfigurationScalarV1 = z.infer<typeof AgentConfigurationScalarV1Schema>;
export type AgentPermissionIntentV1 = CanonicalAgentPermissionIntentV1;
export type AgentSessionConfigurationSnapshotV1 = z.infer<
  typeof AgentSessionConfigurationSnapshotV1Schema
>;
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
