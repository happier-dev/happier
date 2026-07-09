import { z } from 'zod';

import {
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceBindingSelectionV1Schema,
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceIdSchema,
    ConnectedServiceProfileIdSchema,
    SessionConnectedServiceAuthSwitchRpcParamsSchema,
} from './connectedServiceBindings.js';
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
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceBindingSelectionV1Schema,
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceIdSchema,
    ConnectedServiceProfileIdSchema,
    SessionConnectedServiceAuthSwitchRpcParamsSchema,
    type ConnectedServiceAuthGroupId,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceId,
    type ConnectedServiceProfileId,
    type SessionConnectedServiceAuthSwitchRpcParams,
} from './connectedServiceBindings.js';

export const ConnectedServiceCloudVendorKeySchema = z.enum([
    'openai',
    'anthropic',
    'gemini',
]);

export type ConnectedServiceCloudVendorKey = z.infer<typeof ConnectedServiceCloudVendorKeySchema>;

export const ConnectedServiceCredentialFormatSchema = z.enum(['account_scoped_v1']);
export type ConnectedServiceCredentialFormat = z.infer<typeof ConnectedServiceCredentialFormatSchema>;

export const ConnectedServiceCredentialKindSchema = z.enum(['oauth', 'token']);
export type ConnectedServiceCredentialKind = z.infer<typeof ConnectedServiceCredentialKindSchema>;

export const ConnectedServiceCredentialHealthStatusV1Schema = z.enum([
    'connected',
    'refreshing',
    'needs_reauth',
    'refresh_failed_retryable',
]);
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

export const ConnectedServiceCredentialRefreshFailureKindV1Schema = z.enum([
    'invalid_grant',
    'invalid_client',
    'provider_401',
    'provider_403',
    'network_error',
    'malformed_response',
    'missing_access_token',
    'missing_refresh_token',
    'unknown',
]);
export type ConnectedServiceCredentialRefreshFailureKindV1 = z.infer<typeof ConnectedServiceCredentialRefreshFailureKindV1Schema>;

export const ConnectedServiceCredentialHealthV1Schema = z.object({
    v: z.literal(1),
    status: ConnectedServiceCredentialHealthStatusV1Schema,
    reconnectRequired: z.boolean().default(false),
    lastRefreshAttemptAt: z.number().int().nonnegative().optional(),
    lastRefreshSuccessAt: z.number().int().nonnegative().optional(),
    lastRefreshFailureAt: z.number().int().nonnegative().optional(),
    lastRefreshFailureKind: ConnectedServiceCredentialRefreshFailureKindV1Schema.optional(),
    lastRuntimeAuthFailureAt: z.number().int().nonnegative().optional(),
    providerHttpStatus: z.number().int().min(100).max(599).optional(),
    providerErrorCode: z.string().trim().min(1).max(128).optional(),
}).strict();
export type ConnectedServiceCredentialHealthV1 = z.infer<typeof ConnectedServiceCredentialHealthV1Schema>;

const OauthCredentialPayloadSchema = z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    idToken: z.string().min(1).nullable(),
    scope: z.string().min(1).nullable(),
    tokenType: z.string().min(1).nullable(),
    providerAccountId: z.string().min(1).nullable(),
    providerEmail: z.string().min(1).nullable(),
    raw: z.unknown().nullable(),
});

const TokenCredentialPayloadSchema = z.object({
    // Trim before length-check so a whitespace-only token is rejected at the
    // schema boundary, not just defensively downstream in materializers.
    token: z.string().trim().min(1),
    providerAccountId: z.string().min(1).nullable(),
    providerEmail: z.string().min(1).nullable(),
    raw: z.unknown().nullable(),
});

const ConnectedServiceCredentialBaseSchema = z.object({
    v: z.literal(1),
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
});

