import { z } from 'zod';

import {
  SkillCatalogItemV1Schema,
  SkillCatalogV1Schema,
  VendorPluginCatalogItemV1Schema,
  VendorPluginCatalogV1Schema,
} from '../../../runtime/catalog/index.js';
import { SESSION_PENDING_QUEUE_DELIVERY_TIMINGS } from '../../../account/settings/sessionPendingQueueDeliveryTiming.js';
import {
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  type SessionUsageLimitRecoveryOperationResultV1,
} from '../../control/sessionUsageLimitRecoveryOperationResultV1.js';
import { SessionUsageLimitRecoveryResumePromptModeV1Schema } from '../../state/valueSchemas/usageLimitRecovery.js';
import { ConnectedServiceIdSchema } from '../../../connect/connectedServiceBindings.js';
import { ConnectedServiceQuotaSnapshotV1Schema } from '../../../connect/connectedServiceSchemas.js';
import { SessionWorkStateStatusV1Schema, SessionWorkStateV1Schema } from './sessionWorkStateV1.js';
import { PendingLocalIdSchema } from '../../pending/pendingLocalId.js';

export const SessionWorkStateGetRequestV1Schema = z.object({}).passthrough();
export type SessionWorkStateGetRequestV1 = z.infer<typeof SessionWorkStateGetRequestV1Schema>;

export const SessionWorkStateGetResponseV1Schema = z
  .object({
    workState: SessionWorkStateV1Schema.nullable(),
  })
  .passthrough();
export type SessionWorkStateGetResponseV1 = z.infer<typeof SessionWorkStateGetResponseV1Schema>;

export const SessionGoalGetRequestV1Schema = z.object({}).passthrough();
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

const SessionGoalMutationFieldsV1Schema = z
  .object({
    objective: z.string().trim().min(1).max(4000).optional(),
    status: SessionWorkStateStatusV1Schema.optional(),
    tokenBudget: z.number().finite().positive().nullable().optional(),
  })
  .passthrough()
  .refine(sessionGoalMutationHasField, { message: 'At least one goal mutation field is required' });

export const SessionGoalSetRequestV1Schema = SessionGoalMutationFieldsV1Schema;
export type SessionGoalSetRequestV1 = z.infer<typeof SessionGoalSetRequestV1Schema>;

export const SessionInitialGoalRequestV1Schema = SessionGoalSetRequestV1Schema.refine(
  (value) => typeof value.objective === 'string' && value.objective.trim().length > 0,
  { message: 'Initial goal requires an objective' },
);
export type SessionInitialGoalRequestV1 = z.infer<typeof SessionInitialGoalRequestV1Schema>;

export const SessionGoalClearRequestV1Schema = z.object({}).passthrough();
export type SessionGoalClearRequestV1 = z.infer<typeof SessionGoalClearRequestV1Schema>;

export const SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema = z.object({}).passthrough();
export type SessionConnectedServiceAuthInvalidateTransportsRequestV1 =
  z.infer<typeof SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema>;

const ConnectedServiceQuotaRecoveryCreditIdempotencyKeyV1Schema = z.string().trim().min(1).max(256);
const ConnectedServiceQuotaRecoveryCreditProviderCreditIdV1Schema = z.string().trim().min(1).max(256);

export const ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema = z
  .object({
    serviceId: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim() : value),
      ConnectedServiceIdSchema,
    ),
    profileId: z.string().trim().min(1),
    idempotencyKey: ConnectedServiceQuotaRecoveryCreditIdempotencyKeyV1Schema,
    providerCreditId: ConnectedServiceQuotaRecoveryCreditProviderCreditIdV1Schema.optional(),
  })
  .passthrough();
export type ConnectedServiceQuotaRecoveryCreditConsumeRequestV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema = z.enum([
  'consumed',
  'already_consumed',
  'not_available',
  'nothing_to_reset',
  'unknown_after_timeout',
]);
export type ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema = z
  .object({
    idempotencyKey: ConnectedServiceQuotaRecoveryCreditIdempotencyKeyV1Schema,
    providerCreditId: ConnectedServiceQuotaRecoveryCreditProviderCreditIdV1Schema.optional(),
    status: ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema,
  })
  .passthrough();
