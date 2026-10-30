import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

import {
    ConnectedServiceAuthGroupIdSchema,
    ConnectedAccountServiceKeyIngressSchema,
    ConnectedServiceBindingSelectionV1Schema,
    ConnectedServiceBindingSelectionV2Schema,
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceBindingsV2IngressSchema,
    ConnectedServiceBindingsV2Schema,
    ConnectedServiceIdSchema,
    ConnectedServiceProfileIdSchema,
    PersistedConnectedServiceBindingSelectionV1Schema,
    PersistedConnectedServiceBindingsV1Schema,
} from './connectedServiceBindings.js';
import { ConnectedServiceCredentialKindSchema } from './connectedServiceCredentialKind.js';
import { ProviderAccountSubscriptionV1Schema } from './accountSubscription.js';
import { ProviderAccountUsageDiagnosticV1Schema } from './providerAccountUsageDiagnostic.js';
import {
    ConnectedServiceLimitCategoryV1Schema,
    type ConnectedServiceLimitCategoryV1,
} from './connectedServiceLimitCategory.js';
import {
    containsUnsafeDiagnosticText,
    isUnsafeDiagnosticHeaderName,
} from './diagnosticPrivacy.js';

export {
    ConnectedServiceLimitCategoryV1Schema,
    type ConnectedServiceLimitCategoryV1,
} from './connectedServiceLimitCategory.js';

export {
    BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
    readBuiltInLegacyConnectedAccountServiceKeyIngress,
    readBuiltInLegacyConnectedServiceIdForQualifiedService,
    ConnectedAccountServiceKeyIngressSchema,
    ConnectedAccountServiceKeySchema,
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceBindingSelectionV1Schema,
    ConnectedServiceBindingSelectionV2Schema,
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceBindingsV2IngressSchema,
    ConnectedServiceBindingsV2Schema,
    TeamResourceConnectedServiceSelectionV2Schema,
    ConnectedServiceIdSchema,
    ConnectedServiceProfileIdSchema,
    PersistedConnectedServiceBindingSelectionV1Schema,
    PersistedConnectedServiceBindingsV1Schema,
    type ConnectedServiceAuthGroupId,
    type ConnectedAccountServiceKey,
    type ConnectedAccountServiceKeyIngress,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceBindingSelectionV2,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceBindingsV2,
    type ConnectedServiceId,
    type ConnectedServiceProfileId,
    type PersistedConnectedServiceBindingSelectionV1,
    type PersistedConnectedServiceBindingsV1,
    type TeamResourceConnectedServiceSelectionV2,
} from './connectedServiceBindings.js';
export {
    ConnectedServiceCredentialKindSchema,
    type ConnectedServiceCredentialKind,
} from './connectedServiceCredentialKind.js';

export const ConnectedServiceCloudVendorKeySchema = lazyZodSchema(() => z.enum([
    'openai',
    'anthropic',
    'gemini',
]));

export type ConnectedServiceCloudVendorKey = z.infer<typeof ConnectedServiceCloudVendorKeySchema>;

export const ConnectedServiceCredentialFormatSchema = lazyZodSchema(() => z.enum(['account_scoped_v1']));
export type ConnectedServiceCredentialFormat = z.infer<typeof ConnectedServiceCredentialFormatSchema>;

export const ConnectedServiceCredentialHealthStatusV1Schema = lazyZodSchema(() => z.enum([
    'connected',
    'refreshing',
    'needs_reauth',
    'refresh_failed_retryable',
]));
export type ConnectedServiceCredentialHealthStatusV1 = z.infer<typeof ConnectedServiceCredentialHealthStatusV1Schema>;

export function normalizeConnectedServiceCredentialHealthStatus(
    raw: unknown,
): ConnectedServiceCredentialHealthStatusV1 {
    if (raw === 'connected') return 'connected';
    if (raw === 'refreshing') return 'refreshing';
    if (raw === 'refresh_failed_retryable') return 'refresh_failed_retryable';
    return 'needs_reauth';
}

export function isConnectedServiceCredentialHealthStatusReconnectRequired(
    status: ConnectedServiceCredentialHealthStatusV1 | null | undefined,
): boolean {
    return status === 'needs_reauth';
}

export function isConnectedServiceCredentialHealthStatusUsable(
    status: ConnectedServiceCredentialHealthStatusV1 | null | undefined,
): boolean {
    return status === 'connected'
        || status === 'refreshing'
        || status === 'refresh_failed_retryable';
}

export const ConnectedServiceCredentialRefreshFailureKindV1Schema = lazyZodSchema(() => z.enum([
    'invalid_grant',
    'invalid_client',
    'provider_401',
    'provider_403',
    'network_error',
    'malformed_response',
    'missing_access_token',
    'missing_refresh_token',
    'unknown',
]));
export type ConnectedServiceCredentialRefreshFailureKindV1 = z.infer<typeof ConnectedServiceCredentialRefreshFailureKindV1Schema>;

export const ConnectedServiceCredentialHealthV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    status: ConnectedServiceCredentialHealthStatusV1Schema,
    reconnectRequired: z._default(z.boolean(), false),
    lastRefreshAttemptAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    lastRefreshSuccessAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    lastRefreshFailureAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    lastRefreshFailureKind: z.optional(ConnectedServiceCredentialRefreshFailureKindV1Schema),
    lastRuntimeAuthFailureAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    providerHttpStatus: z.optional(z.number().check(z.int(), z.minimum(100), z.maximum(599))),
    providerErrorCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
}));
export type ConnectedServiceCredentialHealthV1 = z.infer<typeof ConnectedServiceCredentialHealthV1Schema>;

