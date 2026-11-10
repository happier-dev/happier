import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import {
  SkillCatalogItemV1Schema,
  SkillCatalogV1Schema,
} from '../../../runtime/catalog/skills.js';
import {
  VendorPluginCatalogItemV1Schema,
  VendorPluginCatalogV1Schema,
} from '../../../runtime/catalog/vendorPlugins.js';
import { SESSION_PENDING_QUEUE_DELIVERY_TIMINGS } from '../../../account/settings/sessionPendingQueueDeliveryTiming.js';
import {
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  type SessionUsageLimitRecoveryOperationResultV1,
} from '../../control/sessionUsageLimitRecoveryOperationResultV1.js';
import { SessionUsageLimitRecoveryResumePromptModeV1Schema } from '../../state/valueSchemas/usageLimitRecovery.js';
import { ConnectedAccountServiceKeyIngressSchema } from '../../../connect/connectedServiceBindings.js';
import { ConnectedServiceQuotaSnapshotV1Schema } from '../../../connect/connectedServiceSchemas.js';
import { SessionWorkStateStatusV1Schema, SessionWorkStateV1Schema } from './sessionWorkStateV1.js';
import { PendingLocalIdSchema } from '../../pending/pendingLocalId.js';

export const SessionWorkStateGetRequestV1Schema = lazyZodSchema(() => z.looseObject({}));
export type SessionWorkStateGetRequestV1 = z.infer<typeof SessionWorkStateGetRequestV1Schema>;

export const SessionWorkStateGetResponseV1Schema = lazyZodSchema(() => z.looseObject({
    workState: z.nullable(SessionWorkStateV1Schema),
  }));
export type SessionWorkStateGetResponseV1 = z.infer<typeof SessionWorkStateGetResponseV1Schema>;

export const SessionGoalGetRequestV1Schema = lazyZodSchema(() => z.looseObject({ capabilitiesOnly: z.optional(z.boolean()) }));
export type SessionGoalGetRequestV1 = z.infer<typeof SessionGoalGetRequestV1Schema>;

const sessionGoalMutationHasField = (value: Readonly<{
  objective?: unknown;
  status?: unknown;
  tokenBudget?: unknown;
}>): boolean => (
  typeof value.objective === 'string'
  || typeof value.status === 'string'
  || Object.prototype.hasOwnProperty.call(value, 'tokenBudget')
);

const SessionGoalMutationFieldsV1Schema = lazyZodSchema(() => z.looseObject({
    objective: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4000))),
    status: z.optional(SessionWorkStateStatusV1Schema),
    tokenBudget: z.optional(z.nullable(z.number().check(z.positive()))),
  }).check(z.refine(sessionGoalMutationHasField, { message: 'At least one goal mutation field is required' })));

export const SessionGoalSetRequestV1Schema = SessionGoalMutationFieldsV1Schema;
export type SessionGoalSetRequestV1 = z.infer<typeof SessionGoalSetRequestV1Schema>;

export const SessionInitialGoalRequestV1Schema = lazyZodSchema(() => SessionGoalSetRequestV1Schema.check(z.refine((value) => typeof value.objective === 'string' && value.objective.trim().length > 0, { message: 'Initial goal requires an objective' })));
export type SessionInitialGoalRequestV1 = z.infer<typeof SessionInitialGoalRequestV1Schema>;

export const SessionGoalClearRequestV1Schema = lazyZodSchema(() => z.looseObject({}));
export type SessionGoalClearRequestV1 = z.infer<typeof SessionGoalClearRequestV1Schema>;

/** Content-free settlement evidence; never carry the native error or command here. */
export const SessionGoalControlFailureV1Schema = lazyZodSchema(() => z.strictObject({
  phase: z.enum(['native_effect', 'provider_completion', 'tail_drain',
    'missing_matching_publication', 'host_publication_rejected']),
}));
export type SessionGoalControlFailureV1 = z.infer<typeof SessionGoalControlFailureV1Schema>;

export const SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema = lazyZodSchema(() => z.looseObject({}));
export type SessionConnectedServiceAuthInvalidateTransportsRequestV1 =
  z.infer<typeof SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema>;

const ConnectedServiceQuotaRecoveryCreditIdempotencyKeyV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const ConnectedServiceQuotaRecoveryCreditProviderCreditIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

