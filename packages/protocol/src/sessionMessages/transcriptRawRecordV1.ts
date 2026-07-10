import { z } from 'zod';

import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
} from '../connect/connectedServiceSchemas.js';
import { ConnectedServiceUxDiagnosticV1Schema } from '../connect/connectedServiceUxDiagnostics.js';
import { createSessionMessageMetaSchema } from './sessionMessageMeta.js';
import type { SessionMessageMeta } from './sessionMessageMeta.js';

const UsageDataSchema = z
  .object({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    // Some upstream providers emit `service_tier: null` in error payloads.
    // Treat null as “unknown” so we don't drop the whole message.
    service_tier: z.string().nullish(),
  })
  .passthrough();

const UsageDataBestEffortSchema = z
  .unknown()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const parsed = UsageDataSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });

const RawTextContentSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

const RawToolUseContentSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

const RawToolResultContentSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
    // Provider-specific; keep permissive for forward compatibility.
    permissions: z.unknown().optional(),
  })
  .passthrough();

const RawThinkingContentSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
  })
  .passthrough();

// Forward compatibility: keep unknown content blocks instead of dropping the entire message.
// Callers can render these as a placeholder if needed.
const RawUnknownContentSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

// Hyphenated tool-call formats seen in some providers (Codex/Gemini variants).
const RawHyphenatedToolCallSchema = z
  .object({
    type: z.literal('tool-call'),
    callId: z.string(),
    id: z.string().optional(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

const RawHyphenatedToolResultSchema = z
  .object({
    type: z.literal('tool-call-result'),
    callId: z.string(),
    tool_use_id: z.string().optional(),
    output: z.unknown(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

const RawAgentContentSchema = z.union([
  RawTextContentSchema,
  RawToolUseContentSchema,
  RawToolResultContentSchema,
  RawThinkingContentSchema,
  RawHyphenatedToolCallSchema,
  RawHyphenatedToolResultSchema,
  RawUnknownContentSchema,
]);

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

  return record;
}

const KNOWN_OUTPUT_DATA_TYPES = new Set(['system', 'result', 'summary', 'progress', 'assistant', 'user'] as const);

type UnknownOutputDataType = string & { readonly __happierUnknownOutputDataType: unique symbol };

const OutputExtrasShape = {
  isSidechain: z.boolean().nullish(),
  isCompactSummary: z.boolean().nullish(),
  isMeta: z.boolean().nullish(),
  uuid: z.string().nullish(),
  parentUuid: z.string().nullish(),
} as const;

const withOutputExtras = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.extend(OutputExtrasShape).passthrough();

const RawAgentOutputDataKnownSchema = z.discriminatedUnion('type', [
  withOutputExtras(z.object({ type: z.literal('system') })),
  withOutputExtras(z.object({ type: z.literal('result') })),
  withOutputExtras(z.object({ type: z.literal('summary'), summary: z.string() })),
  withOutputExtras(z.object({ type: z.literal('progress') })),
  withOutputExtras(
    z.object({
      type: z.literal('assistant'),
      message: z
        .object({
          role: z.literal('assistant'),
          model: z.string().optional(),
          content: z.union([z.array(RawAgentContentSchema), z.string()]),
          // Usage is best-effort: do not reject the whole message if upstream changes the usage shape.
          usage: UsageDataBestEffortSchema,
        })
        .passthrough(),
      parent_tool_use_id: z.string().nullable().optional(),
    }),
  ),
  withOutputExtras(
    z.object({
      type: z.literal('user'),
      message: z
        .object({
          role: z.literal('user'),
          content: z.union([z.string(), z.array(RawAgentContentSchema)]),
        })
        .passthrough(),
      parent_tool_use_id: z.string().nullable().optional(),
      toolUseResult: z.unknown().nullable().optional(),
    }),
  ),
]);

const RawAgentOutputDataUnknownSchema = z
  .object({ type: z.string() })
  .extend(OutputExtrasShape)
  .passthrough()
  // NOTE: We intentionally do NOT reject known `type` values here.
  // `RawAgentOutputDataSchema` is `union([Known, Unknown])` with Known tried first,
  // so well-formed known-type rows still match their rich Known variant. A known-type
  // row whose body does NOT match (e.g. a Claude `assistant` row missing `message`,
  // or with `content: null`) falls through to this catch-all instead of failing the
  // entire record — which would otherwise render as "[Unparsed agent message]" in the
  // UI. This matches the package's forward-compatibility philosophy.
  .transform((value) => ({ ...value, type: value.type as UnknownOutputDataType }));

const RawAgentOutputDataSchema = z.union([RawAgentOutputDataKnownSchema, RawAgentOutputDataUnknownSchema]);

const AgentEventLifecycleShape = {
  lifecycleId: z.string().trim().min(1).optional(),
} as const;

const ContextCompactionPhaseSchema = z.preprocess(
  (value) => value === 'detected' ? 'completed' : value,
  z.enum(['started', 'progress', 'completed', 'failed', 'cancelled']),
);
const ContextCompactionSourceSchema = z.enum([
  'provider-event',
  'provider-status',
  'provider-hook',
  'transcript-inference',
  'user-command',
  'runtime',
]);
const ContextCompactionContinuationSchema = z.enum(['paused']);
const ContextCompactionPauseReasonSchema = z.enum(['provider-idle-after-compaction']);

const withAgentEventLifecycle = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.extend(AgentEventLifecycleShape).passthrough();

const ProviderStateSharingDegradedEventSchema = withAgentEventLifecycle(
  z.object({
    type: z.literal('provider-state-sharing-degraded'),
    serviceId: ConnectedServiceIdSchema,
    requestedStateMode: z.string().trim().min(1),
    effectiveStateMode: z.string().trim().min(1),
    code: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional(),
  }),
).transform((value) => {
  const { entryName: _legacyEntryName, ...safeValue } = value as typeof value & { entryName?: unknown };
  return safeValue;
});

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
  ctx: z.RefinementCtx,
  pathPrefix: readonly (string | number)[],
): void {
  if (event.continuation === 'paused' && event.phase !== 'completed') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...pathPrefix, 'continuation'],
      message: 'Context compaction paused continuation is only valid for completed phases',
    });
  }

  if (event.pauseReason !== undefined && event.continuation !== 'paused') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...pathPrefix, 'pauseReason'],
      message: 'Context compaction pause reason requires paused continuation',
    });
  }
}