/** Opaque server-owned revision independent from row timestamps and lease bookkeeping. */
export const ConnectedServiceCredentialRevisionV1Schema = lazyZodSchema(() => z
    .string().check(z.regex(/^csr_[A-Za-z0-9_-]{22,64}$/)));
export type ConnectedServiceCredentialRevisionV1 = z.infer<typeof ConnectedServiceCredentialRevisionV1Schema>;

export const ConnectedServiceExecutionAuthorityV1Schema = lazyZodSchema(() => z.enum([
    'passive_projection',
    'fresh_user_action',
    'runtime_recovery',
]));
export type ConnectedServiceExecutionAuthorityV1 = z.infer<typeof ConnectedServiceExecutionAuthorityV1Schema>;

export const ConnectedServiceCredentialMutationGuardV1Schema = lazyZodSchema(() => z.strictObject({
    expectedCredentialRevision: z.optional(z.nullable(ConnectedServiceCredentialRevisionV1Schema)),
    refreshLeaseOwnerId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
}).check(z.superRefine((value, context) => {
    if (value.refreshLeaseOwnerId && typeof value.expectedCredentialRevision !== 'string') {
        context.addIssue({
            code: 'custom',
            message: 'refreshLeaseOwnerId requires expectedCredentialRevision',
            path: ['expectedCredentialRevision'],
        });
    }
})));
export type ConnectedServiceCredentialMutationGuardV1 = z.infer<typeof ConnectedServiceCredentialMutationGuardV1Schema>;

export const ConnectedServiceCredentialRevisionedMutationSuccessV1Schema = lazyZodSchema(() => z.strictObject({
    success: z.literal(true),
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
}));
export const ConnectedServiceCredentialLegacyMutationSuccessV1Schema = lazyZodSchema(() => z.strictObject({
    success: z.literal(true),
}));
export const ConnectedServiceCredentialMutationSuccessV1Schema =
    ConnectedServiceCredentialRevisionedMutationSuccessV1Schema;
export const ConnectedServiceCredentialCompatibleMutationSuccessV1Schema = lazyZodSchema(() => z.union([
    ConnectedServiceCredentialRevisionedMutationSuccessV1Schema,
    ConnectedServiceCredentialLegacyMutationSuccessV1Schema,
]));
export type ConnectedServiceCredentialMutationSuccessV1 = z.infer<typeof ConnectedServiceCredentialMutationSuccessV1Schema>;
export type ConnectedServiceCredentialCompatibleMutationSuccessV1 =
    z.infer<typeof ConnectedServiceCredentialCompatibleMutationSuccessV1Schema>;

export type ConnectedServiceCredentialRevisionBoundaryV1 =
    | Readonly<{
        revisionSemantics: 'revisioned';
        credentialRevision: ConnectedServiceCredentialRevisionV1;
      }>
    | Readonly<{
        revisionSemantics: 'legacy_unfenced';
        credentialRevision: null;
      }>;

/**
 * Translates the exact server-v0.2.1 no-revision shape from
 * 4913c1e533c872a0712ba1c25b3104fd470aacc2 into an explicit unfenced semantic
 * state. A missing revision must never be treated as a successful CAS fence.
 * Remove the legacy branch when exact 0.2.1 leaves the supported predecessor window.
 */
export function readConnectedServiceCredentialRevisionBoundaryV1(
    value: object,
): ConnectedServiceCredentialRevisionBoundaryV1 | null {
    if (!('credentialRevision' in value)) {
        return { revisionSemantics: 'legacy_unfenced', credentialRevision: null };
    }
    const parsed = ConnectedServiceCredentialRevisionV1Schema.safeParse(value.credentialRevision);
    if (!parsed.success) return null;
    return { revisionSemantics: 'revisioned', credentialRevision: parsed.data };
}

export const ConnectedServiceCredentialMutationSupersededV1Schema = lazyZodSchema(() => z.strictObject({
    error: z.literal('connect_credential_mutation_superseded'),
    reason: z.enum(['revision_mismatch', 'refresh_lease_lost']),
    credentialRevision: z.nullable(ConnectedServiceCredentialRevisionV1Schema),
}));
export type ConnectedServiceCredentialMutationSupersededV1 = z.infer<typeof ConnectedServiceCredentialMutationSupersededV1Schema>;

export const ConnectedServiceCredentialMutationResponseV1Schema = lazyZodSchema(() => z.union([
    ConnectedServiceCredentialMutationSuccessV1Schema,
    ConnectedServiceCredentialMutationSupersededV1Schema,
]));
export type ConnectedServiceCredentialMutationResponseV1 = z.infer<typeof ConnectedServiceCredentialMutationResponseV1Schema>;
export const ConnectedServiceCredentialCompatibleMutationResponseV1Schema = lazyZodSchema(() => z.union([
    ConnectedServiceCredentialCompatibleMutationSuccessV1Schema,
    ConnectedServiceCredentialMutationSupersededV1Schema,
]));
export type ConnectedServiceCredentialCompatibleMutationResponseV1 =
    z.infer<typeof ConnectedServiceCredentialCompatibleMutationResponseV1Schema>;