export const ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema = lazyZodSchema(() => z.looseObject({
    serviceId: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => (typeof value === 'string' ? value.trim() : value)), ConnectedAccountServiceKeyIngressSchema),
    profileId: z.string().check(z.trim(), z.minLength(1)),
    idempotencyKey: ConnectedServiceQuotaRecoveryCreditIdempotencyKeyV1Schema,
    providerCreditId: z.optional(ConnectedServiceQuotaRecoveryCreditProviderCreditIdV1Schema),
  }));
export type ConnectedServiceQuotaRecoveryCreditConsumeRequestV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema = lazyZodSchema(() => z.enum([
  'consumed',
  'already_consumed',
  'not_available',
  'nothing_to_reset',
  'unknown_after_timeout',
]));
export type ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema = lazyZodSchema(() => z.looseObject({
    idempotencyKey: ConnectedServiceQuotaRecoveryCreditIdempotencyKeyV1Schema,
    providerCreditId: z.optional(ConnectedServiceQuotaRecoveryCreditProviderCreditIdV1Schema),
    status: ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema,
  }));
export type ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.looseObject({
      ok: z.literal(true),
      snapshot: z.nullable(ConnectedServiceQuotaSnapshotV1Schema),
      receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema,
    }),
  z.looseObject({
      ok: z.literal(false),
      error: z.string().check(z.trim(), z.minLength(1)),
      errorCode: z.string().check(z.trim(), z.minLength(1)),
      receipt: z.optional(ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema),
    }),
]));
export type ConnectedServiceQuotaRecoveryCreditConsumeResponseV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema>;

const ConnectedServiceRuntimeControlIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const ConnectedServiceRuntimeControlServiceIdV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => (typeof value === 'string' ? value.trim() : value)), ConnectedAccountServiceKeyIngressSchema));
const ConnectedServiceRuntimeControlGenerationV1Schema = lazyZodSchema(() => z.union([
  z.string().check(z.trim(), z.minLength(1)),
  z.number().check(z.int(), z.nonnegative()),
]));
const ConnectedServiceRuntimeControlExpectedV1Schema = lazyZodSchema(() => z.looseObject({
    profileId: z.optional(ConnectedServiceRuntimeControlIdV1Schema),
    groupId: z.optional(ConnectedServiceRuntimeControlIdV1Schema),
    generation: z.optional(ConnectedServiceRuntimeControlGenerationV1Schema),
    credentialRevision: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }));

function hasNonEmptyStringField(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean {
  return fields.some((field) => {
    const candidate = value[field];
    return typeof candidate === 'string' && candidate.trim().length > 0;
  });
}

export const SessionConnectedServiceAuthApplyGenerationReasonV1Schema = lazyZodSchema(() => z.enum([
  'usage_limit',
  'same_provider_account_exhausted',
  'soft_threshold',
  'manual',
  'diagnostic',
]));
export type SessionConnectedServiceAuthApplyGenerationReasonV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationReasonV1Schema>;

export const SessionConnectedServiceAuthApplyGenerationAppliedViaV1Schema = lazyZodSchema(() => z.union([
  z.enum([
    'direct_live_hot_auth',
    'transport_recycle',
    'restart_resume',
    'spawn_next_turn',
  ]),
  z.string().check(z.trim(), z.minLength(1)),
]));
export type SessionConnectedServiceAuthApplyGenerationAppliedViaV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationAppliedViaV1Schema>;

export const SessionConnectedServiceAuthApplyGenerationRequestV1Schema = lazyZodSchema(() => z.looseObject({
    serviceId: ConnectedServiceRuntimeControlServiceIdV1Schema,
    reason: SessionConnectedServiceAuthApplyGenerationReasonV1Schema,
    expected: z.optional(ConnectedServiceRuntimeControlExpectedV1Schema),
    authGeneration: z
      .record(z.string(), z.unknown()).check(z.refine((value) => Object.keys(value).length > 0, {
        message: 'authGeneration must be non-empty',
      })),
  }));
export type SessionConnectedServiceAuthApplyGenerationRequestV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationRequestV1Schema>;

const SessionConnectedServiceAuthApplyGenerationVerificationV1Schema = lazyZodSchema(() => z
  .record(z.string(), z.unknown()).check(z.superRefine((value, ctx) => {
    if (value.proofStrength !== 'exact') return;
    if (hasNonEmptyStringField(value, ['providerAccountId', 'activeAccountId', 'sharedAuthSurfaceId'])) return;
    ctx.addIssue({
      code: 'custom',
      message: 'exact verification requires identity material',
      path: ['proofStrength'],
    });
  })));

export const SessionConnectedServiceAuthApplyGenerationResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      appliedVia: SessionConnectedServiceAuthApplyGenerationAppliedViaV1Schema,
      activeAccountId: z.optional(z.string().check(z.trim(), z.minLength(1))),
      recovery: z.optional(z.unknown()),
      verification: z.optional(SessionConnectedServiceAuthApplyGenerationVerificationV1Schema),
      quotaSnapshotRef: z.optional(z.string().check(z.trim(), z.minLength(1))),
    }),
  z.looseObject({
      ok: z.literal(false),
      error: z.string().check(z.trim(), z.minLength(1)),
      errorCode: z.optional(z.string().check(z.trim(), z.minLength(1))),
      diagnostics: z.optional(z.array(z.record(z.string(), z.unknown()))),
    }),
]));
export type SessionConnectedServiceAuthApplyGenerationResponseV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationResponseV1Schema>;

