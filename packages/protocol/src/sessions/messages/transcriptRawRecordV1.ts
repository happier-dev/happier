import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { z } from 'zod/mini';

import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceProfileIdSchema,
} from '../../connect/connectedServiceSchemas.js';
import {
  ConnectedAccountServiceKeyIngressSchema,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
} from '../../connect/connectedServiceBindings.js';
import { ConnectedServiceUxDiagnosticV1Schema } from '../../connect/connectedServiceUxDiagnostics.js';
import {
  SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY,
  readSessionAgentTransitionDividerV1,
} from '../agentTransitionDivider.js';
import { createSessionMessageMetaSchema } from './sessionMessageMeta.js';
import { SESSION_CAPABILITY_NOTICE_SIDECAR_KEY } from './sessionCapabilityNoticeV1.js';
import type { SessionMessageMeta } from './sessionMessageMeta.js';
import { AgentIdV1Schema } from '../../agents/agentIdV1.js';
import { WorkerUpdateV1Schema, SessionUpdatePostInputV1Schema, refineWorkerDeliverableResultV1 } from '../relations/workerUpdateV1.js';
import { UsagePromptCompositionSchema } from '../../usage/coach/usagePromptComposition.js';
import { UsageMcpBindingUsageSchema } from '../../usage/coach/usageMcpBindingUsage.js';
import { isSessionFollowWakeEventLocalId } from '../follow/sessionFollowTransportV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';

const UsageDataSchema = lazyZodSchema(() => z.looseObject({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.optional(z.number()),
    cache_read_input_tokens: z.optional(z.number()),
    output_tokens: z.number(),
    // Some upstream providers emit `service_tier: null` in error payloads.
    // Treat null as “unknown” so we don't drop the whole message.
    service_tier: z.nullish(z.string()),
  }));

const UsageDataBestEffortSchema = lazyZodSchema(() => z.pipe(z.optional(z
  .unknown()), z.transform((value) => {
    if (value === undefined) return undefined;
    const parsed = UsageDataSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  })));

const RawTextContentSchema = lazyZodSchema(() => z.looseObject({
    type: z.literal('text'),
    text: z.string(),
  }));

const RawToolUseContentSchema = lazyZodSchema(() => z.looseObject({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }));

const RawToolResultContentSchema = lazyZodSchema(() => z.looseObject({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.optional(z.boolean()),
    // Provider-specific; keep permissive for forward compatibility.
    permissions: z.optional(z.unknown()),
  }));

const RawThinkingContentSchema = lazyZodSchema(() => z.looseObject({
    type: z.literal('thinking'),
    thinking: z.string(),
  }));

// Forward compatibility: keep unknown content blocks instead of dropping the entire message.
// Callers can render these as a placeholder if needed.
const RawUnknownContentSchema = lazyZodSchema(() => z.looseObject({
    type: z.string(),
  }));

// Hyphenated tool-call formats seen in some providers (Codex/Gemini variants).
const RawHyphenatedToolCallSchema = lazyZodSchema(() => z.looseObject({
    type: z.literal('tool-call'),
    callId: z.string(),
    id: z.optional(z.string()),
    name: z.string(),
    input: z.unknown(),
  }));

const RawHyphenatedToolResultSchema = lazyZodSchema(() => z.looseObject({
    type: z.literal('tool-call-result'),
    callId: z.string(),
    tool_use_id: z.optional(z.string()),
    output: z.unknown(),
    content: z.optional(z.unknown()),
    is_error: z.optional(z.boolean()),
  }));

const RawAgentContentSchema = lazyZodSchema(() => z.union([
  RawTextContentSchema,
  RawToolUseContentSchema,
  RawToolResultContentSchema,
  RawThinkingContentSchema,
  RawHyphenatedToolCallSchema,
  RawHyphenatedToolResultSchema,
  RawUnknownContentSchema,
]));

function normalizeToToolUse(input: z.infer<typeof RawHyphenatedToolCallSchema>) {
  return {
    ...input,
    type: 'tool_use' as const,
    id: input.callId,
  };
}

function normalizeToToolResult(input: z.infer<typeof RawHyphenatedToolResultSchema>) {
  return {
    ...input,
    type: 'tool_result' as const,
    tool_use_id: input.callId,
    content: (input as any).output ?? (input as any).content ?? '',
    is_error: input.is_error ?? false,
  };
}

/**
 * Released ACP agent envelope shape from before the `provider` -> `agentId` rename.
 *
 * Source release: builds prior to commit `3dfbdc4330` (2026-07-10), whose writer
 * `apps/cli/src/api/session/acpMessageEnvelope.ts` emitted
 * `{ type: 'acp', provider, data }`. Those transcript rows are persisted in user history and are
 * still read back by every current reader, so this schema states the accepted legacy shape
 * explicitly rather than relaxing the canonical envelope.
 *
 * `agentId: z.optional(z.undefined())` keeps the canonical key authoritative: a record that already carries
 * `agentId` is not a legacy record and is never rewritten from `provider`. Anything that does not
 * match this exact shape stays unaccepted and still falls through to the caller's unsupported /
 * unparsed handling.
 *
 * Removal condition: drop this branch once no supported release can still hold ACP transcript rows
 * written before 2026-07-10.
 */
const LegacyAcpAgentEnvelopeV1Schema = lazyZodSchema(() => z.looseObject({
    type: z.literal('acp'),
    agentId: z.optional(z.undefined()),
    provider: z.string().check(z.trim(), z.minLength(1)),
  }));