const OauthCredentialPayloadSchema = lazyZodSchema(() => z.object({
    accessToken: z.string().check(z.minLength(1)),
    refreshToken: z.string().check(z.minLength(1)),
    idToken: z.nullable(z.string().check(z.minLength(1))),
    scope: z.nullable(z.string().check(z.minLength(1))),
    tokenType: z.nullable(z.string().check(z.minLength(1))),
    providerAccountId: z.nullable(z.string().check(z.minLength(1))),
    providerEmail: z.nullable(z.string().check(z.minLength(1))),
    raw: z.optional(z.nullable(z.unknown())),
}));

const TokenCredentialPayloadSchema = lazyZodSchema(() => z.object({
    // Trim before length-check so a whitespace-only token is rejected at the
    // schema boundary, not just defensively downstream in materializers.
    token: z.string().check(z.trim(), z.minLength(1)),
    providerAccountId: z.nullable(z.string().check(z.minLength(1))),
    providerEmail: z.nullable(z.string().check(z.minLength(1))),
    raw: z.optional(z.nullable(z.unknown())),
}));

const ConnectedServiceCredentialBaseSchema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
    createdAt: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
    expiresAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
}));

export const ConnectedServiceCredentialRecordV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.extend(ConnectedServiceCredentialBaseSchema, {
        kind: z.literal('oauth'),
        oauth: OauthCredentialPayloadSchema,
        token: z.null(),
    }),
    z.extend(ConnectedServiceCredentialBaseSchema, {
        kind: z.literal('token'),
        oauth: z.optional(z.null()),
        token: TokenCredentialPayloadSchema,
    }),
]));

export type ConnectedServiceCredentialRecordV1 = z.infer<typeof ConnectedServiceCredentialRecordV1Schema>;

export const SealedConnectedServiceCredentialV1Schema = lazyZodSchema(() => z.object({
    format: ConnectedServiceCredentialFormatSchema,
    ciphertext: z.string().check(z.minLength(1)),
}));

export type SealedConnectedServiceCredentialV1 = z.infer<typeof SealedConnectedServiceCredentialV1Schema>;

export const ConnectedServiceQuotaUnitV1Schema = lazyZodSchema(() => z.enum([
    'count',
    'tokens',
    'credits',
    'usd',
    'requests',
    'unknown',
]));

export type ConnectedServiceQuotaUnitV1 = z.infer<typeof ConnectedServiceQuotaUnitV1Schema>;

export const ConnectedServiceQuotaSourceV1Schema = lazyZodSchema(() => z.enum([
    'provider_api',
    'background_fetch',
    'runtime_event',
    'runtime_probe',
    'in_band_snapshot',
    'in_band_provider_snapshot',
    'manual_refresh',
    'user_probe',
    'cached',
    'unknown',
]));

export type ConnectedServiceQuotaSourceV1 = z.infer<typeof ConnectedServiceQuotaSourceV1Schema>;

export const ConnectedServiceQuotaConfidenceV1Schema = lazyZodSchema(() => z.enum(['exact', 'derived', 'estimated', 'stale', 'unknown']));
export type ConnectedServiceQuotaConfidenceV1 = z.infer<typeof ConnectedServiceQuotaConfidenceV1Schema>;

export const ConnectedServiceQuotaMeterScopeV1Schema = lazyZodSchema(() => z.enum([
    'primary',
    'secondary',
    'daily',
    'weekly',
    'monthly',
    'five_hour',
    'seven_day',
    'session',
    'rolling',
    'model',
    'requests',
    'tokens',
    'unknown',
]));

export type ConnectedServiceQuotaMeterScopeV1 = z.infer<typeof ConnectedServiceQuotaMeterScopeV1Schema>;

export const ConnectedServiceQuotaLimitScopeV1Schema = lazyZodSchema(() => z.enum([
    'account',
    'workspace',
    'organization',
    'model',
    'provider',
    'session',
    'unknown',
]));

export type ConnectedServiceQuotaLimitScopeV1 = z.infer<typeof ConnectedServiceQuotaLimitScopeV1Schema>;

const ConnectedServiceQuotaEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
        kind: z.optional(z.string().check(z.trim(), z.minLength(1))),
        status: z.optional(z.number().check(z.int(), z.minimum(100), z.maximum(599))),
        headers: z.optional(z.record(z.string(), z.string())),
        code: z.optional(z.string().check(z.trim(), z.minLength(1))),
        message: z.optional(z.string().check(z.trim(), z.minLength(1))),
        providerLimitId: z.optional(z.string().check(z.trim(), z.minLength(1))),
        observedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    }).check(z.superRefine((evidence, ctx) => {
        if (evidence.headers) {
            for (const [headerName, headerValue] of Object.entries(evidence.headers)) {
                if (isUnsafeDiagnosticHeaderName(headerName) || containsUnsafeDiagnosticText(headerValue)) {
                    ctx.addIssue({
                        code: "custom",
                        message: 'Unsafe quota evidence header',
                        path: ['headers', headerName],
                    });
                }
            }
        }
        if (containsUnsafeDiagnosticText(evidence.code)) {
            ctx.addIssue({
                code: "custom",
                message: 'Unsafe quota evidence code',
                path: ['code'],
            });
        }
        if (containsUnsafeDiagnosticText(evidence.message)) {
            ctx.addIssue({
                code: "custom",
                message: 'Unsafe quota evidence message',
                path: ['message'],
            });
        }
    })));