export const ConnectedServiceCredentialRecordV1Schema = z.discriminatedUnion('kind', [
    ConnectedServiceCredentialBaseSchema.extend({
        kind: z.literal('oauth'),
        oauth: OauthCredentialPayloadSchema,
        token: z.null(),
    }),
    ConnectedServiceCredentialBaseSchema.extend({
        kind: z.literal('token'),
        oauth: z.null().optional(),
        token: TokenCredentialPayloadSchema,
    }),
]);

export type ConnectedServiceCredentialRecordV1 = z.infer<typeof ConnectedServiceCredentialRecordV1Schema>;

export const SealedConnectedServiceCredentialV1Schema = z.object({
    format: ConnectedServiceCredentialFormatSchema,
    ciphertext: z.string().min(1),
});

export type SealedConnectedServiceCredentialV1 = z.infer<typeof SealedConnectedServiceCredentialV1Schema>;

export const ConnectedServiceQuotaUnitV1Schema = z.enum([
    'count',
    'tokens',
    'credits',
    'usd',
    'requests',
    'unknown',
]);

export type ConnectedServiceQuotaUnitV1 = z.infer<typeof ConnectedServiceQuotaUnitV1Schema>;

export const ConnectedServiceQuotaSourceV1Schema = z.enum([
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
]);

export type ConnectedServiceQuotaSourceV1 = z.infer<typeof ConnectedServiceQuotaSourceV1Schema>;

export const ConnectedServiceQuotaConfidenceV1Schema = z.enum(['exact', 'derived', 'estimated', 'stale', 'unknown']);
export type ConnectedServiceQuotaConfidenceV1 = z.infer<typeof ConnectedServiceQuotaConfidenceV1Schema>;

export const ConnectedServiceQuotaMeterScopeV1Schema = z.enum([
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
]);

export type ConnectedServiceQuotaMeterScopeV1 = z.infer<typeof ConnectedServiceQuotaMeterScopeV1Schema>;

export const ConnectedServiceQuotaLimitScopeV1Schema = z.enum([
    'account',
    'workspace',
    'organization',
    'model',
    'provider',
    'session',
    'unknown',
]);

export type ConnectedServiceQuotaLimitScopeV1 = z.infer<typeof ConnectedServiceQuotaLimitScopeV1Schema>;

const ConnectedServiceQuotaEvidenceV1Schema = z
    .object({
        kind: z.string().trim().min(1).optional(),
        status: z.number().int().min(100).max(599).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        code: z.string().trim().min(1).optional(),
        message: z.string().trim().min(1).optional(),
        providerLimitId: z.string().trim().min(1).optional(),
        observedAtMs: z.number().int().nonnegative().optional(),
    })
    .strict()
    .superRefine((evidence, ctx) => {
        if (evidence.headers) {
            for (const [headerName, headerValue] of Object.entries(evidence.headers)) {
                if (isUnsafeDiagnosticHeaderName(headerName) || containsUnsafeDiagnosticText(headerValue)) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: 'Unsafe quota evidence header',
                        path: ['headers', headerName],
                    });
                }
            }
        }
        if (containsUnsafeDiagnosticText(evidence.code)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Unsafe quota evidence code',
                path: ['code'],
            });
        }
        if (containsUnsafeDiagnosticText(evidence.message)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Unsafe quota evidence message',
                path: ['message'],
            });
        }
    });

export const ConnectedServiceQuotaResetSourceV1Schema = z.enum([
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
]);