export type ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      snapshot: ConnectedServiceQuotaSnapshotV1Schema.nullable(),
      receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema,
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().trim().min(1),
      errorCode: z.string().trim().min(1),
      receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema.optional(),
    })
    .passthrough(),
]);
export type ConnectedServiceQuotaRecoveryCreditConsumeResponseV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema>;

const ConnectedServiceRuntimeControlIdV1Schema = z.string().trim().min(1);
const ConnectedServiceRuntimeControlServiceIdV1Schema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  ConnectedServiceIdSchema,
);
const ConnectedServiceRuntimeControlGenerationV1Schema = z.union([
  z.string().trim().min(1),
  z.number().int().nonnegative(),
]);
const ConnectedServiceRuntimeControlExpectedV1Schema = z
  .object({
    profileId: ConnectedServiceRuntimeControlIdV1Schema.optional(),
    groupId: ConnectedServiceRuntimeControlIdV1Schema.optional(),
    generation: ConnectedServiceRuntimeControlGenerationV1Schema.optional(),
    credentialRevision: z.string().trim().min(1).optional(),
  })
  .passthrough();

function hasNonEmptyStringField(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean {
  return fields.some((field) => {
    const candidate = value[field];
    return typeof candidate === 'string' && candidate.trim().length > 0;
  });
}

export const SessionConnectedServiceAuthApplyGenerationReasonV1Schema = z.enum([
  'usage_limit',
  'same_provider_account_exhausted',
  'soft_threshold',
  'manual',
  'diagnostic',
]);
export type SessionConnectedServiceAuthApplyGenerationReasonV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationReasonV1Schema>;

export const SessionConnectedServiceAuthApplyGenerationAppliedViaV1Schema = z.union([
  z.enum([
    'direct_live_hot_auth',
    'transport_recycle',
    'restart_resume',
    'spawn_next_turn',
  ]),
  z.string().trim().min(1),
]);
export type SessionConnectedServiceAuthApplyGenerationAppliedViaV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationAppliedViaV1Schema>;

export const SessionConnectedServiceAuthApplyGenerationRequestV1Schema = z
  .object({
    serviceId: ConnectedServiceRuntimeControlServiceIdV1Schema,
    reason: SessionConnectedServiceAuthApplyGenerationReasonV1Schema,
    requireDirectLiveHotApply: z.boolean().optional(),
    expected: ConnectedServiceRuntimeControlExpectedV1Schema.optional(),
    authGeneration: z
      .record(z.string(), z.unknown())
      .refine((value) => Object.keys(value).length > 0, {
        message: 'authGeneration must be non-empty',
      }),
  })
  .passthrough();
export type SessionConnectedServiceAuthApplyGenerationRequestV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationRequestV1Schema>;

const SessionConnectedServiceAuthApplyGenerationVerificationV1Schema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    if (value.proofStrength !== 'exact') return;
    if (hasNonEmptyStringField(value, ['providerAccountId', 'activeAccountId', 'sharedAuthSurfaceId'])) return;
    ctx.addIssue({
      code: 'custom',
      message: 'exact verification requires identity material',
      path: ['proofStrength'],
    });
  });