function preprocessMessageContent(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;

  const normalizeContent = (item: any): any => {
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'tool-call' && typeof item.callId === 'string' && item.callId.trim().length > 0) {
      return normalizeToToolUse(item);
    }
    if (item.type === 'tool-call-result' && typeof item.callId === 'string' && item.callId.trim().length > 0) {
      return normalizeToToolResult(item);
    }
    return item;
  };

  const record: any = data;
  const maybeArray = (value: unknown) => (Array.isArray(value) ? value : null);

  if (record.role === 'agent' && record.content?.type === 'output') {
    const assistantContent = maybeArray(record.content?.data?.message?.content);
    if (assistantContent) {
      record.content.data.message.content = assistantContent.map(normalizeContent);
    }

    const userContent = maybeArray(record.content?.data?.message?.content);
    if (record.content?.data?.type === 'user' && userContent) {
      record.content.data.message.content = userContent.map(normalizeContent);
    }

    // Forward compatibility: usage payloads are unstable and frequently evolve.
    // If usage doesn't match our structured schema, drop it so the record still parses.
    const usage = record.content?.data?.message?.usage;
    if (usage !== undefined) {
      const usageParsed = UsageDataSchema.safeParse(usage);
      if (!usageParsed.success) {
        try {
          delete record.content.data.message.usage;
        } catch {
          // Ignore if we can't delete (e.g. frozen object); parsing will still succeed via passthrough.
        }
      }
    }
  }

  if (record.role === 'agent' && record.content?.type === 'acp') {
    const legacyEnvelope = LegacyAcpAgentEnvelopeV1Schema.safeParse(record.content);
    if (legacyEnvelope.success) {
      // Project the released legacy key onto the canonical one without mutating the caller-owned
      // persisted record, and keep `provider` so nothing downstream loses the original bytes.
      return { ...record, content: { ...record.content, agentId: legacyEnvelope.data.provider } };
    }
  }

  return record;
}

type OpaqueOutputDataType = string & { readonly __happierOpaqueOutputDataType: unique symbol };

const OutputExtrasShape = {
  isSidechain: z.nullish(z.boolean()),
  isCompactSummary: z.nullish(z.boolean()),
  isMeta: z.nullish(z.boolean()),
  uuid: z.nullish(z.string()),
  parentUuid: z.nullish(z.string()),
} as const;

const withOutputExtras = <T extends z.core.$ZodShape>(schema: z.ZodMiniObject<T>) =>
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(schema, OutputExtrasShape));

const RawAgentOutputDataKnownSchema = lazyZodSchema(() => z.discriminatedUnion('type', [
  withOutputExtras(z.object({ type: z.literal('system') })),
  withOutputExtras(z.object({ type: z.literal('result') })),
  withOutputExtras(z.object({ type: z.literal('summary'), summary: z.string() })),
  withOutputExtras(z.object({ type: z.literal('progress') })),
  withOutputExtras(
    z.object({
      type: z.literal('assistant'),
      message: z.looseObject({
          role: z.literal('assistant'),
          model: z.optional(z.string()),
          content: z.union([z.array(RawAgentContentSchema), z.string()]),
          // Usage is best-effort: do not reject the whole message if upstream changes the usage shape.
          usage: UsageDataBestEffortSchema,
        }),
      parent_tool_use_id: z.optional(z.nullable(z.string())),
    }),
  ),
  withOutputExtras(
    z.object({
      type: z.literal('user'),
      message: z.looseObject({
          role: z.literal('user'),
          content: z.union([z.string(), z.array(RawAgentContentSchema)]),
        }),
      parent_tool_use_id: z.optional(z.nullable(z.string())),
      toolUseResult: z.optional(z.nullable(z.unknown())),
    }),
  ),
]));

const RawAgentOutputDataOpaqueSchema = lazyZodSchema(() => z.pipe((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(z
  .object({ type: z.string() }), OutputExtrasShape)), z.transform((value) => ({ ...value, type: value.type as OpaqueOutputDataType }))));

const RawAgentOutputDataSchema = lazyZodSchema(() => z.union([RawAgentOutputDataKnownSchema, RawAgentOutputDataOpaqueSchema]));

const TurnLifecycleEventV1Schema = lazyZodSchema(() => z.enum([
  'task_started',
  'task_complete',
  'turn_failed',
  'turn_cancelled',
  'turn_aborted',
]));

const ContextCompactionPhaseSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => value === 'detected' ? 'completed' : value), z.enum(['started', 'progress', 'completed', 'failed', 'cancelled'])));

const ContextCompactionSourceSchema = lazyZodSchema(() => z.enum([
  'agent-event',
  'agent-status',
  'agent-hook',
  'transcript-inference',
  'user-command',
  'runtime',
]));

const ContextCompactionShape = {
  phase: ContextCompactionPhaseSchema,
  lifecycleId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  backendId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  trigger: z.optional(z.enum(['manual', 'auto', 'idle', 'threshold', 'overflow', 'unknown'])),
  source: z.optional(ContextCompactionSourceSchema),
  agentEventId: z.optional(z.string()),
  agentSessionId: z.optional(z.string()),
  turnId: z.optional(z.string()),
  tokenCountBefore: z.optional(z.number()),
  tokenCountAfter: z.optional(z.number()),
  tokenCountSource: z.optional(z.string()),
  retryAttempt: z.optional(z.number().check(z.int(), z.nonnegative())),
  errorCode: z.optional(z.string()),
  sanitizedErrorPreview: z.optional(z.string()),
  continuation: z.optional(z.literal('paused')),
  pauseReason: z.optional(z.literal('agent-idle-after-compaction')),
} as const;

function readContextCompactionEventDataFromRawRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.role !== 'agent') return null;
  const content = record.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const contentRecord = content as Record<string, unknown>;
  const data = contentRecord.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const dataRecord = data as Record<string, unknown>;
  if (dataRecord.type !== 'context-compaction') return null;
  return contentRecord.type === 'event' || contentRecord.type === 'acp' ? dataRecord : null;
}