function addRawRecordContextCompactionContinuationIssues(value: unknown, ctx: z.RefinementCtx): void {
  const event = readContextCompactionEventDataFromRawRecord(value);
  if (!event) return;

  addContextCompactionEventContinuationIssues(event, ctx, ['content', 'data']);
}

const ConnectedServiceAccountSwitchReasonSchema = z.enum([
  'usage_limit',
  'soft_threshold',
  'auth_expired',
  'account_changed',
  'refresh_failure',
  'manual',
]);

const ConnectedServiceAccountSwitchModeSchema = z.enum([
  'hot_apply',
  'restart_resume',
  'spawn_next_turn',
]);

export const ConnectedServiceSwitchAttemptedContinuityModeV1Schema = z.enum([
  'hot_apply',
  'restart',
  'metadata_only',
  'credential_refresh',
]);

export type ConnectedServiceSwitchAttemptedContinuityModeV1 =
  z.infer<typeof ConnectedServiceSwitchAttemptedContinuityModeV1Schema>;

export const ConnectedServiceSwitchAttemptOutcomeV1Schema = z.enum([
  'succeeded',
  'failed',
  'observed',
  'scheduled_retry',
  'terminal',
]);

export type ConnectedServiceSwitchAttemptOutcomeV1 =
  z.infer<typeof ConnectedServiceSwitchAttemptOutcomeV1Schema>;

export const ConnectedServiceSwitchAttemptOutcomeActionV1Schema = z.enum([
  'hot_applied',
  'restarted',
  'metadata_updated',
  'credential_refreshed',
  'none',
]);

export type ConnectedServiceSwitchAttemptOutcomeActionV1 =
  z.infer<typeof ConnectedServiceSwitchAttemptOutcomeActionV1Schema>;

export const ConnectedServiceSwitchAttemptSessionAdoptionV1Schema = z.enum([
  'applied',
  'failed',
  'observed_only',
  'not_applicable',
]);