export const SessionConnectedServiceAuthReadRuntimeIdentityReasonV1Schema = lazyZodSchema(() => z.enum([
  'same_provider_account_exhausted',
  'soft_threshold',
  'diagnostic',
  'usage_limit',
  'manual',
]));
export type SessionConnectedServiceAuthReadRuntimeIdentityReasonV1 =
  z.infer<typeof SessionConnectedServiceAuthReadRuntimeIdentityReasonV1Schema>;

export const SessionConnectedServiceAuthRuntimeIdentityStrategyV1Schema = lazyZodSchema(() => z.enum([
  'provider_account_id',
  'shared_group_auth_surface',
  'none',
]));
export type SessionConnectedServiceAuthRuntimeIdentityStrategyV1 =
  z.infer<typeof SessionConnectedServiceAuthRuntimeIdentityStrategyV1Schema>;

export const SessionConnectedServiceAuthRuntimeIdentityProofStrengthV1Schema = lazyZodSchema(() => z.enum([
  'exact',
  'diagnostic',
  'none',
  'unknown',
]));
export type SessionConnectedServiceAuthRuntimeIdentityProofStrengthV1 =
  z.infer<typeof SessionConnectedServiceAuthRuntimeIdentityProofStrengthV1Schema>;

export const SessionConnectedServiceAuthReadRuntimeIdentityRequestV1Schema = lazyZodSchema(() => z.looseObject({
    serviceId: ConnectedServiceRuntimeControlServiceIdV1Schema,
    reason: SessionConnectedServiceAuthReadRuntimeIdentityReasonV1Schema,
    requireExactProof: z.optional(z.boolean()),
    expected: z.optional(ConnectedServiceRuntimeControlExpectedV1Schema),
  }));
export type SessionConnectedServiceAuthReadRuntimeIdentityRequestV1 =
  z.infer<typeof SessionConnectedServiceAuthReadRuntimeIdentityRequestV1Schema>;

const SessionConnectedServiceAuthRuntimeIdentityV1Schema = lazyZodSchema(() => z.looseObject({
    strategy: SessionConnectedServiceAuthRuntimeIdentityStrategyV1Schema,
    proofStrength: SessionConnectedServiceAuthRuntimeIdentityProofStrengthV1Schema,
    providerAccountId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    sharedAuthSurfaceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    accountLabel: z.optional(z.string().check(z.trim(), z.minLength(1))),
    source: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }).check(z.superRefine((identity, ctx) => {
    if (identity.proofStrength !== 'exact') return;
    if (identity.strategy === 'provider_account_id' && identity.providerAccountId) return;
    if (identity.strategy === 'shared_group_auth_surface' && identity.sharedAuthSurfaceId) return;
    ctx.addIssue({
      code: 'custom',
      message: 'exact runtime identity requires strategy identity material',
      path: ['proofStrength'],
    });
  })));

export const SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      serviceId: ConnectedServiceRuntimeControlServiceIdV1Schema,
      identity: SessionConnectedServiceAuthRuntimeIdentityV1Schema,
      runtime: z.optional(z.looseObject({
          safeToProbe: z.optional(z.boolean()),
          safeToApply: z.optional(z.boolean()),
          inProviderTurn: z.optional(z.boolean()),
          profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
          groupId: z.optional(z.string().check(z.trim(), z.minLength(1))),
          generation: z.optional(ConnectedServiceRuntimeControlGenerationV1Schema),
          credentialRevision: z.optional(z.string().check(z.trim(), z.minLength(1))),
        })),
    }),
  z.looseObject({
      ok: z.literal(false),
      error: z.string().check(z.trim(), z.minLength(1)),
      errorCode: z.optional(z.string().check(z.trim(), z.minLength(1))),
      diagnostics: z.optional(z.array(z.record(z.string(), z.unknown()))),
    }),
]));
export type SessionConnectedServiceAuthReadRuntimeIdentityResponseV1 =
  z.infer<typeof SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema>;

