import { z } from 'zod';

import { ConnectedServiceIdSchema } from '../connect/connectedServiceBindings.js';
import {
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceQuotaSnapshotV1Schema,
} from '../connect/connectedServiceSchemas.js';
import { SessionUsageLimitRecoveryOperationResultV1Schema } from '../sessionControl/sessionUsageLimitRecoveryOperationResultV1.js';
import { SessionUsageLimitRecoveryResumePromptModeV1Schema } from '../sessionMetadata/sessionUsageLimitRecoveryV1.js';
import { LEGACY_SKILL_CATALOG_ORIGINS_V1 } from './skillCatalogItemIdentityV1.js';
import { SessionWorkStateStatusV1Schema, SessionWorkStateV1Schema } from './sessionWorkStateV1.js';

type MetadataRecord = Record<string, unknown>;

function asRecord(value: unknown): MetadataRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function asRecordArray(value: unknown): MetadataRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is MetadataRecord => Boolean(entry)) : [];
}

function responseWithCatalogItems(value: unknown, legacyKey: 'skills' | 'vendorPlugins'): unknown {
  const record = asRecord(value);
  if (!record || Array.isArray(record[legacyKey])) return value;
  const catalog = asRecord(record.catalog);
  const items = asRecordArray(catalog?.items);
  return items.length > 0 ? { ...record, [legacyKey]: items } : value;
}

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

const ConnectedServiceRuntimeControlServiceIdV1Schema = z.string().trim().min(1);
const ConnectedServiceRuntimeControlIdV1Schema = z.string().trim().min(1);
const ConnectedServiceRuntimeControlExpectedV1Schema = z
  .object({
    profileId: ConnectedServiceRuntimeControlIdV1Schema.optional(),
    groupId: ConnectedServiceRuntimeControlIdV1Schema.optional(),
    generation: z.union([z.string().trim().min(1), z.number().int().nonnegative()]).optional(),
    credentialRevision: z.string().trim().min(1).optional(),
  })
  .passthrough();

export const SessionConnectedServiceAuthApplyGenerationReasonV1Schema = z.enum([
  'usage_limit',
  'same_provider_account_exhausted',
  'soft_threshold',
  'manual',
  'diagnostic',
]);
export type SessionConnectedServiceAuthApplyGenerationReasonV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationReasonV1Schema>;

export const SessionConnectedServiceAuthApplyGenerationAppliedViaV1Schema = z.enum([
  'current_truth_fence',
  'direct_live_hot_auth',
  'transport_recycle',
  'restart_resume',
  'spawn_next_turn',
]);
export type SessionConnectedServiceAuthApplyGenerationAppliedViaV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationAppliedViaV1Schema>;

type ExactIdentityMaterialField = 'providerAccountId' | 'activeAccountId' | 'sharedAuthSurfaceId';

function hasNonEmptyStringField(value: Readonly<Record<string, unknown>>, field: ExactIdentityMaterialField): boolean {
  return typeof value[field] === 'string' && value[field].trim().length > 0;
}

function hasExactIdentityMaterial(
  value: Readonly<Record<string, unknown>>,
  fields: ReadonlyArray<ExactIdentityMaterialField>,
): boolean {
  return fields.some((field) => hasNonEmptyStringField(value, field));
}

function addMissingExactIdentityMaterialIssue(
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string>,
  message: string,
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [...path],
    message,
  });
}

const SessionConnectedServiceAuthGenerationApplicationV1Schema = z.object({
  serviceId: ConnectedServiceIdSchema,
  groupId: z.string().trim().min(1),
  profileId: z.string().trim().min(1),
  generation: z.number().int().nonnegative(),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  credentialFingerprint: z.string().trim().min(1),
}).passthrough();

const SessionConnectedServiceAuthApplyGenerationVerificationV1Schema = z
  .object({
    providerAccountId: z.string().trim().min(1).optional(),
    activeAccountId: z.string().trim().min(1).optional(),
    sharedAuthSurfaceId: z.string().trim().min(1).optional(),
    proofStrength: z.enum(['exact', 'weak', 'diagnostic']).optional(),
    source: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema.nullable().optional(),
    credentialFingerprint: z.string().trim().min(1).nullable().optional(),
    generationApplication: SessionConnectedServiceAuthGenerationApplicationV1Schema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.proofStrength !== 'exact') return;
    if (hasExactIdentityMaterial(value, ['providerAccountId', 'activeAccountId', 'sharedAuthSurfaceId'])) return;
    addMissingExactIdentityMaterialIssue(ctx, ['proofStrength'], 'exact verification requires identity material');
  });