export type ConnectedServiceSwitchAttemptSessionAdoptionV1 =
  z.infer<typeof ConnectedServiceSwitchAttemptSessionAdoptionV1Schema>;

const ConnectedServiceSwitchAttemptVerificationByServiceIdV1Schema = z.partialRecord(
  ConnectedServiceIdSchema,
  z.object({
    status: z.enum(['verified', 'weakly_verified']),
    providerAccountId: z.string().trim().min(1).nullable().optional(),
    activeAccountId: z.string().trim().min(1).nullable().optional(),
    sharedAuthSurfaceId: z.string().trim().min(1).nullable().optional(),
    proofStrength: z.enum(['exact', 'weak', 'diagnostic']).optional(),
    source: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
  }),
);

const ConnectedServiceAccountSwitchDeferralPolicySchema = z.enum([
  'defer_until_turn_boundary',
  'defer_until_idle',
]);

const ConnectedServiceAccountSwitchDeferralCompletionReasonSchema = z.enum([
  'completed_at_boundary',
  'aborted_after_timeout',
  'switch_cancelled',
  'session_terminated',
  'daemon_shutdown',
]);

export const ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1Schema = z.enum([
  'retry_scheduled',
  'dead_lettered',
  'recovered',
  'cancelled',
]);

export type ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1 =
  z.infer<typeof ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1Schema>;

const CONNECTED_SERVICE_SWITCH_ATTEMPT_V2_FIELDS = [
  'attemptedContinuityMode',
  'outcomeAction',
  'diagnostic',
  'groupGeneration',
  'sessionAdoption',
  'sessionAdoptedGeneration',
] as const;

function addConnectedServiceAccountSwitchAttemptEventIssues(
  event: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  if (event.type !== 'connected-service-account-switch-attempt') return;

  const hasV2SemanticField = CONNECTED_SERVICE_SWITCH_ATTEMPT_V2_FIELDS.some((field) => event[field] !== undefined);
  if (hasV2SemanticField && event.outcome === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outcome'],
      message: 'new connected-service switch attempt semantics require an explicit outcome',
    });
  }

  if (event.ok === false && event.outcome === 'succeeded') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outcome'],
      message: 'failed switch attempts must not use a succeeded outcome',
    });
  }

  if (event.ok === true && (event.outcome === 'failed' || event.outcome === 'terminal')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
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
      code: z.ZodIssueCode.custom,
      path: ['outcomeAction'],
      message: 'failed or terminal switch attempt outcomes must not claim a successful outcome action',
    });
  }

  if (event.outcomeAction !== undefined && event.outcome === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outcome'],
      message: 'switch attempt outcomeAction requires an explicit outcome',
    });
  }

  if (event.sessionAdoption !== undefined && event.groupGeneration === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['groupGeneration'],
      message: 'session adoption projection requires the observed group generation',
    });
  }

  if (event.sessionAdoptedGeneration !== undefined && event.groupGeneration === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['groupGeneration'],
      message: 'session adopted generation requires the observed group generation',
    });
  }

  if (
    (event.outcome === 'failed' || event.outcome === 'terminal')
    && event.sessionAdoption === 'applied'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionAdoption'],
      message: 'failed or terminal switch attempts must not claim per-session adoption',
    });
  }

  if (event.sessionAdoption === 'applied') {
    if (event.sessionAdoptedGeneration === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
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
        code: z.ZodIssueCode.custom,
        path: ['sessionAdoptedGeneration'],
        message: 'applied session adoption must target the observed group generation',
      });
    }
  } else if (event.sessionAdoptedGeneration !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionAdoptedGeneration'],
      message: 'session adopted generation is valid only when session adoption is applied',
    });
  }
}