export const SessionPendingQueueMaterializeNextRequestV1Schema = lazyZodSchema(() => z.looseObject({
    reconcileWhenEmpty: z.optional(z.enum(['force', 'throttled', 'skip'])),
    deliveryTiming: z.optional(z.enum(SESSION_PENDING_QUEUE_DELIVERY_TIMINGS)),
  }));
export type SessionPendingQueueMaterializeNextRequestV1 =
  z.infer<typeof SessionPendingQueueMaterializeNextRequestV1Schema>;

const SessionIdRequestFieldSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const IssueFingerprintFieldSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

function normalizeLegacyUsageLimitAgentIdentity(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, 'provider')) return value;
  const legacyAgentId = typeof record.provider === 'string' ? record.provider.trim() : '';
  const hasAgentId = Object.hasOwn(record, 'agentId');
  const agentId = typeof record.agentId === 'string' ? record.agentId.trim() : '';
  if (!legacyAgentId || (hasAgentId && (!agentId || agentId !== legacyAgentId))) return undefined;
  const { provider: _legacyProvider, ...rest } = record;
  return hasAgentId ? rest : { ...rest, agentId: legacyAgentId };
}

export const SessionUsageLimitWaitResumeEnableRequestV1Schema = lazyZodSchema(() => z.looseObject({
    sessionId: SessionIdRequestFieldSchema,
    issueFingerprint: z.optional(IssueFingerprintFieldSchema),
    remember: z.optional(z.boolean()),
    rememberPreference: z.optional(z.boolean()),
    resumePromptMode: z.optional(SessionUsageLimitRecoveryResumePromptModeV1Schema),
  }));
export type SessionUsageLimitWaitResumeEnableRequestV1 = z.infer<typeof SessionUsageLimitWaitResumeEnableRequestV1Schema>;

export const SessionUsageLimitWaitResumeCancelRequestV1Schema = lazyZodSchema(() => z.looseObject({
    sessionId: SessionIdRequestFieldSchema,
    issueFingerprint: z.optional(z.nullable(IssueFingerprintFieldSchema)),
    armedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    runtimeAuthRecoveryAttemptId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }));
export type SessionUsageLimitWaitResumeCancelRequestV1 = z.infer<typeof SessionUsageLimitWaitResumeCancelRequestV1Schema>;

const SessionUsageLimitCheckNowCanonicalRequestV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionIdRequestFieldSchema,
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  operation: z.optional(z.enum(['check_now', 'switch_account_now'])),
  resumePromptMode: z.optional(SessionUsageLimitRecoveryResumePromptModeV1Schema),
}));

export type SessionUsageLimitCheckNowRequestV1Input = z.input<
  typeof SessionUsageLimitCheckNowCanonicalRequestV1Schema
> & Readonly<{ provider?: string }>;

export const SessionUsageLimitCheckNowRequestV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform<SessionUsageLimitCheckNowRequestV1Input, unknown>(normalizeLegacyUsageLimitAgentIdentity), SessionUsageLimitCheckNowCanonicalRequestV1Schema));
export type SessionUsageLimitCheckNowRequestV1 = z.infer<typeof SessionUsageLimitCheckNowRequestV1Schema>;

const SessionUsageLimitConsumeResetCreditCanonicalRequestV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionIdRequestFieldSchema,
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  issueFingerprint: z.optional(IssueFingerprintFieldSchema),
  resumePromptMode: z.optional(SessionUsageLimitRecoveryResumePromptModeV1Schema),
}));

export type SessionUsageLimitConsumeResetCreditRequestV1Input = z.input<
  typeof SessionUsageLimitConsumeResetCreditCanonicalRequestV1Schema
> & Readonly<{ provider?: string }>;

export const SessionUsageLimitConsumeResetCreditRequestV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform<SessionUsageLimitConsumeResetCreditRequestV1Input, unknown>(normalizeLegacyUsageLimitAgentIdentity), SessionUsageLimitConsumeResetCreditCanonicalRequestV1Schema));
export type SessionUsageLimitConsumeResetCreditRequestV1 =
  z.infer<typeof SessionUsageLimitConsumeResetCreditRequestV1Schema>;