function addContextCompactionEventContinuationIssues(
  event: Record<string, unknown>,
  ctx: z.core.$RefinementCtx,
  pathPrefix: readonly (string | number)[],
): void {
  if (event.continuation === 'paused' && event.phase !== 'completed') {
    ctx.addIssue({
      code: "custom",
      path: [...pathPrefix, 'continuation'],
      message: 'Context compaction paused continuation is only valid for completed phases',
    });
  }

  if (event.pauseReason !== undefined && event.continuation !== 'paused') {
    ctx.addIssue({
      code: "custom",
      path: [...pathPrefix, 'pauseReason'],
      message: 'Context compaction pause reason requires paused continuation',
    });
  }
}

function addRawRecordContextCompactionContinuationIssues(value: unknown, ctx: z.core.$RefinementCtx): void {
  const event = readContextCompactionEventDataFromRawRecord(value);
  if (!event) return;

  addContextCompactionEventContinuationIssues(event, ctx, ['content', 'data']);
}

export const ConnectedServiceSwitchAttemptedContinuityModeV1Schema = lazyZodSchema(() => z.enum([
  'hot_apply',
  'restart',
  'metadata_only',
  'credential_refresh',
]));

export type ConnectedServiceSwitchAttemptedContinuityModeV1 =
  z.infer<typeof ConnectedServiceSwitchAttemptedContinuityModeV1Schema>;

export const ConnectedServiceSwitchAttemptOutcomeV1Schema = lazyZodSchema(() => z.enum([
  'succeeded',
  'failed',
  'observed',
  'scheduled_retry',
  'terminal',
]));

export type ConnectedServiceSwitchAttemptOutcomeV1 =
  z.infer<typeof ConnectedServiceSwitchAttemptOutcomeV1Schema>;

export const ConnectedServiceSwitchAttemptOutcomeActionV1Schema = lazyZodSchema(() => z.enum([
  'hot_applied',
  'restarted',
  'metadata_updated',
  'credential_refreshed',
  'none',
]));

export type ConnectedServiceSwitchAttemptOutcomeActionV1 =
  z.infer<typeof ConnectedServiceSwitchAttemptOutcomeActionV1Schema>;

export const ConnectedServiceSwitchAttemptSessionAdoptionV1Schema = lazyZodSchema(() => z.enum([
  'applied',
  'failed',
  'observed_only',
  'not_applicable',
]));

export type ConnectedServiceSwitchAttemptSessionAdoptionV1 =
  z.infer<typeof ConnectedServiceSwitchAttemptSessionAdoptionV1Schema>;

const ConnectedServiceSwitchAttemptVerificationV1Schema = lazyZodSchema(() => z.object({
  status: z.enum(['verified', 'weakly_verified']),
  reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

// Keys are Connected Account service keys. Released bundled scalar keys
// normalize through the sole legacy normalizer; malformed or unknown keys are
// rejected instead of acquiring verification meaning.
const ConnectedServiceSwitchAttemptVerificationByServiceIdV1Schema = lazyZodSchema(() => z.pipe(z
  .record(z.string(), ConnectedServiceSwitchAttemptVerificationV1Schema), z.transform((value, context) => {
    const canonical: Record<string, z.infer<typeof ConnectedServiceSwitchAttemptVerificationV1Schema>> = {};
    for (const [serviceId, verification] of Object.entries(value)) {
      const canonicalKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
      if (!canonicalKey) {
        context.issues.push({
          code: "custom",
          message: 'Invalid Connected Account service key',
          path: [serviceId], input: context.value });
        continue;
      }
      canonical[canonicalKey] = verification;
    }
    return canonical;
  })));

export const ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1Schema = lazyZodSchema(() => z.enum([
  'retry_scheduled',
  'dead_lettered',
  'recovered',
  'cancelled',
]));

export type ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1 =
  z.infer<typeof ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1Schema>;

/** The existing V1 `cancelled` carrier also represents non-retrying policy outcomes. */
export function isConnectedServiceRuntimeAuthRecoveryCancellation(reason: string | null | undefined): boolean {
  return !reason || reason === 'usage_limit_recovery_cancelled' || reason === 'runtime_auth_recovery_cancelled';
}

const CONNECTED_SERVICE_SWITCH_ATTEMPT_V2_FIELDS = [
  'attemptedContinuityMode',
  'outcomeAction',
  'diagnostic',
  'groupGeneration',
  'sessionAdoption',
  'sessionAdoptedGeneration',
  'partialState',
] as const;

function addConnectedServiceAccountSwitchAttemptEventIssues(
  event: Record<string, unknown>,
  ctx: z.core.$RefinementCtx,
): void {
  if (event.type !== 'connected-service-account-switch-attempt') return;

  const hasV2SemanticField = CONNECTED_SERVICE_SWITCH_ATTEMPT_V2_FIELDS.some((field) => event[field] !== undefined);
  if (hasV2SemanticField && event.outcome === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ['outcome'],
      message: 'new connected-service switch attempt semantics require an explicit outcome',
    });
  }

  if (event.ok === false && event.outcome === 'succeeded') {
    ctx.addIssue({
      code: "custom",
      path: ['outcome'],
      message: 'failed switch attempts must not use a succeeded outcome',
    });
  }

  if (event.ok === true && (event.outcome === 'failed' || event.outcome === 'terminal')) {
    ctx.addIssue({
      code: "custom",
      path: ['outcome'],
      message: 'successful switch attempts must not use a failed or terminal outcome',
    });
  }

  if (
    (event.outcome === 'failed' || event.outcome === 'terminal')
    && event.outcomeAction !== undefined
    && event.outcomeAction !== 'none'
  ) {
    ctx.addIssue({
      code: "custom",
      path: ['outcomeAction'],
      message: 'failed or terminal switch attempt outcomes must not claim a successful outcome action',
    });
  }

  if (event.outcomeAction !== undefined && event.outcome === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ['outcome'],
      message: 'switch attempt outcomeAction requires an explicit outcome',
    });
  }

  if (event.sessionAdoption !== undefined && event.groupGeneration === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ['groupGeneration'],
      message: 'session adoption projection requires the observed group generation',
    });
  }

  if (event.sessionAdoptedGeneration !== undefined && event.groupGeneration === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ['groupGeneration'],
      message: 'session adopted generation requires the observed group generation',
    });
  }

  if (
    (event.outcome === 'failed' || event.outcome === 'terminal')
    && event.sessionAdoption === 'applied'
  ) {
    ctx.addIssue({
      code: "custom",
      path: ['sessionAdoption'],
      message: 'failed or terminal switch attempts must not claim per-session adoption',
    });
  }

  if (event.sessionAdoption === 'applied') {
    if (event.sessionAdoptedGeneration === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ['sessionAdoptedGeneration'],
        message: 'applied session adoption requires a per-session adopted generation',
      });
    }

    if (
      typeof event.groupGeneration === 'number'
      && typeof event.sessionAdoptedGeneration === 'number'
      && event.groupGeneration !== event.sessionAdoptedGeneration
    ) {
      ctx.addIssue({
        code: "custom",
        path: ['sessionAdoptedGeneration'],
        message: 'applied session adoption must target the observed group generation',
      });
    }
  } else if (event.sessionAdoptedGeneration !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ['sessionAdoptedGeneration'],
      message: 'session adopted generation is valid only when session adoption is applied',
    });
  }
}