export const ConnectedServiceQuotaResetSourceV1Schema = lazyZodSchema(() => z.enum([
    'header',
    'body',
    'provider_event',
    'provider_probe',
    'in_band_snapshot',
    'computed',
    'provider',
    'retry_after',
    'manual',
    'unknown',
]));

export type ConnectedServiceQuotaResetSourceV1 = z.infer<typeof ConnectedServiceQuotaResetSourceV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditKindV1Schema = lazyZodSchema(() => z.enum([
    'usage_limit_reset',
    'rate_limit_reset',
    'quota_reset',
    'unknown',
]));
export type ConnectedServiceQuotaRecoveryCreditKindV1 = z.infer<typeof ConnectedServiceQuotaRecoveryCreditKindV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditStatusV1Schema = lazyZodSchema(() => z.enum([
    'available',
    'redeeming',
    'redeemed',
    'expired',
    'unavailable',
    'unknown',
]));
export type ConnectedServiceQuotaRecoveryCreditStatusV1 = z.infer<typeof ConnectedServiceQuotaRecoveryCreditStatusV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditV1Schema = lazyZodSchema(() => z.strictObject({
        id: z.optional(z.string().check(z.trim(), z.minLength(1))),
        kind: ConnectedServiceQuotaRecoveryCreditKindV1Schema,
        status: ConnectedServiceQuotaRecoveryCreditStatusV1Schema,
        providerResetType: z.optional(z.string().check(z.trim(), z.minLength(1))),
        appliesToProviderLimitId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
        grantedAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        expiresAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        redeemStartedAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        redeemedAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        title: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
        description: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    }));
export type ConnectedServiceQuotaRecoveryCreditV1 = z.infer<typeof ConnectedServiceQuotaRecoveryCreditV1Schema>;

/** Credit-level eligibility; inventory counts and debit admission remain caller-owned. */
export function isConnectedServiceQuotaRecoveryCreditAvailable(
    credit: Readonly<Pick<ConnectedServiceQuotaRecoveryCreditV1, 'status' | 'expiresAtMs'>>,
    nowMs: number,
): boolean {
    return credit.status === 'available'
        && (credit.expiresAtMs == null || credit.expiresAtMs > nowMs);
}

export const ConnectedServiceQuotaRecoveryCreditsV1Schema = lazyZodSchema(() => z.strictObject({
        availableCount: z.number().check(z.int(), z.nonnegative()),
        totalCount: z.optional(z.number().check(z.int(), z.nonnegative())),
        nextExpiresAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        source: z.optional(ConnectedServiceQuotaSourceV1Schema),
        confidence: z.optional(ConnectedServiceQuotaConfidenceV1Schema),
        credits: z._default(z.array(ConnectedServiceQuotaRecoveryCreditV1Schema), []),
    }).check(z.superRefine((value, context) => {
        if (
            typeof value.totalCount === 'number'
            && value.totalCount < value.availableCount
        ) {
            context.addIssue({
                code: "custom",
                message: 'totalCount must be greater than or equal to availableCount',
                path: ['totalCount'],
            });
        }
    })));
export type ConnectedServiceQuotaRecoveryCreditsV1 = z.infer<typeof ConnectedServiceQuotaRecoveryCreditsV1Schema>;

/** Presentation facts only; credit status and availableCount own usability. */
export const ConnectedServiceQuotaRecoveryCreditDetailsV1Schema = lazyZodSchema(() => z.strictObject({
    remainingCount: z.number().check(z.int(), z.nonnegative()),
    appliesToProviderLimitIds: z._default(z.array(z.string().check(z.trim(), z.minLength(1))), []),
    unavailableReason: z.optional(z.enum(['paused', 'cooldown', 'ineligible', 'not_selected', 'provider_unavailable', 'not_started', 'expired', 'consumed', 'unknown'])),
}));
export type ConnectedServiceQuotaRecoveryCreditDetailsV1 = z.infer<typeof ConnectedServiceQuotaRecoveryCreditDetailsV1Schema>;
export const ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema = lazyZodSchema(() => z.record(z.string().check(z.trim(), z.minLength(1)), ConnectedServiceQuotaRecoveryCreditDetailsV1Schema));
export type ConnectedServiceQuotaRecoveryCreditDetailsByIdV1 = z.infer<typeof ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema>;

export const ConnectedServiceQuotaMeterDetailsV1Schema = lazyZodSchema(() => z.object({
    note: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    code: z.optional(z.string().check(z.trim(), z.minLength(1))),
    rawScope: z.optional(z.string().check(z.trim(), z.minLength(1))),
    remainingPct: z.optional(z.nullable(z.number().check(z.minimum(0), z.maximum(100)))),
    scope: z.optional(ConnectedServiceQuotaMeterScopeV1Schema),
    providerLimitId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    limitCategory: z.optional(ConnectedServiceLimitCategoryV1Schema),
}));