export type ConnectedServiceQuotaResetSourceV1 = z.infer<typeof ConnectedServiceQuotaResetSourceV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditKindV1Schema = z.enum([
    'usage_limit_reset',
]);
export type ConnectedServiceQuotaRecoveryCreditKindV1 = z.infer<typeof ConnectedServiceQuotaRecoveryCreditKindV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditStatusV1Schema = z.enum([
    'available',
    'redeeming',
    'redeemed',
    'expired',
    'unavailable',
    'unknown',
]);
export type ConnectedServiceQuotaRecoveryCreditStatusV1 = z.infer<typeof ConnectedServiceQuotaRecoveryCreditStatusV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditV1Schema = z
    .object({
        id: z.string().trim().min(1).max(256),
        kind: ConnectedServiceQuotaRecoveryCreditKindV1Schema,
        status: ConnectedServiceQuotaRecoveryCreditStatusV1Schema,
        grantedAtMs: z.number().int().nonnegative().optional(),
        expiresAtMs: z.number().int().nonnegative().optional(),
        redeemStartedAtMs: z.number().int().nonnegative().nullable().optional(),
        redeemedAtMs: z.number().int().nonnegative().nullable().optional(),
        title: z.string().trim().min(1).max(256).optional(),
        description: z.string().trim().min(1).max(1024).optional(),
    })
    .strict();
export type ConnectedServiceQuotaRecoveryCreditV1 = z.infer<typeof ConnectedServiceQuotaRecoveryCreditV1Schema>;

export const ConnectedServiceQuotaRecoveryCreditsV1Schema = z
    .object({
        availableCount: z.number().int().nonnegative(),
        credits: z.array(ConnectedServiceQuotaRecoveryCreditV1Schema).default([]),
    })
    .strict();
export type ConnectedServiceQuotaRecoveryCreditsV1 = z.infer<typeof ConnectedServiceQuotaRecoveryCreditsV1Schema>;

export const ConnectedServiceQuotaMeterV1Schema = z.object({
    meterId: z.string().min(1),
    label: z.string().min(1),
    used: z.number().finite().nullable(),
    limit: z.number().finite().nullable(),
    remaining: z.number().finite().nullable().optional(),
    remainingPct: z.number().finite().min(0).max(100).nullable().optional(),
    usedPct: z.number().finite().min(0).max(100).nullable().optional(),
    resetAtMs: z.number().int().nonnegative().nullable().optional(),
    resetSource: ConnectedServiceQuotaResetSourceV1Schema.optional(),
    providerLimitId: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).nullable().optional(),
    isExhausted: z.boolean().optional(),
    isSoftLimited: z.boolean().optional(),
    isCapacityLimited: z.boolean().optional(),
    unit: ConnectedServiceQuotaUnitV1Schema,
    utilizationPct: z.number().finite().min(0).max(100).nullable(),
    resetsAt: z.number().int().nonnegative().nullable(),
    status: z.enum(['ok', 'unavailable', 'estimated']),
    source: ConnectedServiceQuotaSourceV1Schema.optional(),
    scope: ConnectedServiceQuotaMeterScopeV1Schema.optional(),
    limitScope: ConnectedServiceQuotaLimitScopeV1Schema.optional(),
    confidence: ConnectedServiceQuotaConfidenceV1Schema.optional(),
    details: z
        .object({
            note: z.string().min(1).nullable().optional(),
            code: z.string().trim().min(1).optional(),
            rawScope: z.string().trim().min(1).optional(),
            remainingPct: z.number().finite().min(0).max(100).nullable().optional(),
            scope: ConnectedServiceQuotaMeterScopeV1Schema.optional(),
            providerLimitId: z.string().trim().min(1).optional(),
            limitCategory: ConnectedServiceLimitCategoryV1Schema.optional(),
        })
        .optional()
        .default({}),
});

export type ConnectedServiceQuotaMeterV1 = z.infer<typeof ConnectedServiceQuotaMeterV1Schema>;

export const ConnectedServiceUsageSourceBindingKindV1Schema = z.enum(['profile', 'group_member']);
export type ConnectedServiceUsageSourceBindingKindV1 = z.infer<typeof ConnectedServiceUsageSourceBindingKindV1Schema>;

export const ConnectedServiceUsageSourceV1Schema = z
    .object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
        bindingKind: ConnectedServiceUsageSourceBindingKindV1Schema,
        groupId: z.string().trim().min(1).optional(),
        groupGeneration: z.number().int().nonnegative().optional(),
    })
    .strict()
    .superRefine((source, ctx) => {
        if (source.bindingKind === 'group_member' && !source.groupId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Group-member connected-service usage sources require groupId',
                path: ['groupId'],
            });
        }
    });