function addConnectedServiceRuntimeAuthRecoveryEventIssues(
  event: Record<string, unknown>,
  ctx: z.core.$RefinementCtx,
): void {
  if (event.type !== 'connected-service-runtime-auth-recovery') return;

  const diagnostic = event.diagnostic;
  if ((event.status === 'retry_scheduled' || event.status === 'dead_lettered') && diagnostic === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ['diagnostic'],
      message: 'scheduled and dead-lettered runtime-auth recovery events require a diagnostic',
    });
    return;
  }

  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return;
  const diagnosticRecord = diagnostic as Record<string, unknown>;
  if (diagnosticRecord.source !== 'runtime_auth_recovery') {
    ctx.addIssue({
      code: "custom",
      path: ['diagnostic', 'source'],
      message: 'runtime-auth recovery event diagnostics must use runtime_auth_recovery source',
    });
  }

  if (diagnosticRecord.failurePhase !== 'runtime_auth_recovery') {
    ctx.addIssue({
      code: "custom",
      path: ['diagnostic', 'failurePhase'],
      message: 'runtime-auth recovery event diagnostics must use runtime_auth_recovery failure phase',
    });
  }
}

// The five public runtime-config-outcome statuses are frozen. Queued/scheduled/skipped
// state is carried by the optional `timing` field below, never by new status enum values,
// because older clients reject unknown enum values for a known field.
export const RuntimeConfigOutcomeStatusV1Schema = lazyZodSchema(() => z.enum([
  'applied',
  'requires_restart',
  'requires_interactive_control',
  'unsupported',
  'failed',
]));

export type RuntimeConfigOutcomeStatusV1 = z.infer<typeof RuntimeConfigOutcomeStatusV1Schema>;

// Optional timing detail for a runtime-config outcome. This is NOT a status; it explains
// when the (already statused) change takes effect relative to the active TUI/turn window.
export const RuntimeConfigOutcomeTimingV1Schema = lazyZodSchema(() => z.enum([
  'current_window',
  'queued_until_safe_window',
  'scheduled_for_next_prompt',
  'next_idle',
  'before_next_prompt',
  'skipped_already_effective',
  'not_applicable',
]));

export type RuntimeConfigOutcomeTimingV1 = z.infer<typeof RuntimeConfigOutcomeTimingV1Schema>;

export const RuntimeConfigOutcomeChangeKeyV1Schema = lazyZodSchema(() => z.enum([
  'model',
  'fallbackModel',
  'permissionMode',
  'reasoningEffort',
  'maxThinkingTokens',
  'launchOption',
  'sessionMode',
]));

export type RuntimeConfigOutcomeChangeKeyV1 = z.infer<typeof RuntimeConfigOutcomeChangeKeyV1Schema>;

const RuntimeConfigOutcomeScalarV1Schema = lazyZodSchema(() => z.union([
  z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  z.number(),
  z.boolean(),
  z.null(),
]));

const RuntimeConfigOutcomeChangeV1Schema = lazyZodSchema(() => z.strictObject({
    key: RuntimeConfigOutcomeChangeKeyV1Schema,
    requested: z.optional(RuntimeConfigOutcomeScalarV1Schema),
    previous: z.optional(RuntimeConfigOutcomeScalarV1Schema),
    effective: z.optional(RuntimeConfigOutcomeScalarV1Schema),
    reason: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  }));

export const TerminalComposerDraftBlockedReasonV1Schema = lazyZodSchema(() => z.enum([
  'idle_draft_guard',
  'in_flight_steer',
]));

export type TerminalComposerDraftBlockedReasonV1 =
  z.infer<typeof TerminalComposerDraftBlockedReasonV1Schema>;

/** Presentation evidence supplied only by admitted Follow routes. */
export const WorkerUpdateFollowMatchV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('relation'), relation: z.enum(['follower', 'manager']) }),
  // Rule identity is private admission custody, never part of a shared Session transcript.
  z.strictObject({ kind: z.literal('rule') }),
]));
export type WorkerUpdateFollowMatchV1 = z.infer<typeof WorkerUpdateFollowMatchV1Schema>;