function addConnectedServiceRuntimeAuthRecoveryEventIssues(
  event: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  if (event.type !== 'connected-service-runtime-auth-recovery') return;

  const diagnostic = event.diagnostic;
  if ((event.status === 'retry_scheduled' || event.status === 'dead_lettered') && diagnostic === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diagnostic'],
      message: 'scheduled and dead-lettered runtime-auth recovery events require a diagnostic',
    });
    return;
  }

  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return;
  const diagnosticRecord = diagnostic as Record<string, unknown>;
  if (diagnosticRecord.source !== 'runtime_auth_recovery') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diagnostic', 'source'],
      message: 'runtime-auth recovery event diagnostics must use runtime_auth_recovery source',
    });
  }

  if (diagnosticRecord.failurePhase !== 'runtime_auth_recovery') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diagnostic', 'failurePhase'],
      message: 'runtime-auth recovery event diagnostics must use runtime_auth_recovery failure phase',
    });
  }
}

// The five public runtime-config-outcome statuses are frozen. Queued/scheduled/skipped
// state is carried by the optional `timing` field below, never by new status enum values,
// because older clients reject unknown enum values for a known field.
export const RuntimeConfigOutcomeStatusV1Schema = z.enum([
  'applied',
  'requires_restart',
  'requires_interactive_control',
  'unsupported',
  'failed',
]);

export type RuntimeConfigOutcomeStatusV1 = z.infer<typeof RuntimeConfigOutcomeStatusV1Schema>;

// Optional timing detail for a runtime-config outcome. This is NOT a status; it explains
// when the (already statused) change takes effect relative to the active TUI/turn window.
export const RuntimeConfigOutcomeTimingV1Schema = z.enum([
  'current_window',
  'queued_until_safe_window',
  'scheduled_for_next_prompt',
  'next_idle',
  'before_next_prompt',
  'skipped_already_effective',
  'not_applicable',
]);

export type RuntimeConfigOutcomeTimingV1 = z.infer<typeof RuntimeConfigOutcomeTimingV1Schema>;

export const RuntimeConfigOutcomeChangeKeyV1Schema = z.enum([
  'model',
  'fallbackModel',
  'permissionMode',
  'reasoningEffort',
  'maxThinkingTokens',
  'launchOption',
  'sessionMode',
]);

export type RuntimeConfigOutcomeChangeKeyV1 = z.infer<typeof RuntimeConfigOutcomeChangeKeyV1Schema>;