export const ConnectedServiceQuotaMeterV1Schema = lazyZodSchema(() => z.object({
    meterId: z.string().check(z.minLength(1)),
    label: z.string().check(z.minLength(1)),
    used: z.nullable(z.number()),
    limit: z.nullable(z.number()),
    remaining: z.optional(z.nullable(z.number())),
    remainingPct: z.optional(z.nullable(z.number().check(z.minimum(0), z.maximum(100)))),
    usedPct: z.optional(z.nullable(z.number().check(z.minimum(0), z.maximum(100)))),
    resetAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    resetSource: z.optional(ConnectedServiceQuotaResetSourceV1Schema),
    providerLimitId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    windowDurationMs: z.optional(z.number().check(z.int(), z.positive())),
    modelId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    isExhausted: z.optional(z.boolean()),
    isSoftLimited: z.optional(z.boolean()),
    isCapacityLimited: z.optional(z.boolean()),
    unit: ConnectedServiceQuotaUnitV1Schema,
    /** ISO 4217 display denomination; legacy `usd` meters normalize omission to USD. Other currencies use
     * `unknown` plus a denominated label so older readers never reinterpret their amount as USD. */
    currency: z.optional(z.string().check(z.regex(/^[A-Z]{3}$/u))),
    utilizationPct: z.nullable(z.number().check(z.minimum(0), z.maximum(100))),
    resetsAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
    status: z.enum(['ok', 'unavailable', 'estimated']),
    source: z.optional(ConnectedServiceQuotaSourceV1Schema),
    scope: z.optional(ConnectedServiceQuotaMeterScopeV1Schema),
    limitScope: z.optional(ConnectedServiceQuotaLimitScopeV1Schema),
    confidence: z.optional(ConnectedServiceQuotaConfidenceV1Schema),
    details: z._default(z.optional(ConnectedServiceQuotaMeterDetailsV1Schema), {}),
}).check(z.overwrite(meter => meter.unit === 'usd' && meter.currency === undefined
    ? { ...meter, currency: 'USD' }
    : meter)));

export type ConnectedServiceQuotaMeterV1 = z.infer<typeof ConnectedServiceQuotaMeterV1Schema>;

export const ConnectedServiceUsageSourceBindingKindV1Schema = lazyZodSchema(() => z.enum(['profile', 'group_member']));
export type ConnectedServiceUsageSourceBindingKindV1 = z.infer<typeof ConnectedServiceUsageSourceBindingKindV1Schema>;

export const ConnectedServiceUsageSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('bindingKind', [
    z.strictObject({
        serviceId: ConnectedAccountServiceKeyIngressSchema,
        profileId: ConnectedServiceProfileIdSchema,
        bindingKind: z.literal('profile'),
    }),
    z.strictObject({
        serviceId: ConnectedAccountServiceKeyIngressSchema,
        profileId: ConnectedServiceProfileIdSchema,
        bindingKind: z.literal('group_member'),
        groupId: z.string().check(z.trim(), z.minLength(1)),
        groupGeneration: z.optional(z.number().check(z.int(), z.nonnegative())),
    }),
]));

export type ConnectedServiceUsageSourceV1 = z.infer<typeof ConnectedServiceUsageSourceV1Schema>;

export const ConnectedServiceQuotaSnapshotV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
    fetchedAt: z.number().check(z.int(), z.nonnegative()),
    staleAfterMs: z.number().check(z.int(), z.minimum(1)),
    planLabel: z.nullable(z.string().check(z.minLength(1))),
    accountLabel: z.nullable(z.string().check(z.minLength(1))),
    providerId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    activeAccountId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    providerOrganizationId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    fetchedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    staleAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    source: z.optional(ConnectedServiceQuotaSourceV1Schema),
    confidence: z.optional(ConnectedServiceQuotaConfidenceV1Schema),
    evidence: z.optional(ConnectedServiceQuotaEvidenceV1Schema),
    recoveryCredits: z.optional(ConnectedServiceQuotaRecoveryCreditsV1Schema),
    recoveryCreditDetails: z.optional(ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema),
    subscription: z.optional(ProviderAccountSubscriptionV1Schema),
    meters: z.array(ConnectedServiceQuotaMeterV1Schema),
    diagnostics: z.optional(z.array(ProviderAccountUsageDiagnosticV1Schema)),
}));

export type ConnectedServiceQuotaSnapshotV1 = z.infer<typeof ConnectedServiceQuotaSnapshotV1Schema>;
export const ConnectedServiceQuotaSnapshotV1StoredSchema = createStoredReadSchema(ConnectedServiceQuotaSnapshotV1Schema);

export const SealedConnectedServiceQuotaSnapshotV1Schema = lazyZodSchema(() => z.object({
    format: ConnectedServiceCredentialFormatSchema,
    ciphertext: z.string().check(z.minLength(1)),
}));

export type SealedConnectedServiceQuotaSnapshotV1 = z.infer<typeof SealedConnectedServiceQuotaSnapshotV1Schema>;

const ConnectedServiceQuotaProviderLimitIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

const ConnectedServiceSelectedQuotaProviderLimitIdsV1Schema = lazyZodSchema(() => z
    .array(ConnectedServiceQuotaProviderLimitIdV1Schema).check(z.minLength(1), z.refine((providerLimitIds) => new Set(providerLimitIds).size === providerLimitIds.length, 'Provider limit ids must be unique')));