const AgentEventSchema = lazyZodSchema(() => z.pipe(z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('mcp-binding-usage'), usage: UsageMcpBindingUsageSchema }),
  z.strictObject({ type: z.literal('prompt-composition'), composition: UsagePromptCompositionSchema }),
  z.looseObject({ type: z.literal('switch'), mode: z.enum(['local', 'remote']) }),
  z.looseObject({
      type: z.literal('runtime-config-outcome'),
      agentId: z.optional(AgentIdV1Schema),
      runtime: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
      status: RuntimeConfigOutcomeStatusV1Schema,
      timing: z.optional(RuntimeConfigOutcomeTimingV1Schema),
      reason: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
      message: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
      changes: z.optional(z.array(RuntimeConfigOutcomeChangeV1Schema).check(z.maxLength(20))),
    }),
  z.looseObject({
      type: z.literal('terminal-composer-draft-blocked'),
      reason: TerminalComposerDraftBlockedReasonV1Schema,
      stateAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
      message: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))),
    }),
  z.looseObject({
      type: z.literal('message'),
      message: z.string(),
      // Presentation-only source Ask/Send record. Keep the informational text
      // readable when an unknown/malformed sidecar is ignored; its reader owns
      // strict admission before offering any result or operation identity.
      sessionMessageInvocationV1: z.optional(z.unknown()),
      // The canonical stop reader validates this presentation sidecar; stored
      // transcript reads must retain it without rejecting the fallback prose.
      sessionStopV1: z.optional(z.unknown()),
      /**
       * Same-Session cross-Agent transition divider. This is a strict nested
       * sidecar on the EXISTING passthrough `message` arm, never a new
       * `AgentEventSchema` variant: this union is closed at the discriminator,
       * so a new variant would be dropped by every released reader. An old
       * reader parses this row as an ordinary informational message and keeps
       * the sidecar untouched through `.passthrough()`.
       *
       * Declared as `unknown` ON PURPOSE. A strict nested schema here would
       * invalidate the whole discriminated-union member on a malformed or
       * future-version sidecar, and this arm accepted arbitrary extra keys
       * before the divider existed — so one write at this key name would erase
       * an otherwise valid transcript row for every reader. Strictness lives at
       * the two places that can act on it: writers parse
       * {@link SessionAgentTransitionDividerV1Schema} before sealing, and the
       * single canonical reader
       * {@link readSessionAgentTransitionDividerV1} strict-parses and returns
       * `null` for anything else — so a malformed sidecar is never treated as a
       * divider, never silenced, and never a departure boundary.
       */
      [SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY]: z.optional(z.unknown()),
      // Retain the presentation sidecar even when malformed or from a future writer.
      // Its canonical reader validates it without erasing the fallback message.
      [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: z.optional(z.unknown()),
    }),
  z.looseObject({
      type: z.literal('context-compaction'),
      ...ContextCompactionShape,
    }),
  z.looseObject({ type: z.literal('limit-reached'), endsAt: z.number() }),
  z.looseObject({
      type: z.literal('connected-service-account-switch'),
      serviceId: ConnectedAccountServiceKeyIngressSchema,
      groupId: z.nullable(ConnectedServiceAuthGroupIdSchema),
      groupLabel: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
      fromProfileId: z.nullable(ConnectedServiceProfileIdSchema),
      toProfileId: z.nullable(ConnectedServiceProfileIdSchema),
      // Optional human-readable profile labels resolved at emission time, so the UI can render
      // identity display even before profile-label settings hydrate on the consuming client.
      fromProfileLabel: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
      toProfileLabel: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
      reason: z.string(),
      mode: z.optional(z.enum(['hot_apply', 'restart_resume', 'manual'])),
      effectiveRemainingPct: z.optional(z.nullable(z.number())),
    }),
  z.looseObject({
      type: z.literal('agent-quota-wait'),
      serviceId: ConnectedAccountServiceKeyIngressSchema,
      resetAtMs: z.number(),
      reason: z.string(),
      profileId: z.optional(z.nullable(ConnectedServiceProfileIdSchema)),
      groupId: z.optional(z.nullable(ConnectedServiceAuthGroupIdSchema)),
    }),
  z.looseObject({
      type: z.literal('agent-quota-recovered'),
      serviceId: ConnectedAccountServiceKeyIngressSchema,
      reason: z.string(),
      profileId: z.optional(z.nullable(ConnectedServiceProfileIdSchema)),
      groupId: z.optional(z.nullable(ConnectedServiceAuthGroupIdSchema)),
    }),
  // O1: connected-service switch lifecycle events (committed by the daemon switch FSM)
  z.looseObject({
      type: z.literal('connected-service-account-switch-attempt'),
      ok: z.boolean(),
      action: z.enum(['restart_requested', 'hot_applied', 'metadata_updated']),
      attemptedContinuityMode: z.optional(ConnectedServiceSwitchAttemptedContinuityModeV1Schema),
      outcome: z.optional(ConnectedServiceSwitchAttemptOutcomeV1Schema),
      outcomeAction: z.optional(ConnectedServiceSwitchAttemptOutcomeActionV1Schema),
      errorCode: z.optional(z.nullable(z.string())),
      diagnostic: z.optional(ConnectedServiceUxDiagnosticV1Schema),
      groupGeneration: z.optional(z.number().check(z.int(), z.nonnegative())),
      sessionAdoption: z.optional(ConnectedServiceSwitchAttemptSessionAdoptionV1Schema),
      sessionAdoptedGeneration: z.optional(z.number().check(z.int(), z.nonnegative())),
      partialState: z.optional(z.nullable(z
        .enum(['metadata_may_reference_new_binding', 'runtime_auth_applied', 'runtime_auth_partially_applied']))),
      verificationByServiceId: z.optional(ConnectedServiceSwitchAttemptVerificationByServiceIdV1Schema),
    }),
  z.looseObject({
      type: z.literal('connected-service-runtime-auth-recovery'),
      status: ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1Schema,
      serviceId: ConnectedAccountServiceKeyIngressSchema,
      profileId: z.optional(ConnectedServiceProfileIdSchema),
      groupId: z.optional(ConnectedServiceAuthGroupIdSchema),
      attempt: z.optional(z.number().check(z.int(), z.positive())),
      nextRetryAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
      terminal: z.optional(z.boolean()),
      diagnostic: z.optional(ConnectedServiceUxDiagnosticV1Schema),
      reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
    }),
  z.looseObject({
      type: z.literal('connected-service-account-switch-deferral'),
      policy: z.string(),
      awaitingBoundary: z.optional(z.boolean()),
      timeoutMs: z.optional(z.number()),
    }),
  z.looseObject({
      type: z.literal('connected-service-account-switch-deferral-completed'),
      policy: z.optional(z.string()),
      reason: z.string(),
    }),
  z.looseObject({
      type: z.literal('connected-service-account-switch-deferral-superseded'),
      policy: z.optional(z.string()),
    }),
  z.looseObject({
      type: z.literal('agent-state-sharing-degraded'),
      serviceId: z.string(),
      code: z.string(),
      requestedStateMode: z.optional(z.string()),
      effectiveStateMode: z.optional(z.string()),
      reason: z.optional(z.string()),
    }),
  z.looseObject({
      type: z.literal('task-lifecycle'),
      event: TurnLifecycleEventV1Schema,
      id: z.optional(z.nullable(z.string())),
    }),
  z.looseObject({ type: z.literal('ready'),
    /** Present only for a host-observed completed turn, never an idle/command ready event. */
    completedTurnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  z.strictObject({ type: z.literal('worker-update'), update: WorkerUpdateV1Schema,
    /** Admitted Follow routes for this card; ordinary run cards have none. */
    followMatches: z.optional(z.array(WorkerUpdateFollowMatchV1Schema).check(z.minLength(1))),
    /** Existing accepted Follow original identity; presentation joins only this input's delivery. */
    followInputLocalId: z.optional(PendingLocalIdSchema),
    followWakeEventLocalId: z.optional(z.string().check(z.refine(isSessionFollowWakeEventLocalId, {
      message: 'Expected a canonical Session Follow wake event id',
    }))),
  }),
  z.strictObject({ type: z.literal('worker-report'), ...SessionUpdatePostInputV1Schema.shape }),
  z.strictObject({ type: z.literal('goal-changed') }),
]).check(z.superRefine((event, ctx) => {
    if (event.type === 'worker-report') refineWorkerDeliverableResultV1(event.summary, event.deliverables, ctx, 'summary');
    if (event.type === 'context-compaction') {
      addContextCompactionEventContinuationIssues(event as Record<string, unknown>, ctx, []);
    }
    const eventRecord = event as Record<string, unknown>;
    addConnectedServiceAccountSwitchAttemptEventIssues(eventRecord, ctx);
    addConnectedServiceRuntimeAuthRecoveryEventIssues(eventRecord, ctx);
  })), z.transform((event) => {
    if (event.type !== 'agent-state-sharing-degraded') return event;
    const { entryName: _legacyEntryName, ...safeEvent } = event as typeof event & { entryName?: unknown };
    return safeEvent;
  })));