export type ConnectedServiceUsageSourceV1 = z.infer<typeof ConnectedServiceUsageSourceV1Schema>;

export const ConnectedServiceQuotaSnapshotV1Schema = z.object({
    v: z.literal(1),
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
    fetchedAt: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().min(1),
    planLabel: z.string().min(1).nullable(),
    accountLabel: z.string().min(1).nullable(),
    providerId: z.string().trim().min(1).optional(),
    activeAccountId: z.string().trim().min(1).optional(),
    fetchedAtMs: z.number().int().nonnegative().optional(),
    staleAtMs: z.number().int().nonnegative().optional(),
    source: ConnectedServiceQuotaSourceV1Schema.optional(),
    confidence: ConnectedServiceQuotaConfidenceV1Schema.optional(),
    evidence: ConnectedServiceQuotaEvidenceV1Schema.optional(),
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1Schema.optional(),
    meters: z.array(ConnectedServiceQuotaMeterV1Schema),
});

export type ConnectedServiceQuotaSnapshotV1 = z.infer<typeof ConnectedServiceQuotaSnapshotV1Schema>;

export const SealedConnectedServiceQuotaSnapshotV1Schema = z.object({
    format: ConnectedServiceCredentialFormatSchema,
    ciphertext: z.string().min(1),
});

export type SealedConnectedServiceQuotaSnapshotV1 = z.infer<typeof SealedConnectedServiceQuotaSnapshotV1Schema>;

// Fields that were previously frozen single-value no-op knobs (no behavioral reader). They are
// removed from the policy, but stored blobs and older clients may still carry them; strip them at
// the parse boundary so removal is migration-safe (strict validation still rejects other unknowns).
const REMOVED_AUTH_GROUP_POLICY_LEGACY_KEYS = ['recoveryPromptMode', 'effectiveMeterStrategy', 'memberRuntimeStatePersistence'] as const;

function stripRemovedAuthGroupPolicyLegacyKeys(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (!REMOVED_AUTH_GROUP_POLICY_LEGACY_KEYS.some((key) => key in record)) return value;
    const next = { ...record };
    for (const key of REMOVED_AUTH_GROUP_POLICY_LEGACY_KEYS) delete next[key];
    return next;
}

export const ConnectedServiceAuthGroupPolicyV1Schema = z.preprocess(stripRemovedAuthGroupPolicyLegacyKeys, z
    .object({
        v: z.literal(1).default(1),
        strategy: z.enum(['priority', 'least_limited', 'manual']).default('least_limited'),
        autoSwitch: z.boolean().default(false),
        switchOn: z
            .object({
                usageLimit: z.boolean(),
                authExpired: z.boolean(),
                accountChanged: z.boolean(),
                refreshFailure: z.boolean(),
            })
            .strict()
            .default({
                usageLimit: true,
                authExpired: true,
                accountChanged: true,
                refreshFailure: false,
            }),
        cooldownMs: z.number().int().min(0).default(30_000),
        honorProviderResetsAt: z.boolean().default(true),
        autoRestorePrimaryWhenReset: z.boolean().default(false),
        maxSwitchesPerTurn: z.number().int().min(0).default(1),
        maxSwitchesPerSessionHour: z.number().int().min(0).default(3),
        softSwitchRemainingPercent: z.number().finite().min(0).max(100).default(15),
        probeIfSnapshotOlderThanMs: z.number().int().min(1).default(300_000),
        preTurnProbeMode: z.enum(['never', 'when_stale', 'always_for_group']).default('when_stale'),
        preTurnProbeOrder: z
            .enum(['current_first_then_candidates', 'candidates_first_then_current'])
            .default('current_first_then_candidates'),
        recoveryMode: z
            .enum(['off', 'wait_until_reset', 'switch_then_resume', 'switch_or_wait'])
            .default('switch_or_wait'),
        resumePromptMode: z.enum(['standard', 'off', 'custom']).default('standard'),
    })
    .strict());