export const SessionUsageLimitOperationResponseV1Schema = lazyZodSchema(() => z.pipe(z
  .unknown(), z.transform((value): SessionUsageLimitRecoveryOperationResultV1 => (
    normalizeSessionUsageLimitRecoveryOperationResultV1(value)
  ))));
export type SessionUsageLimitOperationResponseV1 = z.infer<typeof SessionUsageLimitOperationResponseV1Schema>;

export const SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true) }),
  z.looseObject({
    ok: z.literal(false),
    error: z.string().check(z.trim(), z.minLength(1)),
    errorCode: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
]));
export type SessionConnectedServiceAuthInvalidateTransportsResponseV1 =
  z.infer<typeof SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema>;

export const SessionPendingQueueMaterializeNextResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
    type: z.literal('materialized'),
    localId: PendingLocalIdSchema,
    seq: z.nullable(z.number().check(z.int(), z.nonnegative())),
    content: z.unknown(),
    createdAt: z.optional(z.number()),
    updatedAt: z.optional(z.number()),
  }),
  z.looseObject({ type: z.literal('no_pending') }),
  z.looseObject({
    type: z.literal('deferred'),
    reason: z.enum(['supervisor_offline', 'supervisor_auth_failed', 'runtime_activity_active']),
  }),
]));
export type SessionPendingQueueMaterializeNextResponseV1 =
  z.infer<typeof SessionPendingQueueMaterializeNextResponseV1Schema>;

export const SessionUsageLimitWaitResumeEnableResponseV1Schema = SessionUsageLimitOperationResponseV1Schema;
export type SessionUsageLimitWaitResumeEnableResponseV1 =
  z.infer<typeof SessionUsageLimitWaitResumeEnableResponseV1Schema>;

export const SessionUsageLimitWaitResumeCancelResponseV1Schema = SessionUsageLimitOperationResponseV1Schema;
export type SessionUsageLimitWaitResumeCancelResponseV1 =
  z.infer<typeof SessionUsageLimitWaitResumeCancelResponseV1Schema>;

export const SessionUsageLimitCheckNowResponseV1Schema = SessionUsageLimitOperationResponseV1Schema;
export type SessionUsageLimitCheckNowResponseV1 = z.infer<typeof SessionUsageLimitCheckNowResponseV1Schema>;

export const SessionUsageLimitConsumeResetCreditResponseV1Schema = SessionUsageLimitOperationResponseV1Schema;
export type SessionUsageLimitConsumeResetCreditResponseV1 =
  z.infer<typeof SessionUsageLimitConsumeResetCreditResponseV1Schema>;

export const DaemonSessionGoalGetRequestV1Schema = lazyZodSchema(() => z.looseObject({
    sessionId: z.string().check(z.trim(), z.minLength(1)),
  }));
export type DaemonSessionGoalGetRequestV1 = z.infer<typeof DaemonSessionGoalGetRequestV1Schema>;

export const DaemonSessionGoalSetRequestV1Schema = lazyZodSchema(() => z.looseObject({
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    objective: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4000))),
    status: z.optional(SessionWorkStateStatusV1Schema),
    tokenBudget: z.optional(z.nullable(z.number().check(z.positive()))),
  }).check(z.refine(sessionGoalMutationHasField, { message: 'At least one goal mutation field is required' })));
export type DaemonSessionGoalSetRequestV1 = z.infer<typeof DaemonSessionGoalSetRequestV1Schema>;

/** Wake intent cannot be silently ignored by a V1 daemon. */
export const DaemonSessionGoalSetRequestV2Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  objective: z.string().check(z.trim(), z.minLength(1), z.maxLength(4000)),
  status: z.optional(SessionWorkStateStatusV1Schema),
  tokenBudget: z.optional(z.nullable(z.number().check(z.positive()))),
  resumeInactiveWithInitialGoal: z.literal(true),
}));
export type DaemonSessionGoalSetRequestV2 = z.infer<typeof DaemonSessionGoalSetRequestV2Schema>;

export const DaemonSessionGoalClearRequestV1Schema = lazyZodSchema(() => z.looseObject({
    sessionId: z.string().check(z.trim(), z.minLength(1)),
  }));
export type DaemonSessionGoalClearRequestV1 = z.infer<typeof DaemonSessionGoalClearRequestV1Schema>;