const RawAgentRecordSchema = lazyZodSchema(() => z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('output'),
      data: RawAgentOutputDataSchema,
    }),
    z.looseObject({ type: z.literal('event'), id: z.string(), data: createStoredReadSchema(AgentEventSchema) }),
    z.looseObject({
        type: z.literal('codex'),
        data: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('reasoning'), message: z.string(), sidechainId: z.optional(z.string()) }),
            z.object({ type: z.literal('message'), message: z.string(), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('token_count'), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('task_started'), id: z.optional(z.string()), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('task_complete'), id: z.optional(z.string()), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('turn_failed'), id: z.optional(z.string()), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('turn_cancelled'), id: z.optional(z.string()), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('turn_aborted'), id: z.optional(z.string()), sidechainId: z.optional(z.string()) }),
            z.looseObject({
                type: z.literal('tool-call'),
                callId: z.string(),
                input: z.unknown(),
                name: z.string(),
                id: z.optional(z.string()),
                sidechainId: z.optional(z.string()),
              }),
            z.looseObject({
                type: z.literal('tool-call-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.optional(z.string()),
                sidechainId: z.optional(z.string()),
              }),
            z.looseObject({
                type: z.literal('tool-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.optional(z.string()),
                sidechainId: z.optional(z.string()),
              }),
          ])
          ,
      }),
    z.looseObject({
        type: z.literal('acp'),
        agentId: z.string().check(z.trim(), z.minLength(1)),
        data: z.lazy(() => {
          const knownTypes = new Set([
            'reasoning',
            'message',
            'thinking',
            'tool-call',
            'tool-result',
            'tool-call-result',
            'file-edit',
            'terminal-output',
            'task_started',
            'task_complete',
            'turn_failed',
            'turn_cancelled',
            'turn_aborted',
            'permission-request',
            'token_count',
            'context-compaction',
          ] as const);

          const known = z.discriminatedUnion('type', [
            z.looseObject({ type: z.literal('reasoning'), message: z.string(), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('message'), message: z.string(), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('thinking'), text: z.string(), sidechainId: z.optional(z.string()) }),
            z.looseObject({
                type: z.literal('tool-call'),
                callId: z.string(),
                input: z.unknown(),
                name: z.string(),
                id: z.string(),
                sidechainId: z.optional(z.string()),
              }),
            z.looseObject({
                type: z.literal('tool-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.string(),
                isError: z.optional(z.boolean()),
                sidechainId: z.optional(z.string()),
              }),
            z.looseObject({
                type: z.literal('tool-call-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.string(),
                sidechainId: z.optional(z.string()),
              }),
            z.looseObject({
                type: z.literal('file-edit'),
                description: z.string(),
                filePath: z.string(),
                diff: z.optional(z.string()),
                oldContent: z.optional(z.string()),
                newContent: z.optional(z.string()),
                id: z.string(),
                sidechainId: z.optional(z.string()),
              }),
            z.looseObject({
                type: z.literal('terminal-output'),
                data: z.string(),
                callId: z.string(),
                sidechainId: z.optional(z.string()),
              }),
            z.looseObject({ type: z.literal('task_started'), id: z.string(), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('task_complete'), id: z.string(), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('turn_failed'), id: z.string(), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('turn_cancelled'), id: z.string(), sidechainId: z.optional(z.string()) }),
            z.looseObject({ type: z.literal('turn_aborted'), id: z.string(), sidechainId: z.optional(z.string()) }),
            z.looseObject({
                type: z.literal('permission-request'),
                permissionId: z.string(),
                toolName: z.string(),
                description: z.string(),
                options: z.optional(z.unknown()),
                sidechainId: z.optional(z.string()),
              }),
            z.looseObject({ type: z.literal('token_count'), sidechainId: z.optional(z.string()) }),
            z.looseObject({
                type: z.literal('context-compaction'),
                ...ContextCompactionShape,
                sidechainId: z.optional(z.string()),
              }),
          ]);

          const unknown = z.looseObject({ type: z.string() }).check(z.refine((value) => !knownTypes.has(value.type as any), {
              message: 'Unknown ACP data type must not collide with known types',
            }));

          return z.union([known, unknown]);
        }),
      }),
  ]))
  ;