export type ConnectedServiceAuthGroupPolicyV1 = z.infer<typeof ConnectedServiceAuthGroupPolicyV1Schema>;

export const ConnectedServiceAuthGroupPolicyPatchV1Schema = z.preprocess(stripRemovedAuthGroupPolicyLegacyKeys, z
    .object({
        v: z.literal(1).optional(),
        strategy: z.enum(['priority', 'least_limited', 'manual']).optional(),
        autoSwitch: z.boolean().optional(),
        switchOn: z
            .object({
                usageLimit: z.boolean().optional(),
                authExpired: z.boolean().optional(),
                accountChanged: z.boolean().optional(),
                refreshFailure: z.boolean().optional(),
            })
            .strict()
            .optional(),
        cooldownMs: z.number().int().min(0).optional(),
        honorProviderResetsAt: z.boolean().optional(),
        autoRestorePrimaryWhenReset: z.boolean().optional(),
        maxSwitchesPerTurn: z.number().int().min(0).optional(),
        maxSwitchesPerSessionHour: z.number().int().min(0).optional(),
        softSwitchRemainingPercent: z.number().finite().min(0).max(100).optional(),
        probeIfSnapshotOlderThanMs: z.number().int().min(1).optional(),
        preTurnProbeMode: z.enum(['never', 'when_stale', 'always_for_group']).optional(),
        preTurnProbeOrder: z.enum(['current_first_then_candidates', 'candidates_first_then_current']).optional(),
        recoveryMode: z.enum(['off', 'wait_until_reset', 'switch_then_resume', 'switch_or_wait']).optional(),
        resumePromptMode: z.enum(['standard', 'off', 'custom']).optional(),
    })
    .strict());

export type ConnectedServiceAuthGroupPolicyPatchV1 = z.infer<typeof ConnectedServiceAuthGroupPolicyPatchV1Schema>;

export const ConnectedServiceAuthGroupMemberStateV1Schema = z
    .object({
        cooldownUntilMs: z.number().int().nonnegative().nullable().optional(),
        exhaustedUntilMs: z.number().int().nonnegative().nullable().optional(),
        quotaExhaustedUntilMs: z.number().int().nonnegative().nullable().optional(),
        rateLimitedUntilMs: z.number().int().nonnegative().nullable().optional(),
        capacityLimitedUntilMs: z.number().int().nonnegative().nullable().optional(),
        authInvalidUntilMs: z.number().int().nonnegative().nullable().optional(),
        planUnavailableUntilMs: z.number().int().nonnegative().nullable().optional(),
        validationBlockedUntilMs: z.number().int().nonnegative().nullable().optional(),
        lastFailureKind: z.string().trim().min(1).nullable().optional(),
        lastFailureCode: z.string().trim().min(1).nullable().optional(),
        lastObservedPlanType: z.string().trim().min(1).nullable().optional(),
        lastObservedAtMs: z.number().int().nonnegative().nullable().optional(),
        providerResetsAtMs: z.number().int().nonnegative().nullable().optional(),
        credentialHealthStatus: ConnectedServiceCredentialHealthStatusV1Schema.nullable().optional(),
    })
    .passthrough()
    .default({});

export type ConnectedServiceAuthGroupMemberStateV1 = z.infer<typeof ConnectedServiceAuthGroupMemberStateV1Schema>;

export const ConnectedServiceAuthGroupStateV1Schema = z
    .object({
        status: z.enum(['ready', 'switching', 'exhausted', 'error', 'unknown']).optional(),
        lastSwitchAt: z.number().int().nonnegative().nullable().optional(),
        lastSwitchReason: z.string().trim().min(1).nullable().optional(),
    })
    .passthrough()
    .default({});

export type ConnectedServiceAuthGroupStateV1 = z.infer<typeof ConnectedServiceAuthGroupStateV1Schema>;