// Compatibility alias for pre-A.8y clients. New writers must emit
// VendorPluginCatalogItemV1; remove this union arm after deployed clients no
// longer consume daemon.sessionVendorPluginCatalog.list legacy rows.
export const SessionVendorPluginSummaryV1Schema = lazyZodSchema(() => z.pipe(z.looseObject({
    vendorPluginRef: z.string().check(z.minLength(1)),
    name: z.string().check(z.minLength(1)),
    displayName: z.optional(z.string().check(z.minLength(1))),
    description: z.optional(z.string().check(z.minLength(1))),
    installed: z.optional(z.boolean()),
    enabled: z.optional(z.boolean()),
    mentionable: z.optional(z.boolean()),
  }), z.transform((item) => ({
    ...item,
    mentionable: item.mentionable ?? (item.installed === true && item.enabled === true),
  }))));
export type SessionVendorPluginSummaryV1 = z.infer<typeof SessionVendorPluginSummaryV1Schema>;

const SessionVendorPluginCatalogListItemV1Schema = lazyZodSchema(() => z.union([
  VendorPluginCatalogItemV1Schema,
  SessionVendorPluginSummaryV1Schema,
]));

export const SessionVendorPluginCatalogListRequestV1Schema = lazyZodSchema(() => z.looseObject({
    cwd: z.optional(z.string().check(z.minLength(1))),
  }));
export type SessionVendorPluginCatalogListRequestV1 = z.infer<typeof SessionVendorPluginCatalogListRequestV1Schema>;

export const DaemonSessionVendorPluginCatalogListRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(SessionVendorPluginCatalogListRequestV1Schema, {
    sessionId: z.string().check(z.trim(), z.minLength(1)),
  })));
export type DaemonSessionVendorPluginCatalogListRequestV1 = z.infer<typeof DaemonSessionVendorPluginCatalogListRequestV1Schema>;

export const SessionVendorPluginCatalogListResponseV1Schema = lazyZodSchema(() => z.pipe(z.looseObject({
    catalog: z.optional(VendorPluginCatalogV1Schema),
    vendorPlugins: z._default(z.array(SessionVendorPluginCatalogListItemV1Schema), []),
    unsupported: z.optional(z.boolean()),
  }), z.transform((response) => ({
    ...response,
    vendorPlugins: response.catalog?.items ?? response.vendorPlugins,
  }))));
export type SessionVendorPluginCatalogListResponseV1 = z.infer<typeof SessionVendorPluginCatalogListResponseV1Schema>;

export const SessionSkillCatalogItemV1Schema = SkillCatalogItemV1Schema;
export type SessionSkillCatalogItemV1 = z.infer<typeof SessionSkillCatalogItemV1Schema>;

export const SessionSkillCatalogListRequestV1Schema = SessionVendorPluginCatalogListRequestV1Schema;
export type SessionSkillCatalogListRequestV1 = z.infer<typeof SessionSkillCatalogListRequestV1Schema>;

export const DaemonSessionSkillCatalogListRequestV1Schema = DaemonSessionVendorPluginCatalogListRequestV1Schema;
export type DaemonSessionSkillCatalogListRequestV1 = z.infer<typeof DaemonSessionSkillCatalogListRequestV1Schema>;

export const SessionSkillCatalogListResponseV1Schema = lazyZodSchema(() => z.pipe(z.looseObject({
    catalog: z.optional(SkillCatalogV1Schema),
    skills: z._default(z.array(SessionSkillCatalogItemV1Schema), []),
    unsupported: z.optional(z.boolean()),
  }), z.transform((response) => ({
    ...response,
    skills: response.catalog?.items ?? response.skills,
  }))));
export type SessionSkillCatalogListResponseV1 = z.infer<typeof SessionSkillCatalogListResponseV1Schema>;

/** Native catalogs observed for a selected launch scope before a Happier session exists. */
export const PreflightSessionCatalogsV1Schema = lazyZodSchema(() => z.object({
  commands: z.object({
    supported: z.boolean(),
    items: z.array(z.object({ command: z.string().check(z.minLength(1)), description: z.optional(z.string()) })),
    diagnostic: z.optional(z.string()),
  }),
  skills: z.object({
    supported: z.boolean(),
    items: z.array(SessionSkillCatalogItemV1Schema),
    diagnostic: z.optional(z.string()),
  }),
}));
export type PreflightSessionCatalogsV1 = z.infer<typeof PreflightSessionCatalogsV1Schema>;