/**
 * Persisted Session-transcript record read contract. It intentionally retains
 * supported provider-rich and historical fields, so current Agent contribution
 * output must instead use `AgentExternalSessionTranscriptRawRecordSchema` at
 * its first host boundary.
 */
export type TranscriptRawRecordV1WithMeta<Meta> =
  | (Record<string, unknown> & {
      role: 'agent';
      content: TranscriptRawAgentRecordV1;
      meta?: Meta;
    })
  | (Record<string, unknown> & {
      role: 'user';
      content: {
        type: 'text';
        text: string;
      } & Record<string, unknown>;
      meta?: Meta;
    });

export function createTranscriptRawRecordV1Schema(
  zod: typeof z,
): z.ZodMiniType<TranscriptRawRecordV1WithMeta<SessionMessageMeta>>;
export function createTranscriptRawRecordV1Schema<MetaSchema extends z.ZodMiniType>(
  zod: typeof z,
  options: Readonly<{
    metaSchema: MetaSchema;
  }>,
) : z.ZodMiniType<TranscriptRawRecordV1WithMeta<z.infer<MetaSchema>>>;
export function createTranscriptRawRecordV1Schema<MetaSchema extends z.ZodMiniType>(
  zod: typeof z,
  options?: Readonly<{
    metaSchema?: MetaSchema;
  }>,
) {
  const metaSchema = options?.metaSchema ?? createStoredReadSchema(createSessionMessageMetaSchema(zod));

  return zod.pipe(zod.transform(preprocessMessageContent), zod.discriminatedUnion('role', [
      zod.looseObject({
          role: zod.literal('agent'),
          content: RawAgentRecordSchema,
          meta: zod.optional(metaSchema),
        }),
      zod.looseObject({
          role: zod.literal('user'),
          content: zod.looseObject({
              type: zod.literal('text'),
              text: zod.string(),
            }),
          meta: zod.optional(metaSchema),
        }),
    ])).check(zod.superRefine(addRawRecordContextCompactionContinuationIssues));
}

export const TranscriptRawRecordV1Schema = lazyZodSchema(() => createTranscriptRawRecordV1Schema(z));
export type TranscriptRawRecordV1 = z.infer<typeof TranscriptRawRecordV1Schema>;

export const TranscriptRawUsageDataV1Schema = UsageDataSchema;
export type TranscriptRawUsageDataV1 = z.infer<typeof TranscriptRawUsageDataV1Schema>;

export const TranscriptRawAgentEventV1Schema = AgentEventSchema;
export type TranscriptRawAgentEventV1 = z.infer<typeof TranscriptRawAgentEventV1Schema>;

export const SessionMessageAttentionImpactSchema = lazyZodSchema(() => z.strictObject({
  affectsUnread: z.boolean(),
  affectsMeaningfulActivity: z.boolean(),
}));
export type SessionMessageAttentionImpact = z.infer<typeof SessionMessageAttentionImpactSchema>;

export const SESSION_MESSAGE_USER_ATTENTION_IMPACT: SessionMessageAttentionImpact = Object.freeze({
  affectsUnread: true,
  affectsMeaningfulActivity: true,
});

export const SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT: SessionMessageAttentionImpact = Object.freeze({
  affectsUnread: false,
  affectsMeaningfulActivity: false,
});

const AGENT_EVENT_TYPES_WITHOUT_USER_ATTENTION = new Set<TranscriptRawAgentEventV1['type']>([
  'mcp-binding-usage',
  'prompt-composition',
  'connected-service-account-switch',
  'connected-service-account-switch-deferral',
  'connected-service-account-switch-deferral-completed',
  'connected-service-account-switch-deferral-superseded',
  'connected-service-account-switch-attempt',
  'agent-state-sharing-degraded',
  'agent-quota-wait',
  'agent-quota-recovered',
]);