export const SessionConnectedServiceAuthCurrentGroupTruthV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('current_auth_group_unavailable'),
    groupId: z.string().trim().min(1),
    unavailableReason: z.enum(['group_missing', 'active_profile_missing']),
  }).passthrough(),
  z.object({
    kind: z.literal('current_auth_group_available'),
    groupId: z.string().trim().min(1),
    generation: z.number().int().nonnegative(),
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  }).passthrough(),
]);
export type SessionConnectedServiceAuthCurrentGroupTruthV1 =
  z.infer<typeof SessionConnectedServiceAuthCurrentGroupTruthV1Schema>;

const SessionConnectedServiceAuthLegacyGenerationV1Schema = z
  .record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).length > 0)
  .refine((value) => (
    typeof value.kind !== 'string' || !value.kind.startsWith('current_auth_group_')
  ));

export const SessionConnectedServiceAuthApplyGenerationRequestV1Schema = z
  .object({
    serviceId: ConnectedServiceRuntimeControlServiceIdV1Schema,
    reason: SessionConnectedServiceAuthApplyGenerationReasonV1Schema,
    applicationSettled: z.literal(true).optional(),
    expected: ConnectedServiceRuntimeControlExpectedV1Schema.optional(),
    authGeneration: z.union([
      SessionConnectedServiceAuthCurrentGroupTruthV1Schema,
      SessionConnectedServiceAuthLegacyGenerationV1Schema,
    ]),
  })
  .passthrough();
export type SessionConnectedServiceAuthApplyGenerationRequestV1 =
  z.infer<typeof SessionConnectedServiceAuthApplyGenerationRequestV1Schema>;

export const SessionConnectedServiceAuthApplyGenerationResponseV1Schema = z.union([
  z
    .object({
      ok: z.literal(true),
      appliedVia: SessionConnectedServiceAuthApplyGenerationAppliedViaV1Schema,
      verification: SessionConnectedServiceAuthApplyGenerationVerificationV1Schema.optional(),
      quotaSnapshotRef: z.string().trim().min(1).optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().trim().min(1),
      errorCode: z.string().trim().min(1).optional(),
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
  .superRefine((value, ctx) => {
    if (value.proofStrength !== 'exact') return;
    if (value.strategy === 'provider_account_id') {
      if (hasExactIdentityMaterial(value, ['providerAccountId'])) return;
      addMissingExactIdentityMaterialIssue(
        ctx,
        ['providerAccountId'],
        'exact provider_account_id identity requires providerAccountId',
      );
      return;
    }
    if (value.strategy === 'shared_group_auth_surface') {
      if (hasExactIdentityMaterial(value, ['sharedAuthSurfaceId'])) return;
      addMissingExactIdentityMaterialIssue(
        ctx,
        ['sharedAuthSurfaceId'],
        'exact shared_group_auth_surface identity requires sharedAuthSurfaceId',
      );
      return;
    }
    addMissingExactIdentityMaterialIssue(ctx, ['strategy'], 'strategy none cannot provide exact identity proof');
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
          generation: z.union([z.string().trim().min(1), z.number().int().nonnegative()]).optional(),
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
    })
    .passthrough(),
]);
export type SessionConnectedServiceAuthReadRuntimeIdentityResponseV1 =
  z.infer<typeof SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema>;

const SessionIdRequestFieldSchema = z.string().trim().min(1);
const IssueFingerprintFieldSchema = z.string().trim().min(1);

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

export const SessionUsageLimitCheckNowRequestV1Schema = z
  .object({
    sessionId: SessionIdRequestFieldSchema,
    provider: z.string().trim().min(1).optional(),
    operation: z.enum(['check_now', 'switch_account_now']).optional(),
    resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.optional(),
  })
  .passthrough();
export type SessionUsageLimitCheckNowRequestV1 = z.infer<typeof SessionUsageLimitCheckNowRequestV1Schema>;

export const SessionUsageLimitConsumeResetCreditRequestV1Schema = z
  .object({
    sessionId: SessionIdRequestFieldSchema,
    provider: z.string().trim().min(1).optional(),
    resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.optional(),
  })
  .passthrough();
export type SessionUsageLimitConsumeResetCreditRequestV1 =
  z.infer<typeof SessionUsageLimitConsumeResetCreditRequestV1Schema>;

export const SessionUsageLimitOperationResponseV1Schema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.string().trim().min(1),
    errorCode: z.string().trim().min(1).optional(),
  }).passthrough(),
]);
export type SessionUsageLimitOperationResponseV1 = z.infer<typeof SessionUsageLimitOperationResponseV1Schema>;

export const SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema =
  SessionUsageLimitOperationResponseV1Schema;
export type SessionConnectedServiceAuthInvalidateTransportsResponseV1 =
  z.infer<typeof SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema>;