const ConnectedServiceAuthGroupStatePatchV1Schema = z
    .object({
        status: z.enum(['ready', 'switching', 'exhausted', 'error', 'unknown']).optional(),
        lastSwitchAt: z.number().int().nonnegative().nullable().optional(),
        lastSwitchReason: z.string().trim().min(1).nullable().optional(),
    })
    .passthrough();

export const ConnectedServiceAuthGroupMemberV1Schema = z
    .object({
        v: z.literal(1),
        serviceId: ConnectedServiceIdSchema,
        groupId: ConnectedServiceAuthGroupIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
        priority: z.number().int().default(100),
        enabled: z.boolean().default(true),
        state: ConnectedServiceAuthGroupMemberStateV1Schema,
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
    })
    .strict();

export type ConnectedServiceAuthGroupMemberV1 = z.infer<typeof ConnectedServiceAuthGroupMemberV1Schema>;

export const ConnectedServiceAuthGroupV1Schema = z
    .object({
        v: z.literal(1),
        serviceId: ConnectedServiceIdSchema,
        groupId: ConnectedServiceAuthGroupIdSchema,
        displayName: z.string().trim().min(1).nullable(),
        policy: ConnectedServiceAuthGroupPolicyV1Schema,
        activeProfileId: ConnectedServiceProfileIdSchema.nullable(),
        generation: z.number().int().nonnegative(),
        state: ConnectedServiceAuthGroupStateV1Schema,
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        members: z.array(ConnectedServiceAuthGroupMemberV1Schema).default([]),
    })
    .strict();

export type ConnectedServiceAuthGroupV1 = z.infer<typeof ConnectedServiceAuthGroupV1Schema>;

export const ConnectedServiceAuthGroupRouteParamsV1Schema = z
    .object({
        serviceId: ConnectedServiceIdSchema,
        groupId: ConnectedServiceAuthGroupIdSchema,
    })
    .strict();

export type ConnectedServiceAuthGroupRouteParamsV1 = z.infer<typeof ConnectedServiceAuthGroupRouteParamsV1Schema>;

const ConnectedServiceAuthGroupMemberInputV1Schema = z
    .object({
        profileId: ConnectedServiceProfileIdSchema,
        priority: z.number().int().default(100),
        enabled: z.boolean().default(true),
    })
    .strict();

export const ConnectedServiceAuthGroupCreateRequestV1Schema = z
    .object({
        groupId: ConnectedServiceAuthGroupIdSchema,
        displayName: z.string().trim().min(1).nullable().optional(),
        policy: ConnectedServiceAuthGroupPolicyPatchV1Schema.optional(),
        members: z.array(ConnectedServiceAuthGroupMemberInputV1Schema).default([]),
        activeProfileId: ConnectedServiceProfileIdSchema.nullable().optional(),
    })
    .strict();

export type ConnectedServiceAuthGroupCreateRequestV1 = z.infer<typeof ConnectedServiceAuthGroupCreateRequestV1Schema>;

export const ConnectedServiceAuthGroupPatchRequestV1Schema = z
    .object({
        displayName: z.string().trim().min(1).nullable().optional(),
        policy: ConnectedServiceAuthGroupPolicyPatchV1Schema.optional(),
        activeProfileId: ConnectedServiceProfileIdSchema.nullable().optional(),
        expectedGeneration: z.number().int().nonnegative().optional(),
    })
    .strict()
    .superRefine((request, ctx) => {
        if (
            (request.activeProfileId !== undefined || request.policy !== undefined)
            && request.expectedGeneration === undefined
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['expectedGeneration'],
                message: 'expectedGeneration is required when generation-sensitive group fields are patched',
            });
        }
    });

export type ConnectedServiceAuthGroupPatchRequestV1 = z.infer<typeof ConnectedServiceAuthGroupPatchRequestV1Schema>;