/** Which provider-reported allowance families drive a Pool's quota decisions. */
export const ConnectedServiceQuotaLimitSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
    z.strictObject({
        mode: z.literal('all'),
        providerLimitIds: z.array(ConnectedServiceQuotaProviderLimitIdV1Schema).check(z.length(0)),
    }),
    z.strictObject({
        mode: z.literal('selected'),
        providerLimitIds: ConnectedServiceSelectedQuotaProviderLimitIdsV1Schema,
    }),
]));

export type ConnectedServiceQuotaLimitSelectionV1 = z.infer<
    typeof ConnectedServiceQuotaLimitSelectionV1Schema
>;

export const ConnectedServiceAuthGroupStrategyV1Schema = lazyZodSchema(() => z.enum(['expiry_first', 'priority', 'least_limited', 'manual']));

export const ConnectedServiceAuthGroupPolicyV1Schema = lazyZodSchema(() => z.strictObject({
        v: z._default(z.literal(1), 1),
        strategy: z._default(ConnectedServiceAuthGroupStrategyV1Schema, 'expiry_first'),
        autoSwitch: z._default(z.boolean(), false),
        // Absence remains false, preserving predecessor persisted policies.
        autoUseQuotaResetsWhenExhausted: z.optional(z.boolean()),
        // Absence remains false. V4 projects this field only when the server feature is enabled.
        autoDisablePlanInvalidAccounts: z.optional(z.boolean()),
        quotaLimitSelection: z.optional(ConnectedServiceQuotaLimitSelectionV1Schema),
        switchOn: z._default(z.strictObject({
                usageLimit: z.boolean(),
                authExpired: z.boolean(),
                accountChanged: z.boolean(),
                refreshFailure: z.boolean(),
            }), {
                usageLimit: true,
                authExpired: true,
                accountChanged: true,
                refreshFailure: false,
            }),
        cooldownMs: z._default(z.number().check(z.int(), z.minimum(0)), 30_000),
        honorProviderResetsAt: z._default(z.boolean(), true),
        autoRestorePrimaryWhenReset: z._default(z.boolean(), false),
        maxSwitchesPerTurn: z._default(z.number().check(z.int(), z.minimum(0)), 1),
        maxSwitchesPerSessionHour: z._default(z.number().check(z.int(), z.minimum(0)), 3),
        softSwitchRemainingPercent: z._default(z.number().check(z.minimum(0), z.maximum(100)), 15),
        probeIfSnapshotOlderThanMs: z._default(z.number().check(z.int(), z.minimum(1)), 300_000),
        preTurnProbeMode: z._default(z.enum(['never', 'when_stale', 'always_for_group']), 'when_stale'),
        preTurnProbeOrder: z._default(z
            .enum(['current_first_then_candidates', 'candidates_first_then_current']), 'current_first_then_candidates'),
        recoveryMode: z._default(z
            .enum(['off', 'wait_until_reset', 'switch_then_resume', 'switch_or_wait']), 'switch_or_wait'),
        resumePromptMode: z._default(z.enum(['standard', 'off', 'custom']), 'standard'),
    }));

export type ConnectedServiceAuthGroupPolicyV1 = z.infer<typeof ConnectedServiceAuthGroupPolicyV1Schema>;

export const ConnectedServiceAuthGroupPolicyPatchV1Schema = lazyZodSchema(() => z.strictObject({
        v: z.optional(z.literal(1)),
        strategy: z.optional(ConnectedServiceAuthGroupStrategyV1Schema),
        autoSwitch: z.optional(z.boolean()),
        autoUseQuotaResetsWhenExhausted: z.optional(z.boolean()),
        autoDisablePlanInvalidAccounts: z.optional(z.boolean()),
        quotaLimitSelection: z.optional(ConnectedServiceQuotaLimitSelectionV1Schema),
        switchOn: z.optional(z.strictObject({
                usageLimit: z.optional(z.boolean()),
                authExpired: z.optional(z.boolean()),
                accountChanged: z.optional(z.boolean()),
                refreshFailure: z.optional(z.boolean()),
            })),
        cooldownMs: z.optional(z.number().check(z.int(), z.minimum(0))),
        honorProviderResetsAt: z.optional(z.boolean()),
        autoRestorePrimaryWhenReset: z.optional(z.boolean()),
        maxSwitchesPerTurn: z.optional(z.number().check(z.int(), z.minimum(0))),
        maxSwitchesPerSessionHour: z.optional(z.number().check(z.int(), z.minimum(0))),
        softSwitchRemainingPercent: z.optional(z.number().check(z.minimum(0), z.maximum(100))),
        probeIfSnapshotOlderThanMs: z.optional(z.number().check(z.int(), z.minimum(1))),
        preTurnProbeMode: z.optional(z.enum(['never', 'when_stale', 'always_for_group'])),
        preTurnProbeOrder: z.optional(z.enum(['current_first_then_candidates', 'candidates_first_then_current'])),
        recoveryMode: z.optional(z.enum(['off', 'wait_until_reset', 'switch_then_resume', 'switch_or_wait'])),
        resumePromptMode: z.optional(z.enum(['standard', 'off', 'custom'])),
    }));

export type ConnectedServiceAuthGroupPolicyPatchV1 = z.infer<typeof ConnectedServiceAuthGroupPolicyPatchV1Schema>;