export const SessionUsageLimitWaitResumeEnableResponseV1Schema = SessionUsageLimitRecoveryOperationResultV1Schema;
export type SessionUsageLimitWaitResumeEnableResponseV1 =
  z.infer<typeof SessionUsageLimitWaitResumeEnableResponseV1Schema>;

export const SessionUsageLimitWaitResumeCancelResponseV1Schema = SessionUsageLimitRecoveryOperationResultV1Schema;
export type SessionUsageLimitWaitResumeCancelResponseV1 =
  z.infer<typeof SessionUsageLimitWaitResumeCancelResponseV1Schema>;

export const SessionUsageLimitCheckNowResponseV1Schema = SessionUsageLimitRecoveryOperationResultV1Schema;
export type SessionUsageLimitCheckNowResponseV1 = z.infer<typeof SessionUsageLimitCheckNowResponseV1Schema>;

export const SessionUsageLimitConsumeResetCreditResponseV1Schema = SessionUsageLimitRecoveryOperationResultV1Schema;
export type SessionUsageLimitConsumeResetCreditResponseV1 =
  z.infer<typeof SessionUsageLimitConsumeResetCreditResponseV1Schema>;

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
    idempotencyKey: z.string().trim().min(1).max(256),
    providerCreditId: z.string().trim().min(1).max(256).optional(),
    status: ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema,
  })
  .passthrough();
export type ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema = z
  .object({
    serviceId: ConnectedServiceIdSchema,
    profileId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1).max(256),
    providerCreditId: z.string().trim().min(1).max(256).optional(),
  })
  .passthrough();
export type ConnectedServiceQuotaRecoveryCreditConsumeRequestV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    snapshot: ConnectedServiceQuotaSnapshotV1Schema.nullable(),
    receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema,
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    errorCode: z.string().trim().min(1),
    error: z.string().trim().min(1),
    receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema.optional(),
  }).passthrough(),
]);
export type ConnectedServiceQuotaRecoveryCreditConsumeResponseV1 =
  z.infer<typeof ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema>;

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

export const SessionVendorPluginSummaryV1Schema = z
  .object({
    vendorPluginRef: z.string().min(1),
    name: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    installed: z.boolean().optional(),
    enabled: z.boolean().optional(),
    mentionable: z.boolean().optional(),
  })
  .passthrough()
  .transform((value) => ({
    ...value,
    name: value.name ?? value.displayName ?? value.vendorPluginRef,
  }));
export type SessionVendorPluginSummaryV1 = z.infer<typeof SessionVendorPluginSummaryV1Schema>;

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

export const SessionVendorPluginCatalogListResponseV1Schema = z.preprocess(
  (value) => responseWithCatalogItems(value, 'vendorPlugins'),
  z
    .object({
      vendorPlugins: z.array(SessionVendorPluginSummaryV1Schema).default([]),
      unsupported: z.boolean().optional(),
    })
    .passthrough(),
);
export type SessionVendorPluginCatalogListResponseV1 = z.infer<typeof SessionVendorPluginCatalogListResponseV1Schema>;

// The legacy arm derives from the identity owner's fold table rather than re-listing it:
// two independent declarations of the same origin vocabulary can drift, and an origin the
// wire accepts but the identity resolver cannot fold produces a reference that never
// resolves. `derived`/`fallback` are accepted for historical payloads and carry no identity.
const SessionSkillCatalogOriginV1Schema = z.union([
  z.enum(['vendor', 'happier', 'derived', 'fallback']),
  z.enum(LEGACY_SKILL_CATALOG_ORIGINS_V1),
]);

export const SessionSkillCatalogItemV1Schema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    origin: SessionSkillCatalogOriginV1Schema,
    backendId: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();
export type SessionSkillCatalogItemV1 = z.infer<typeof SessionSkillCatalogItemV1Schema>;

export const SessionSkillCatalogListRequestV1Schema = SessionVendorPluginCatalogListRequestV1Schema;
export type SessionSkillCatalogListRequestV1 = z.infer<typeof SessionSkillCatalogListRequestV1Schema>;

export const DaemonSessionSkillCatalogListRequestV1Schema = DaemonSessionVendorPluginCatalogListRequestV1Schema;
export type DaemonSessionSkillCatalogListRequestV1 = z.infer<typeof DaemonSessionSkillCatalogListRequestV1Schema>;

export const SessionSkillCatalogListResponseV1Schema = z.preprocess(
  (value) => responseWithCatalogItems(value, 'skills'),
  z
    .object({
      skills: z.array(SessionSkillCatalogItemV1Schema).default([]),
      unsupported: z.boolean().optional(),
    })
    .passthrough(),
);
export type SessionSkillCatalogListResponseV1 = z.infer<typeof SessionSkillCatalogListResponseV1Schema>;