export const SessionConnectedServiceAuthApplyGenerationResponseV1Schema = z.union([
  z
    .object({
      ok: z.literal(true),
      appliedVia: SessionConnectedServiceAuthApplyGenerationAppliedViaV1Schema,
      activeAccountId: z.string().trim().min(1).optional(),
      recovery: z.unknown().optional(),
      verification: SessionConnectedServiceAuthApplyGenerationVerificationV1Schema.optional(),
      quotaSnapshotRef: z.string().trim().min(1).optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().trim().min(1),
      errorCode: z.string().trim().min(1).optional(),
      diagnostics: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .passthrough(),
]);
export type SessionConnectedServiceAuthApplyGenerationResponseV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationResponseV1Schema>;

export const SessionConnectedServiceAuthReadRuntimeIdentityReasonV1Schema = z.enum([
  'same_provider_account_exhausted',
  'soft_threshold',
  'diagnostic',
  'usage_limit',
  'manual',
]);
export type SessionConnectedServiceAuthReadRuntimeIdentityReasonV1 =
  z.infer<typeof SessionConnectedServiceAuthReadRuntimeIdentityReasonV1Schema>;

export const SessionConnectedServiceAuthRuntimeIdentityStrategyV1Schema = z.enum([
  'provider_account_id',
  'shared_group_auth_surface',
  'none',
]);
export type SessionConnectedServiceAuthRuntimeIdentityStrategyV1 =
  z.infer<typeof SessionConnectedServiceAuthRuntimeIdentityStrategyV1Schema>;

export const SessionConnectedServiceAuthRuntimeIdentityProofStrengthV1Schema = z.enum([
  'exact',
  'diagnostic',
  'none',
  'unknown',
]);
export type SessionConnectedServiceAuthRuntimeIdentityProofStrengthV1 =
  z.infer<typeof SessionConnectedServiceAuthRuntimeIdentityProofStrengthV1Schema>;

export const SessionConnectedServiceAuthReadRuntimeIdentityRequestV1Schema = z
  .object({
    serviceId: ConnectedServiceRuntimeControlServiceIdV1Schema,
    reason: SessionConnectedServiceAuthReadRuntimeIdentityReasonV1Schema,
    requireExactProof: z.boolean().optional(),
    expected: ConnectedServiceRuntimeControlExpectedV1Schema.optional(),
  })
  .passthrough();
export type SessionConnectedServiceAuthReadRuntimeIdentityRequestV1 =
  z.infer<typeof SessionConnectedServiceAuthReadRuntimeIdentityRequestV1Schema>;

const SessionConnectedServiceAuthRuntimeIdentityV1Schema = z
  .object({
    strategy: SessionConnectedServiceAuthRuntimeIdentityStrategyV1Schema,
    proofStrength: SessionConnectedServiceAuthRuntimeIdentityProofStrengthV1Schema,
    providerAccountId: z.string().trim().min(1).optional(),
    sharedAuthSurfaceId: z.string().trim().min(1).optional(),
    accountLabel: z.string().trim().min(1).optional(),
    source: z.string().trim().min(1).optional(),
  })
  .passthrough()
  .superRefine((identity, ctx) => {
    if (identity.proofStrength !== 'exact') return;
    if (identity.strategy === 'provider_account_id' && identity.providerAccountId) return;
    if (identity.strategy === 'shared_group_auth_surface' && identity.sharedAuthSurfaceId) return;
    ctx.addIssue({
      code: 'custom',
      message: 'exact runtime identity requires strategy identity material',
      path: ['proofStrength'],
    });
  });

export const SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema = z.union([
  z
    .object({
      ok: z.literal(true),
      serviceId: ConnectedServiceRuntimeControlServiceIdV1Schema,
      identity: SessionConnectedServiceAuthRuntimeIdentityV1Schema,
      runtime: z
        .object({
          safeToProbe: z.boolean().optional(),
          safeToApply: z.boolean().optional(),
          inProviderTurn: z.boolean().optional(),
          profileId: z.string().trim().min(1).optional(),
          groupId: z.string().trim().min(1).optional(),
          generation: ConnectedServiceRuntimeControlGenerationV1Schema.optional(),
          credentialRevision: z.string().trim().min(1).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().trim().min(1),
      errorCode: z.string().trim().min(1).optional(),
      diagnostics: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .passthrough(),
]);
export type SessionConnectedServiceAuthReadRuntimeIdentityResponseV1 =
  z.infer<typeof SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema>;

export const SessionPendingQueueMaterializeNextRequestV1Schema = z
  .object({
    reconcileWhenEmpty: z.enum(['force', 'throttled', 'skip']).optional(),
    deliveryTiming: z.enum(SESSION_PENDING_QUEUE_DELIVERY_TIMINGS).optional(),
  })
  .passthrough();
export type SessionPendingQueueMaterializeNextRequestV1 =
  z.infer<typeof SessionPendingQueueMaterializeNextRequestV1Schema>;

const SessionIdRequestFieldSchema = z.string().trim().min(1);
const IssueFingerprintFieldSchema = z.string().trim().min(1);

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

export const SessionUsageLimitWaitResumeEnableRequestV1Schema = z
  .object({
    sessionId: SessionIdRequestFieldSchema,
    issueFingerprint: IssueFingerprintFieldSchema.optional(),
    remember: z.boolean().optional(),
    rememberPreference: z.boolean().optional(),
    resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.optional(),
  })
  .passthrough();
export type SessionUsageLimitWaitResumeEnableRequestV1 = z.infer<typeof SessionUsageLimitWaitResumeEnableRequestV1Schema>;

export const SessionUsageLimitWaitResumeCancelRequestV1Schema = z
  .object({
    sessionId: SessionIdRequestFieldSchema,
    issueFingerprint: IssueFingerprintFieldSchema.nullable().optional(),
    armedAtMs: z.number().int().nonnegative().optional(),
    runtimeAuthRecoveryAttemptId: z.string().trim().min(1).optional(),
  })
  .passthrough();
export type SessionUsageLimitWaitResumeCancelRequestV1 = z.infer<typeof SessionUsageLimitWaitResumeCancelRequestV1Schema>;

const SessionUsageLimitCheckNowCanonicalRequestV1Schema = z.object({
  sessionId: SessionIdRequestFieldSchema,
  agentId: z.string().trim().min(1).optional(),
  operation: z.enum(['check_now', 'switch_account_now']).optional(),
  resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.optional(),
}).passthrough();

export type SessionUsageLimitCheckNowRequestV1Input = z.input<
  typeof SessionUsageLimitCheckNowCanonicalRequestV1Schema
> & Readonly<{ provider?: string }>;

export const SessionUsageLimitCheckNowRequestV1Schema = z.preprocess<
  unknown,
  typeof SessionUsageLimitCheckNowCanonicalRequestV1Schema,
  SessionUsageLimitCheckNowRequestV1Input
>(
  normalizeLegacyUsageLimitAgentIdentity,
  SessionUsageLimitCheckNowCanonicalRequestV1Schema,
);
export type SessionUsageLimitCheckNowRequestV1 = z.infer<typeof SessionUsageLimitCheckNowRequestV1Schema>;

const SessionUsageLimitConsumeResetCreditCanonicalRequestV1Schema = z.object({
  sessionId: SessionIdRequestFieldSchema,
  agentId: z.string().trim().min(1).optional(),
  issueFingerprint: IssueFingerprintFieldSchema.optional(),
  resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.optional(),
}).passthrough();

export type SessionUsageLimitConsumeResetCreditRequestV1Input = z.input<
  typeof SessionUsageLimitConsumeResetCreditCanonicalRequestV1Schema
> & Readonly<{ provider?: string }>;

export const SessionUsageLimitConsumeResetCreditRequestV1Schema = z.preprocess<
  unknown,
  typeof SessionUsageLimitConsumeResetCreditCanonicalRequestV1Schema,
  SessionUsageLimitConsumeResetCreditRequestV1Input
>(
  normalizeLegacyUsageLimitAgentIdentity,
  SessionUsageLimitConsumeResetCreditCanonicalRequestV1Schema,
);
export type SessionUsageLimitConsumeResetCreditRequestV1 =
  z.infer<typeof SessionUsageLimitConsumeResetCreditRequestV1Schema>;

export const SessionUsageLimitOperationResponseV1Schema = z
  .unknown()
  .transform((value): SessionUsageLimitRecoveryOperationResultV1 => (
    normalizeSessionUsageLimitRecoveryOperationResultV1(value)
  ));
export type SessionUsageLimitOperationResponseV1 = z.infer<typeof SessionUsageLimitOperationResponseV1Schema>;

export const SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.string().trim().min(1),
    errorCode: z.string().trim().min(1).optional(),
  }).passthrough(),
]);
export type SessionConnectedServiceAuthInvalidateTransportsResponseV1 =
  z.infer<typeof SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema>;

export const SessionPendingQueueMaterializeNextResponseV1Schema = z.union([
  z.object({
    type: z.literal('materialized'),
    localId: PendingLocalIdSchema,
    seq: z.number().int().nonnegative().nullable(),
    content: z.unknown(),
    createdAt: z.number().finite().optional(),
    updatedAt: z.number().finite().optional(),
  }).passthrough(),
  z.object({ type: z.literal('no_pending') }).passthrough(),
  z.object({
    type: z.literal('deferred'),
    reason: z.enum(['supervisor_offline', 'supervisor_auth_failed', 'runtime_activity_active']),
  }).passthrough(),
]);
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

export const DaemonSessionGoalGetRequestV1Schema = z
  .object({
    sessionId: z.string().trim().min(1),
  })
  .passthrough();
export type DaemonSessionGoalGetRequestV1 = z.infer<typeof DaemonSessionGoalGetRequestV1Schema>;

export const DaemonSessionGoalSetRequestV1Schema = z
  .object({
    sessionId: z.string().trim().min(1),
    objective: z.string().trim().min(1).max(4000).optional(),
    status: SessionWorkStateStatusV1Schema.optional(),
    tokenBudget: z.number().finite().positive().nullable().optional(),
  })
  .passthrough()
  .refine(sessionGoalMutationHasField, { message: 'At least one goal mutation field is required' });
export type DaemonSessionGoalSetRequestV1 = z.infer<typeof DaemonSessionGoalSetRequestV1Schema>;

export const DaemonSessionGoalClearRequestV1Schema = z
  .object({
    sessionId: z.string().trim().min(1),
  })
  .passthrough();
export type DaemonSessionGoalClearRequestV1 = z.infer<typeof DaemonSessionGoalClearRequestV1Schema>;

// Compatibility alias for pre-A.8y clients. New writers must emit
// VendorPluginCatalogItemV1; remove this union arm after deployed clients no
// longer consume daemon.sessionVendorPluginCatalog.list legacy rows.
export const SessionVendorPluginSummaryV1Schema = z
  .object({
    vendorPluginRef: z.string().min(1),
    name: z.string().min(1),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    installed: z.boolean().optional(),
    enabled: z.boolean().optional(),
    mentionable: z.boolean().optional(),
  })
  .passthrough()
  .transform((item) => ({
    ...item,
    mentionable: item.mentionable ?? (item.installed === true && item.enabled === true),
  }));
export type SessionVendorPluginSummaryV1 = z.infer<typeof SessionVendorPluginSummaryV1Schema>;

const SessionVendorPluginCatalogListItemV1Schema = z.union([
  VendorPluginCatalogItemV1Schema,
  SessionVendorPluginSummaryV1Schema,
]);

export const SessionVendorPluginCatalogListRequestV1Schema = z
  .object({
    cwd: z.string().min(1).optional(),
  })
  .passthrough();
export type SessionVendorPluginCatalogListRequestV1 = z.infer<typeof SessionVendorPluginCatalogListRequestV1Schema>;

export const DaemonSessionVendorPluginCatalogListRequestV1Schema = SessionVendorPluginCatalogListRequestV1Schema
  .extend({
    sessionId: z.string().trim().min(1),
  })
  .passthrough();
export type DaemonSessionVendorPluginCatalogListRequestV1 = z.infer<typeof DaemonSessionVendorPluginCatalogListRequestV1Schema>;

export const SessionVendorPluginCatalogListResponseV1Schema = z
  .object({
    catalog: VendorPluginCatalogV1Schema.optional(),
    vendorPlugins: z.array(SessionVendorPluginCatalogListItemV1Schema).default([]),
    unsupported: z.boolean().optional(),
  })
  .passthrough()
  .transform((response) => ({
    ...response,
    vendorPlugins: response.catalog?.items ?? response.vendorPlugins,
  }));
export type SessionVendorPluginCatalogListResponseV1 = z.infer<typeof SessionVendorPluginCatalogListResponseV1Schema>;

export const SessionSkillCatalogItemV1Schema = SkillCatalogItemV1Schema;
export type SessionSkillCatalogItemV1 = z.infer<typeof SessionSkillCatalogItemV1Schema>;

export const SessionSkillCatalogListRequestV1Schema = SessionVendorPluginCatalogListRequestV1Schema;
export type SessionSkillCatalogListRequestV1 = z.infer<typeof SessionSkillCatalogListRequestV1Schema>;

export const DaemonSessionSkillCatalogListRequestV1Schema = DaemonSessionVendorPluginCatalogListRequestV1Schema;
export type DaemonSessionSkillCatalogListRequestV1 = z.infer<typeof DaemonSessionSkillCatalogListRequestV1Schema>;

export const SessionSkillCatalogListResponseV1Schema = z
  .object({
    catalog: SkillCatalogV1Schema.optional(),
    skills: z.array(SessionSkillCatalogItemV1Schema).default([]),
    unsupported: z.boolean().optional(),
  })
  .passthrough()
  .transform((response) => ({
    ...response,
    skills: response.catalog?.items ?? response.skills,
  }));
export type SessionSkillCatalogListResponseV1 = z.infer<typeof SessionSkillCatalogListResponseV1Schema>;