const RUNTIME_AUTH_RECOVERY_STATUSES_WITHOUT_USER_ATTENTION = new Set<ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1>([
  'retry_scheduled',
  'recovered',
  'cancelled',
]);

function readAgentEventType(value: unknown): TranscriptRawAgentEventV1['type'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string'
    ? type as TranscriptRawAgentEventV1['type']
    : null;
}

function readAgentEventStatus(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as { status?: unknown }).status;
}

function sanitizeAgentEventLocalIdPart(value: unknown): string | null {
  const normalized = String(value ?? '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : null;
}

export function buildAgentEventLocalId(
  type: TranscriptRawAgentEventV1['type'],
  parts: ReadonlyArray<unknown>,
): string {
  const normalizedType = sanitizeAgentEventLocalIdPart(type);
  if (!normalizedType) {
    throw new Error('Agent event local id type must not be empty');
  }
  const normalizedParts = parts.map(sanitizeAgentEventLocalIdPart).filter((part): part is string => part !== null);
  return [normalizedType, ...normalizedParts].join(':');
}

function readAgentEventLocalIdType(value: string | null | undefined): TranscriptRawAgentEventV1['type'] | null {
  if (typeof value !== 'string') return null;
  const candidateType = value.trim().split(':', 1)[0];
  if (candidateType === 'connected-service-runtime-auth-recovery' || candidateType === 'context-compaction') {
    return candidateType;
  }
  return AGENT_EVENT_TYPES_WITHOUT_USER_ATTENTION.has(candidateType as TranscriptRawAgentEventV1['type'])
    ? candidateType as TranscriptRawAgentEventV1['type']
    : null;
}

function readRuntimeAuthRecoveryStatusFromLocalId(
  localId: string,
): ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1 | null {
  const parts = localId.trim().split(':');
  const currentShapeStatus = ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1Schema.safeParse(parts[4]);
  if (currentShapeStatus.success) return currentShapeStatus.data;

  for (let index = 1; index < parts.length - 1; index += 1) {
    if (parts[index] !== 'status') continue;
    const labelledStatus = ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1Schema.safeParse(parts[index + 1]);
    if (labelledStatus.success) return labelledStatus.data;
  }

  if (parts.length <= 4) {
    const compactShapeStatus = ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1Schema.safeParse(parts[parts.length - 1]);
    if (compactShapeStatus.success) return compactShapeStatus.data;
  }
  return null;
}

export function agentEventAttentionImpact(
  event: unknown,
  localId?: unknown,
): SessionMessageAttentionImpact {
  const type = readAgentEventType(event);
  if (type === 'context-compaction' && event && typeof event === 'object'
    && (event as Readonly<Record<string, unknown>>).trigger === 'idle') {
    return SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT;
  }
  // The same-Session transition divider is a boundary marker, not news. It rides
  // the passthrough `message` arm, whose type-keyed default is attention-bearing
  // and must stay that way for every other passthrough event, so the exemption is
  // conditioned on the divider's full identity instead — the reserved outer
  // localId AND the strict `sessionAgentTransitionV1` sidecar, both answered by
  // the canonical reader. Callers that have a stored row forward its localId;
  // a compatibility caller that does not has no trusted divider and therefore
  // takes the conservative attention-bearing path. This is
  // the single attention decision: `attentionImpact` is not a persisted column, so
  // both re-read resolvers (server `resolveMessageAttentionImpact`, client
  // `messageAttentionImpact` / `storedSessionMessageContentAttentionImpactOrNull`)
  // inherit it by already delegating here. A malformed or unknown-version sidecar
  // does not parse and therefore is NOT silenced.
  if (readSessionAgentTransitionDividerV1({ localId, event }) !== null) {
    return SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT;
  }
  if (type === 'connected-service-runtime-auth-recovery') {
    const parsedStatus = ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1Schema.safeParse(readAgentEventStatus(event));
    return parsedStatus.success && RUNTIME_AUTH_RECOVERY_STATUSES_WITHOUT_USER_ATTENTION.has(parsedStatus.data)
      ? SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT
      : SESSION_MESSAGE_USER_ATTENTION_IMPACT;
  }
  return type !== null && AGENT_EVENT_TYPES_WITHOUT_USER_ATTENTION.has(type)
    ? SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT
    : SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}

export function agentEventLocalIdAttentionImpact(localId: string | null | undefined): SessionMessageAttentionImpact | null {
  const type = readAgentEventLocalIdType(localId);
  if (type === null || typeof localId !== 'string') return null;
  if (type === 'context-compaction') {
    const parts = localId.trim().split(':');
    const phase = ContextCompactionPhaseSchema.safeParse(parts[3]);
    const idle = parts.length === 5 && parts[1] === 'idle' && /^[A-Za-z0-9_-]+$/.test(parts[2] ?? '')
      && phase.success && /^(0|[1-9][0-9]*)$/.test(parts[4] ?? '') && Number.isSafeInteger(Number(parts[4]));
    return agentEventAttentionImpact({ type, ...(idle ? { trigger: 'idle' } : {}) }, localId);
  }
  if (type === 'connected-service-runtime-auth-recovery') {
    return agentEventAttentionImpact({
      type,
      status: readRuntimeAuthRecoveryStatusFromLocalId(localId),
    }, localId);
  }
  return agentEventAttentionImpact({ type }, localId);
}

export const TranscriptRawAgentContentV1Schema = RawAgentContentSchema;
export type TranscriptRawAgentContentV1 = z.infer<typeof TranscriptRawAgentContentV1Schema>;

export const TranscriptRawAgentRecordV1Schema = RawAgentRecordSchema;
export type TranscriptRawAgentRecordV1 = z.infer<typeof TranscriptRawAgentRecordV1Schema>;