export const ConnectedServiceAuthGroupMemberStateV1Schema = lazyZodSchema(() => z._default(z.looseObject({
        cooldownUntilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        exhaustedUntilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        quotaExhaustedUntilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        rateLimitedUntilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        capacityLimitedUntilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        authInvalidUntilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        planUnavailableUntilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        modelUnavailableUntilMsByModelId: z.optional(z.record(z.string().check(z.trim(), z.minLength(1)), z.number().check(z.int(), z.nonnegative()))),
        autoDisabledReason: z.optional(z.nullable(z.enum(['model_not_entitled']))),
        validationBlockedUntilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        lastFailureKind: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
        lastFailureCode: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
        lastObservedPlanType: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
        lastObservedAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        providerResetsAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        credentialHealthStatus: z.optional(z.nullable(ConnectedServiceCredentialHealthStatusV1Schema)),
    }), {}));

export type ConnectedServiceAuthGroupMemberStateV1 = z.infer<typeof ConnectedServiceAuthGroupMemberStateV1Schema>;

export const ConnectedServiceAuthGroupStateV1Schema = lazyZodSchema(() => z._default(z.looseObject({
        status: z.optional(z.enum(['ready', 'switching', 'exhausted', 'error', 'unknown'])),
        lastSwitchAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        lastSwitchReason: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
        activeSince: z.optional(z.nullable(z.strictObject({
            accountId: z.string().check(z.trim(), z.minLength(1)),
            atMs: z.number().check(z.int(), z.nonnegative()),
        }))),
    }), {}));

export type ConnectedServiceAuthGroupStateV1 = z.infer<typeof ConnectedServiceAuthGroupStateV1Schema>;

const ConnectedServiceAuthGroupStatePatchV1Schema = lazyZodSchema(() => z.looseObject({
        status: z.optional(z.enum(['ready', 'switching', 'exhausted', 'error', 'unknown'])),
        lastSwitchAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
        lastSwitchReason: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    }));

export const ConnectedServiceAuthGroupMemberV1Schema = lazyZodSchema(() => z.strictObject({
        v: z.literal(1),
        serviceId: ConnectedServiceIdSchema,
        groupId: ConnectedServiceAuthGroupIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
        priority: z._default(z.number().check(z.int()), 100),
        enabled: z._default(z.boolean(), true),
        state: ConnectedServiceAuthGroupMemberStateV1Schema,
        createdAt: z.number().check(z.int(), z.nonnegative()),
        updatedAt: z.number().check(z.int(), z.nonnegative()),
    }));

export type ConnectedServiceAuthGroupMemberV1 = z.infer<typeof ConnectedServiceAuthGroupMemberV1Schema>;

export const ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema =
    lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

export const ConnectedServiceAuthGroupV1Schema = lazyZodSchema(() => z.strictObject({
        v: z.literal(1),
        serviceId: ConnectedServiceIdSchema,
        groupId: ConnectedServiceAuthGroupIdSchema,
        displayName: z.nullable(z.string().check(z.trim(), z.minLength(1))),
        policy: ConnectedServiceAuthGroupPolicyV1Schema,
        activeProfileId: z.nullable(ConnectedServiceProfileIdSchema),
        generation: z.number().check(z.int(), z.nonnegative()),
        runtimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema,
        state: ConnectedServiceAuthGroupStateV1Schema,
        createdAt: z.number().check(z.int(), z.nonnegative()),
        updatedAt: z.number().check(z.int(), z.nonnegative()),
        members: z._default(z.array(ConnectedServiceAuthGroupMemberV1Schema), []),
    }));

export type ConnectedServiceAuthGroupV1 = z.infer<typeof ConnectedServiceAuthGroupV1Schema>;

export const ConnectedServiceAuthGroupRouteParamsV1Schema = lazyZodSchema(() => z.strictObject({
        serviceId: ConnectedServiceIdSchema,
        groupId: ConnectedServiceAuthGroupIdSchema,
    }));

export type ConnectedServiceAuthGroupRouteParamsV1 = z.infer<typeof ConnectedServiceAuthGroupRouteParamsV1Schema>;

const ConnectedServiceAuthGroupMemberInputV1Schema = lazyZodSchema(() => z.strictObject({
        profileId: ConnectedServiceProfileIdSchema,
        priority: z._default(z.number().check(z.int()), 100),
        enabled: z._default(z.boolean(), true),
    }));

export const ConnectedServiceAuthGroupCreateRequestV1Schema = lazyZodSchema(() => z.strictObject({
        groupId: ConnectedServiceAuthGroupIdSchema,
        displayName: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
        policy: z.optional(ConnectedServiceAuthGroupPolicyPatchV1Schema),
        members: z._default(z.array(ConnectedServiceAuthGroupMemberInputV1Schema), []),
        activeProfileId: z.optional(z.nullable(ConnectedServiceProfileIdSchema)),
    }));

export type ConnectedServiceAuthGroupCreateRequestV1 = z.infer<typeof ConnectedServiceAuthGroupCreateRequestV1Schema>;

export const ConnectedServiceAuthGroupPatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
        displayName: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
        policy: z.optional(ConnectedServiceAuthGroupPolicyPatchV1Schema),
        activeProfileId: z.optional(z.nullable(ConnectedServiceProfileIdSchema)),
        expectedGeneration: z.optional(z.number().check(z.int(), z.nonnegative())),
    }).check(z.superRefine((request, ctx) => {
        if (
            (request.activeProfileId !== undefined || request.policy !== undefined)
            && request.expectedGeneration === undefined
        ) {
            ctx.addIssue({
                code: "custom",
                path: ['expectedGeneration'],
                message: 'expectedGeneration is required when generation-sensitive group fields are patched',
            });
        }
    })));

export type ConnectedServiceAuthGroupPatchRequestV1 = z.infer<typeof ConnectedServiceAuthGroupPatchRequestV1Schema>;

export const ConnectedServiceAuthGroupMemberCreateRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ConnectedServiceAuthGroupMemberInputV1Schema, {
        expectedGeneration: z.number().check(z.int(), z.nonnegative()),
    })));
export type ConnectedServiceAuthGroupMemberCreateRequestV1 = z.infer<typeof ConnectedServiceAuthGroupMemberCreateRequestV1Schema>;

export const ConnectedServiceAuthGroupMemberPatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
        priority: z.optional(z.number().check(z.int())),
        enabled: z.optional(z.boolean()),
        expectedGeneration: z.number().check(z.int(), z.nonnegative()),
    }));

export type ConnectedServiceAuthGroupMemberPatchRequestV1 = z.infer<typeof ConnectedServiceAuthGroupMemberPatchRequestV1Schema>;

export const ConnectedServiceAuthGroupMemberDeleteRequestV1Schema = lazyZodSchema(() => z.strictObject({
        expectedGeneration: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
            if (typeof value !== 'string') return value;
            const trimmed = value.trim();
            return trimmed.length > 0 ? Number(trimmed) : value;
        }), z.number().check(z.int(), z.nonnegative())),
    }));

export type ConnectedServiceAuthGroupMemberDeleteRequestV1 = z.infer<typeof ConnectedServiceAuthGroupMemberDeleteRequestV1Schema>;

export const ConnectedServiceAuthGroupActiveProfileRequestV1Schema = lazyZodSchema(() => z.strictObject({
        profileId: ConnectedServiceProfileIdSchema,
        expectedGeneration: z.number().check(z.int(), z.nonnegative()),
        overrideRuntimeCooldown: z.optional(z.boolean()),
    }));

export type ConnectedServiceAuthGroupActiveProfileRequestV1 = z.infer<typeof ConnectedServiceAuthGroupActiveProfileRequestV1Schema>;

const ConnectedServiceAuthGroupMemberRuntimeStatePatchV1Schema = lazyZodSchema(() => z.strictObject({
        profileId: ConnectedServiceProfileIdSchema,
        state: ConnectedServiceAuthGroupMemberStateV1Schema,
    }));

export const ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
        expectedGeneration: z.optional(z.number().check(z.int(), z.nonnegative())),
        expectedRuntimeStateRevision: z.optional(ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema),
        state: z.optional(ConnectedServiceAuthGroupStatePatchV1Schema),
        memberStates: z._default(z.array(ConnectedServiceAuthGroupMemberRuntimeStatePatchV1Schema), []),
    }));

export type ConnectedServiceAuthGroupRuntimeStatePatchRequestV1 =
    z.infer<typeof ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema>;

export const ConnectedServiceAuthGroupListResponseV1Schema = lazyZodSchema(() => z.strictObject({
        groups: z.array(ConnectedServiceAuthGroupV1Schema),
    }));

export type ConnectedServiceAuthGroupListResponseV1 = z.infer<typeof ConnectedServiceAuthGroupListResponseV1Schema>;

export const ConnectedServiceAuthGroupResponseV1Schema = lazyZodSchema(() => z.strictObject({
        group: ConnectedServiceAuthGroupV1Schema,
    }));

export type ConnectedServiceAuthGroupResponseV1 = z.infer<typeof ConnectedServiceAuthGroupResponseV1Schema>;

export const ConnectedServiceAuthGroupErrorCodeV1Schema = lazyZodSchema(() => z.enum([
    'connect_group_not_found',
    'connect_group_invalid',
    'connect_group_already_exists',
    'connect_group_member_profile_not_found',
    'connect_group_member_already_exists',
    'connect_group_member_not_found',
    'connect_group_duplicate_member',
    'connect_group_active_profile_not_member',
    'connect_group_profile_runtime_cooldown',
    'connect_group_generation_conflict',
    'connect_group_incarnation_conflict',
    'connect_group_generation_required',
    'connect_group_runtime_state_revision_conflict',
    'connect_group_runtime_state_revision_required',
    'connect_group_fallback_disabled',
    'connect_group_runtime_fallback_unsupported',
    'connect_credential_referenced_by_group',
]));

export type ConnectedServiceAuthGroupErrorCodeV1 = z.infer<typeof ConnectedServiceAuthGroupErrorCodeV1Schema>;

export const ConnectedServiceAuthGroupErrorResponseV1Schema = lazyZodSchema(() => z.strictObject({
    error: ConnectedServiceAuthGroupErrorCodeV1Schema,
    generation: z.optional(z.number().check(z.int(), z.minimum(0))),
    runtimeStateRevision: z.optional(ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema),
    resetAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
}));

export type ConnectedServiceAuthGroupErrorResponseV1 = z.infer<typeof ConnectedServiceAuthGroupErrorResponseV1Schema>;