export const ConnectedServiceAuthGroupMemberCreateRequestV1Schema = ConnectedServiceAuthGroupMemberInputV1Schema
    .extend({
        expectedGeneration: z.number().int().nonnegative(),
    })
    .strict();
export type ConnectedServiceAuthGroupMemberCreateRequestV1 = z.infer<typeof ConnectedServiceAuthGroupMemberCreateRequestV1Schema>;

export const ConnectedServiceAuthGroupMemberPatchRequestV1Schema = z
    .object({
        priority: z.number().int().optional(),
        enabled: z.boolean().optional(),
        expectedGeneration: z.number().int().nonnegative(),
    })
    .strict();

export type ConnectedServiceAuthGroupMemberPatchRequestV1 = z.infer<typeof ConnectedServiceAuthGroupMemberPatchRequestV1Schema>;

export const ConnectedServiceAuthGroupMemberDeleteRequestV1Schema = z
    .object({
        expectedGeneration: z.preprocess((value) => {
            if (typeof value !== 'string') return value;
            const trimmed = value.trim();
            return trimmed.length > 0 ? Number(trimmed) : value;
        }, z.number().int().nonnegative()),
    })
    .strict();

export type ConnectedServiceAuthGroupMemberDeleteRequestV1 = z.infer<typeof ConnectedServiceAuthGroupMemberDeleteRequestV1Schema>;

export const ConnectedServiceAuthGroupActiveProfileRequestV1Schema = z
    .object({
        profileId: ConnectedServiceProfileIdSchema,
        expectedGeneration: z.number().int().nonnegative(),
        overrideRuntimeCooldown: z.boolean().optional(),
    })
    .strict();

export type ConnectedServiceAuthGroupActiveProfileRequestV1 = z.infer<typeof ConnectedServiceAuthGroupActiveProfileRequestV1Schema>;

const ConnectedServiceAuthGroupMemberRuntimeStatePatchV1Schema = z
    .object({
        profileId: ConnectedServiceProfileIdSchema,
        state: ConnectedServiceAuthGroupMemberStateV1Schema,
    })
    .strict();

export const ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema = z
    .object({
        expectedGeneration: z.number().int().nonnegative().optional(),
        state: ConnectedServiceAuthGroupStatePatchV1Schema.optional(),
        memberStates: z.array(ConnectedServiceAuthGroupMemberRuntimeStatePatchV1Schema).default([]),
    })
    .strict();

export type ConnectedServiceAuthGroupRuntimeStatePatchRequestV1 =
    z.infer<typeof ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema>;

export const ConnectedServiceAuthGroupListResponseV1Schema = z
    .object({
        groups: z.array(ConnectedServiceAuthGroupV1Schema),
    })
    .strict();

export type ConnectedServiceAuthGroupListResponseV1 = z.infer<typeof ConnectedServiceAuthGroupListResponseV1Schema>;

export const ConnectedServiceAuthGroupResponseV1Schema = z
    .object({
        group: ConnectedServiceAuthGroupV1Schema,
    })
    .strict();

export type ConnectedServiceAuthGroupResponseV1 = z.infer<typeof ConnectedServiceAuthGroupResponseV1Schema>;

export const ConnectedServiceAuthGroupErrorCodeV1Schema = z.enum([
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
    'connect_group_generation_required',
    'connect_group_fallback_disabled',
    'connect_group_runtime_fallback_unsupported',
    'connect_credential_referenced_by_group',
]);

export type ConnectedServiceAuthGroupErrorCodeV1 = z.infer<typeof ConnectedServiceAuthGroupErrorCodeV1Schema>;

export const ConnectedServiceAuthGroupErrorResponseV1Schema = z.object({
    error: ConnectedServiceAuthGroupErrorCodeV1Schema,
    generation: z.number().int().min(0).optional(),
    resetAtMs: z.number().int().nonnegative().optional(),
}).strict();

export type ConnectedServiceAuthGroupErrorResponseV1 = z.infer<typeof ConnectedServiceAuthGroupErrorResponseV1Schema>;