const RuntimeConfigOutcomeScalarV1Schema = z.union([
  z.string().trim().min(1).max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const RuntimeConfigOutcomeChangeV1Schema = z
  .object({
    key: RuntimeConfigOutcomeChangeKeyV1Schema,
    requested: RuntimeConfigOutcomeScalarV1Schema.optional(),
    previous: RuntimeConfigOutcomeScalarV1Schema.optional(),
    effective: RuntimeConfigOutcomeScalarV1Schema.optional(),
    reason: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const TerminalComposerDraftBlockedReasonV1Schema = z.enum([
  'idle_draft_guard',
  'in_flight_steer',
]);

const AgentEventSchema = z.discriminatedUnion('type', [
  withAgentEventLifecycle(z.object({ type: z.literal('switch'), mode: z.enum(['local', 'remote']) })),
  withAgentEventLifecycle(z.object({ type: z.literal('message'), message: z.string() })),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('terminal-composer-draft-blocked'),
      reason: TerminalComposerDraftBlockedReasonV1Schema,
      stateAtMs: z.number().int().nonnegative().optional(),
      message: z.string().trim().min(1).max(2000).optional(),
    }),
  ),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('runtime-config-outcome'),
      provider: z.string().trim().min(1).max(128).optional(),
      runtime: z.string().trim().min(1).max(128),
      status: RuntimeConfigOutcomeStatusV1Schema,
      timing: RuntimeConfigOutcomeTimingV1Schema.optional(),
      reason: z.string().trim().min(1).max(256).optional(),
      message: z.string().trim().min(1).max(2_000),
      changes: z.array(RuntimeConfigOutcomeChangeV1Schema).max(20).optional(),
    }),
  ),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('context-compaction'),
      phase: ContextCompactionPhaseSchema,
      provider: z.string().trim().min(1).optional(),
      backendId: z.string().trim().min(1).optional(),
      agentId: z.string().trim().min(1).optional(),
      trigger: z.enum(['manual', 'auto', 'threshold', 'overflow', 'unknown']).optional(),
      source: ContextCompactionSourceSchema.optional(),
      providerEventId: z.string().optional(),
      providerSessionId: z.string().optional(),
      turnId: z.string().optional(),
      tokenCountBefore: z.number().optional(),
      tokenCountAfter: z.number().optional(),
      tokenCountSource: z.string().optional(),
      retryAttempt: z.number().int().nonnegative().optional(),
      errorCode: z.string().optional(),
      sanitizedErrorPreview: z.string().optional(),
      continuation: ContextCompactionContinuationSchema.optional(),
      pauseReason: ContextCompactionPauseReasonSchema.optional(),
    })
  ),
  withAgentEventLifecycle(z.object({ type: z.literal('limit-reached'), endsAt: z.number() })),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('connected-service-account-switch'),
      serviceId: ConnectedServiceIdSchema,
      groupId: ConnectedServiceAuthGroupIdSchema.nullable(),
      groupLabel: z.string().trim().min(1).nullable().optional(),
      fromProfileId: ConnectedServiceProfileIdSchema.nullable(),
      toProfileId: ConnectedServiceProfileIdSchema.nullable(),
      fromProfileLabel: z.string().trim().min(1).nullable().optional(),
      toProfileLabel: z.string().trim().min(1).nullable().optional(),
      reason: ConnectedServiceAccountSwitchReasonSchema,
      mode: ConnectedServiceAccountSwitchModeSchema,
      resetAtMs: z.number().int().nonnegative().optional(),
      effectiveRemainingPct: z.number().finite().min(0).max(100).optional(),
    }),
  ),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('connected-service-account-switch-deferral'),
      policy: ConnectedServiceAccountSwitchDeferralPolicySchema,
      awaitingBoundary: z.boolean(),
      timeoutMs: z.number().int().nonnegative(),
    }),
  ),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('connected-service-account-switch-deferral-completed'),
      policy: ConnectedServiceAccountSwitchDeferralPolicySchema,
      reason: ConnectedServiceAccountSwitchDeferralCompletionReasonSchema,
    }),
  ),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('connected-service-account-switch-deferral-superseded'),
      policy: ConnectedServiceAccountSwitchDeferralPolicySchema.optional(),
    }),
  ),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('connected-service-account-switch-attempt'),
      ok: z.boolean(),
      action: z.enum(['restart_requested', 'hot_applied', 'metadata_updated']),
      attemptedContinuityMode: ConnectedServiceSwitchAttemptedContinuityModeV1Schema.optional(),
      outcome: ConnectedServiceSwitchAttemptOutcomeV1Schema.optional(),
      outcomeAction: ConnectedServiceSwitchAttemptOutcomeActionV1Schema.optional(),
      errorCode: z.string().trim().min(1).nullable().optional(),
      diagnostic: ConnectedServiceUxDiagnosticV1Schema.optional(),
      groupGeneration: z.number().int().nonnegative().optional(),
      sessionAdoption: ConnectedServiceSwitchAttemptSessionAdoptionV1Schema.optional(),
      sessionAdoptedGeneration: z.number().int().nonnegative().optional(),
      partialState: z
        .enum(['metadata_may_reference_new_binding', 'runtime_auth_applied', 'runtime_auth_partially_applied'])
        .nullable()
        .optional(),
      verificationByServiceId: ConnectedServiceSwitchAttemptVerificationByServiceIdV1Schema.optional(),
    }),
  ),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('connected-service-runtime-auth-recovery'),
      status: ConnectedServiceRuntimeAuthRecoveryTranscriptStatusV1Schema,
      serviceId: ConnectedServiceIdSchema,
      profileId: ConnectedServiceProfileIdSchema.optional(),
      groupId: ConnectedServiceAuthGroupIdSchema.optional(),
      attempt: z.number().int().positive().optional(),
      nextRetryAtMs: z.number().int().nonnegative().nullable().optional(),
      terminal: z.boolean().optional(),
      diagnostic: ConnectedServiceUxDiagnosticV1Schema.optional(),
      reason: z.string().trim().min(1).optional(),
    }),
  ),
  ProviderStateSharingDegradedEventSchema,
  withAgentEventLifecycle(
    z.object({
      type: z.literal('provider-quota-wait'),
      serviceId: ConnectedServiceIdSchema,
      profileId: ConnectedServiceProfileIdSchema.optional(),
      groupId: ConnectedServiceAuthGroupIdSchema.optional(),
      resetAtMs: z.number().int().nonnegative(),
      reason: z.string().trim().min(1),
    }),
  ),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('provider-quota-recovered'),
      serviceId: ConnectedServiceIdSchema,
      profileId: ConnectedServiceProfileIdSchema.optional(),
      groupId: ConnectedServiceAuthGroupIdSchema.optional(),
      reason: z.string().trim().min(1).optional(),
    }),
  ),
  withAgentEventLifecycle(
    z.object({
      type: z.literal('task-lifecycle'),
      event: z.enum(['task_started', 'task_complete', 'turn_failed', 'turn_cancelled', 'turn_aborted']),
      id: z.string().nullable().optional(),
    })
  ),
  withAgentEventLifecycle(z.object({ type: z.literal('ready') })),
]).superRefine((event, ctx) => {
  if (event.type === 'context-compaction') {
    addContextCompactionEventContinuationIssues(event as Record<string, unknown>, ctx, []);
  }
  const eventRecord = event as Record<string, unknown>;
  addConnectedServiceAccountSwitchAttemptEventIssues(eventRecord, ctx);
  addConnectedServiceRuntimeAuthRecoveryEventIssues(eventRecord, ctx);
});

const RawAgentRecordSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('output'),
      data: RawAgentOutputDataSchema,
    }),
    z.object({ type: z.literal('event'), id: z.string(), data: AgentEventSchema }).passthrough(),
    z
      .object({
        type: z.literal('codex'),
        data: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('reasoning'), message: z.string(), sidechainId: z.string().optional() }),
            z.object({ type: z.literal('message'), message: z.string(), sidechainId: z.string().optional() }),
            z.object({ type: z.literal('token_count'), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('task_started'), id: z.string().optional(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('task_complete'), id: z.string().optional(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('turn_failed'), id: z.string().optional(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('turn_cancelled'), id: z.string().optional(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('turn_aborted'), id: z.string().optional(), sidechainId: z.string().optional() }).passthrough(),
            z
              .object({
                type: z.literal('tool-call'),
                callId: z.string(),
                input: z.unknown(),
                name: z.string(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('tool-call-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('tool-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
          ])
          ,
      })
      .passthrough(),
    z
      .object({
        type: z.literal('acp'),
        provider: z.string().trim().min(1),
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
            z.object({ type: z.literal('reasoning'), message: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('message'), message: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('thinking'), text: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z
              .object({
                type: z.literal('tool-call'),
                callId: z.string(),
                input: z.unknown(),
                name: z.string(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('tool-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.string(),
                isError: z.boolean().optional(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('tool-call-result'),
                callId: z.string(),
                output: z.unknown(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('file-edit'),
                description: z.string(),
                filePath: z.string(),
                diff: z.string().optional(),
                oldContent: z.string().optional(),
                newContent: z.string().optional(),
                id: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z
              .object({
                type: z.literal('terminal-output'),
                data: z.string(),
                callId: z.string(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z.object({ type: z.literal('task_started'), id: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('task_complete'), id: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('turn_failed'), id: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('turn_cancelled'), id: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z.object({ type: z.literal('turn_aborted'), id: z.string(), sidechainId: z.string().optional() }).passthrough(),
            z
              .object({
                type: z.literal('permission-request'),
                permissionId: z.string(),
                toolName: z.string(),
                description: z.string(),
                options: z.unknown().optional(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
            z.object({ type: z.literal('token_count'), sidechainId: z.string().optional() }).passthrough(),
            z
              .object({
                type: z.literal('context-compaction'),
                phase: ContextCompactionPhaseSchema,
                lifecycleId: z.string().trim().min(1).optional(),
                provider: z.string().trim().min(1).optional(),
                backendId: z.string().trim().min(1).optional(),
                agentId: z.string().trim().min(1).optional(),
                trigger: z.enum(['manual', 'auto', 'threshold', 'overflow', 'unknown']).optional(),
                source: ContextCompactionSourceSchema.optional(),
                providerEventId: z.string().optional(),
                providerSessionId: z.string().optional(),
                turnId: z.string().optional(),
                tokenCountBefore: z.number().optional(),
                tokenCountAfter: z.number().optional(),
                tokenCountSource: z.string().optional(),
                retryAttempt: z.number().int().nonnegative().optional(),
                errorCode: z.string().optional(),
                sanitizedErrorPreview: z.string().optional(),
                continuation: ContextCompactionContinuationSchema.optional(),
                pauseReason: ContextCompactionPauseReasonSchema.optional(),
                sidechainId: z.string().optional(),
              })
              .passthrough(),
          ]);

          const unknown = z
            .object({ type: z.string() })
            .passthrough()
            .refine((value) => !knownTypes.has(value.type as any), {
              message: 'Unknown ACP data type must not collide with known types',
            });

          return z.union([known, unknown]);
        }),
      })
      .passthrough(),
  ])
  ;

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
): z.ZodType<TranscriptRawRecordV1WithMeta<SessionMessageMeta>>;
export function createTranscriptRawRecordV1Schema<MetaSchema extends z.ZodTypeAny>(
  zod: typeof z,
  options: Readonly<{
    metaSchema: MetaSchema;
  }>,
) : z.ZodType<TranscriptRawRecordV1WithMeta<z.infer<MetaSchema>>>;
export function createTranscriptRawRecordV1Schema<MetaSchema extends z.ZodTypeAny>(
  zod: typeof z,
  options?: Readonly<{
    metaSchema?: MetaSchema;
  }>,
) {
  const metaSchema = options?.metaSchema ?? createSessionMessageMetaSchema(zod);

  return zod.preprocess(
    preprocessMessageContent,
    zod.discriminatedUnion('role', [
      zod
        .object({
          role: zod.literal('agent'),
          content: RawAgentRecordSchema,
          meta: metaSchema.optional(),
        })
        .passthrough(),
      zod
        .object({
          role: zod.literal('user'),
          content: zod
            .object({
              type: zod.literal('text'),
              text: zod.string(),
            })
            .passthrough(),
          meta: metaSchema.optional(),
        })
        .passthrough(),
    ]),
  ).superRefine(addRawRecordContextCompactionContinuationIssues);
}

export const TranscriptRawRecordV1Schema = createTranscriptRawRecordV1Schema(z);
export type TranscriptRawRecordV1 = z.infer<typeof TranscriptRawRecordV1Schema>;

export const TranscriptRawUsageDataV1Schema = UsageDataSchema;
export type TranscriptRawUsageDataV1 = z.infer<typeof TranscriptRawUsageDataV1Schema>;

export const TranscriptRawAgentEventV1Schema = AgentEventSchema;
export type TranscriptRawAgentEventV1 = z.infer<typeof TranscriptRawAgentEventV1Schema>;

export const SessionMessageAttentionImpactSchema = z.object({
  affectsUnread: z.boolean(),
  affectsMeaningfulActivity: z.boolean(),
}).strict();
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
  'connected-service-account-switch',
  'connected-service-account-switch-deferral',
  'connected-service-account-switch-deferral-completed',
  'connected-service-account-switch-deferral-superseded',
  'connected-service-account-switch-attempt',
  'provider-state-sharing-degraded',
]);

function readAgentEventType(value: Pick<TranscriptRawAgentEventV1, 'type'> | null | undefined): TranscriptRawAgentEventV1['type'] | null {
  return typeof value?.type === 'string'
    ? value.type as TranscriptRawAgentEventV1['type']
    : null;
}

export function agentEventAttentionImpact(event: Pick<TranscriptRawAgentEventV1, 'type'> | null | undefined): SessionMessageAttentionImpact {
  const type = readAgentEventType(event);
  return type !== null && AGENT_EVENT_TYPES_WITHOUT_USER_ATTENTION.has(type)
    ? SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT
    : SESSION_MESSAGE_USER_ATTENTION_IMPACT;
}

export const TranscriptRawAgentContentV1Schema = RawAgentContentSchema;
export type TranscriptRawAgentContentV1 = z.infer<typeof TranscriptRawAgentContentV1Schema>;

export const TranscriptRawAgentRecordV1Schema = RawAgentRecordSchema;
export type TranscriptRawAgentRecordV1 = z.infer<typeof TranscriptRawAgentRecordV1Schema>;
