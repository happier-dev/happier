import { z } from 'zod';

import {
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceQuotaConfidenceV1Schema,
    ConnectedServiceQuotaRecoveryCreditsV1Schema,
    ConnectedServiceQuotaSnapshotV1Schema,
    ConnectedServiceQuotaSourceV1Schema,
    type ConnectedServiceCredentialRecordV1,
    type ConnectedServiceQuotaRecoveryCreditsV1,
    type ConnectedServiceQuotaSnapshotV1,
} from './connectedServiceSchemas.js';
import {
    ProviderAccountUsageSnapshotV1Schema,
    type ProviderAccountUsageSnapshotV1,
} from './accountUsage.js';
import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    type BuiltInLegacyConnectedAccountCompatibility,
    type BuiltInLegacyConnectedServiceId,
} from './generatedBuiltInLegacyConnectedAccountCompatibility.js';
import {
    QualifiedConnectedAccountCredentialPayloadV1Schema,
    type QualifiedConnectedAccountCredentialPayloadV1,
} from './qualifiedConnectedAccountContentEnvelope.js';
import type { QualifiedConnectedAccountRef } from './qualifiedConnectedAccountPersistence.js';

export const BUILT_IN_LEGACY_CONNECTED_SERVICE_COMPATIBILITY_ERROR_CODES = [
    'connected_service_credential_invalid',
    'connected_account_credential_legacy_assertion_mismatch',
    'connected_service_recovery_credits_invalid',
    'connected_service_quota_snapshot_invalid',
    'provider_account_usage_snapshot_invalid',
] as const;

export type BuiltInLegacyConnectedServiceCompatibilityErrorCode =
    typeof BUILT_IN_LEGACY_CONNECTED_SERVICE_COMPATIBILITY_ERROR_CODES[number];

export class BuiltInLegacyConnectedServiceCompatibilityError extends Error {
    readonly code: BuiltInLegacyConnectedServiceCompatibilityErrorCode;

    constructor(code: BuiltInLegacyConnectedServiceCompatibilityErrorCode) {
        super(code);
        this.name = 'BuiltInLegacyConnectedServiceCompatibilityError';
        this.code = code;
    }
}

/**
 * Exact recovery-credit shape from prospective predecessor Remote HEAD
 * e67f3751f1ab5dc13e40a583a28f3962111154aa. The relevant protocol source was
 * clean when inspected. This schema is transport compatibility only; the
 * canonical Connected Services domain remains owned by connectedServiceSchemas.
 *
 * Remove this translator when that predecessor can no longer coexist with Dev
 * and all persisted V2 ciphertext written by it has left the supported window.
 */
const BuiltInLegacyConnectedServiceRecoveryCreditV1Schema = z.object({
    providerCreditId: z.string().trim().min(1).optional(),
    kind: z.enum([
        'usage_limit_reset',
        'rate_limit_reset',
        'quota_reset',
        'unknown',
    ]),
    status: z.enum([
        'available',
        'redeeming',
        'redeemed',
        'expired',
        'unknown',
    ]),
    providerResetType: z.string().trim().min(1).optional(),
    appliesToProviderLimitId: z.string().trim().min(1).nullable().optional(),
    title: z.string().trim().min(1).nullable().optional(),
    description: z.string().trim().min(1).nullable().optional(),
    grantedAtMs: z.number().int().nonnegative().nullable().optional(),
    expiresAtMs: z.number().int().nonnegative().nullable().optional(),
    redeemStartedAtMs: z.number().int().nonnegative().nullable().optional(),
    redeemedAtMs: z.number().int().nonnegative().nullable().optional(),
}).strict();

const BuiltInLegacyConnectedServiceRecoveryCreditsV1Schema = z.object({
    kind: z.literal('usage_limit_resets'),
    availableCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative().optional(),
    nextExpiresAtMs: z.number().int().nonnegative().nullable().optional(),
    source: ConnectedServiceQuotaSourceV1Schema.optional(),
    confidence: ConnectedServiceQuotaConfidenceV1Schema.optional(),
    credits: z.array(
        BuiltInLegacyConnectedServiceRecoveryCreditV1Schema,
    ).default([]),
}).strict().superRefine((value, context) => {
    if (
        typeof value.totalCount === 'number'
        && value.totalCount < value.availableCount
    ) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'totalCount must be greater than or equal to availableCount',
            path: ['totalCount'],
        });
    }
});

function parseLegacyRecoveryCredits(
    value: unknown,
): ConnectedServiceQuotaRecoveryCreditsV1 {
    const legacy =
        BuiltInLegacyConnectedServiceRecoveryCreditsV1Schema.safeParse(value);
    if (!legacy.success) {
        throw new BuiltInLegacyConnectedServiceCompatibilityError(
            'connected_service_recovery_credits_invalid',
        );
    }
    return ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
        availableCount: legacy.data.availableCount,
        ...(legacy.data.totalCount !== undefined
            ? { totalCount: legacy.data.totalCount }
            : {}),
        ...(legacy.data.nextExpiresAtMs !== undefined
            ? { nextExpiresAtMs: legacy.data.nextExpiresAtMs }
            : {}),
        ...(legacy.data.source !== undefined
            ? { source: legacy.data.source }
            : {}),
        ...(legacy.data.confidence !== undefined
            ? { confidence: legacy.data.confidence }
            : {}),
        credits: legacy.data.credits.map((credit) => {
            return {
                ...(credit.providerCreditId
                    ? { id: credit.providerCreditId }
                    : {}),
                kind: credit.kind,
                status: credit.status,
                ...(credit.providerResetType !== undefined
                    ? { providerResetType: credit.providerResetType }
                    : {}),
                ...(credit.appliesToProviderLimitId !== undefined
                    ? {
                        appliesToProviderLimitId:
                            credit.appliesToProviderLimitId,
                    }
                    : {}),
                ...(credit.title !== undefined
                    ? { title: credit.title }
                    : {}),
                ...(credit.description !== undefined
                    ? { description: credit.description }
                    : {}),
                ...(credit.grantedAtMs !== undefined
                    ? { grantedAtMs: credit.grantedAtMs }
                    : {}),
                ...(credit.expiresAtMs !== undefined
                    ? { expiresAtMs: credit.expiresAtMs }
                    : {}),
                ...(credit.redeemStartedAtMs !== undefined
                    ? { redeemStartedAtMs: credit.redeemStartedAtMs }
                    : {}),
                ...(credit.redeemedAtMs !== undefined
                    ? { redeemedAtMs: credit.redeemedAtMs }
                    : {}),
            };
        }),
    });
}

function projectLegacyRecoveryCredits(
    value: unknown,
) {
    const canonical = ConnectedServiceQuotaRecoveryCreditsV1Schema.parse(value);
    return BuiltInLegacyConnectedServiceRecoveryCreditsV1Schema.parse({
        kind: 'usage_limit_resets',
        availableCount: canonical.availableCount,
        ...(canonical.totalCount !== undefined
            ? { totalCount: canonical.totalCount }
            : {}),
        ...(canonical.nextExpiresAtMs !== undefined
            ? { nextExpiresAtMs: canonical.nextExpiresAtMs }
            : {}),
        ...(canonical.source !== undefined
            ? { source: canonical.source }
            : {}),
        ...(canonical.confidence !== undefined
            ? { confidence: canonical.confidence }
            : {}),
        credits: canonical.credits.map((credit) => {
            return {
                ...(credit.id ? { providerCreditId: credit.id } : {}),
                kind: credit.kind,
                // The predecessor has no `unavailable` detail status. `unknown`
                // preserves the important non-redeemable state without
                // claiming that the credit expired or was consumed.
                status:
                    credit.status === 'unavailable'
                        ? 'unknown'
                        : credit.status,
                ...(credit.providerResetType !== undefined
                    ? { providerResetType: credit.providerResetType }
                    : {}),
                ...(credit.appliesToProviderLimitId !== undefined
                    ? {
                        appliesToProviderLimitId:
                            credit.appliesToProviderLimitId,
                    }
                    : {}),
                ...(credit.title !== undefined
                    ? { title: credit.title }
                    : {}),
                ...(credit.description !== undefined
                    ? { description: credit.description }
                    : {}),
                ...(credit.grantedAtMs !== undefined
                    ? { grantedAtMs: credit.grantedAtMs }
                    : {}),
                ...(credit.expiresAtMs !== undefined
                    ? { expiresAtMs: credit.expiresAtMs }
                    : {}),
                ...(credit.redeemStartedAtMs !== undefined
                    ? { redeemStartedAtMs: credit.redeemStartedAtMs }
                    : {}),
                ...(credit.redeemedAtMs !== undefined
                    ? { redeemedAtMs: credit.redeemedAtMs }
                    : {}),
            };
        }),
    });
}

function replaceRecoveryCredits(
    value: unknown,
    translate: (recoveryCredits: unknown) => unknown,
): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    if (!('recoveryCredits' in value)) return value;
    const object = value as Readonly<Record<string, unknown>>;
    if (object.recoveryCredits === undefined) return value;
    return {
        ...object,
        recoveryCredits: translate(object.recoveryCredits),
    };
}

export function parseBuiltInLegacyConnectedServiceCredentialRecordV1(
    value: unknown,
): ConnectedServiceCredentialRecordV1 {
    const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new BuiltInLegacyConnectedServiceCompatibilityError(
            'connected_service_credential_invalid',
        );
    }
    return parsed.data;
}

export function projectBuiltInLegacyConnectedServiceCredentialRecordV1(
    value: ConnectedServiceCredentialRecordV1,
): ConnectedServiceCredentialRecordV1 {
    const record = ConnectedServiceCredentialRecordV1Schema.parse(value);
    return ConnectedServiceCredentialRecordV1Schema.parse(
        record.kind === 'token'
            ? { ...record, oauth: null }
            : record,
    );
}

const QualifiedCredentialPayloadInLegacyRecordV1Schema = z.object({
    happierQualifiedConnectedAccountCredentialV1: z.object({
        v: z.literal(1),
        authenticationModeId: z.string().trim().min(1).max(128),
        payload: QualifiedConnectedAccountCredentialPayloadV1Schema,
    }).strict(),
}).strict();

type QualifiedCredentialMetadata = Readonly<{
    providerIdentity?: Readonly<{
        accountId?: string | null;
        email?: string | null;
    }>;
    scopes?: readonly string[];
}>;

function findLegacyCompatibilityForRef(
    ref: QualifiedConnectedAccountRef,
): Readonly<{
    serviceId: BuiltInLegacyConnectedServiceId;
    compatibility: BuiltInLegacyConnectedAccountCompatibility;
}> | null {
    for (const [serviceId, compatibility] of Object.entries(
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    ) as Array<[
        BuiltInLegacyConnectedServiceId,
        typeof BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
            BuiltInLegacyConnectedServiceId
        ],
    ]>) {
        if (
            compatibility.service.pluginId === ref.service.pluginId
            && compatibility.service.localId === ref.service.localId
        ) {
            return { serviceId, compatibility };
        }
    }
    return null;
}

function readNonEmptyValue(
    values: Readonly<Record<string, string>>,
    key: string,
): string | null {
    const value = values[key];
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : null;
}

function readNonnegativeIntegerValue(
    values: Readonly<Record<string, string>>,
    key: string,
): number | null {
    const value = readNonEmptyValue(values, key);
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function selectVisibleToken(
    values: Readonly<Record<string, string>>,
): string | null {
    const candidates = ['token', 'apiKey', 'setupToken']
        .map((key) => readNonEmptyValue(values, key))
        .filter((value): value is string => value !== null);
    if (candidates.length === 0) return null;
    return candidates.every((candidate) => candidate === candidates[0])
        ? candidates[0]!
        : null;
}

function buildEmbeddedQualifiedCredentialPayload(
    authenticationModeId: string,
    payload: QualifiedConnectedAccountCredentialPayloadV1,
): z.infer<typeof QualifiedCredentialPayloadInLegacyRecordV1Schema> {
    return {
        happierQualifiedConnectedAccountCredentialV1: {
            v: 1,
            authenticationModeId,
            payload,
        },
    };
}

/**
 * Canonical plaintext projector for qualified credentials.
 *
 * Representable built-in modes use the exact historical credential-record root
 * so an old CLI can decrypt a V4-written row directly. The qualified payload is
 * embedded under the legacy record's existing `raw` escape hatch, preserving
 * every current field without introducing a second row, secret, or revision.
 * Novel and unrepresentable modes retain the qualified payload root.
 */
export function projectQualifiedConnectedAccountCredentialPlaintextV1(params: Readonly<{
    ref: QualifiedConnectedAccountRef;
    authenticationModeId: string;
    payload: QualifiedConnectedAccountCredentialPayloadV1;
    metadata?: QualifiedCredentialMetadata;
    now: number;
}>): ConnectedServiceCredentialRecordV1 | QualifiedConnectedAccountCredentialPayloadV1 {
    const payload =
        QualifiedConnectedAccountCredentialPayloadV1Schema.parse(params.payload);
    const legacy = findLegacyCompatibilityForRef(params.ref);
    if (!legacy) return payload;

    const credentialKinds = Object.entries(
        legacy.compatibility.authenticationModeByCredentialKind,
    ) as Array<['oauth' | 'token', string]>;
    const credentialKind = credentialKinds.find(
        ([, modeId]) => modeId === params.authenticationModeId,
    )?.[0];
    if (!credentialKind) return payload;

    const raw = buildEmbeddedQualifiedCredentialPayload(
        params.authenticationModeId,
        payload,
    );
    const providerAccountId =
        readNonEmptyValue(payload.values, 'providerAccountId')
        ?? readNonEmptyValue(payload.values, 'identity')
        ?? params.metadata?.providerIdentity?.accountId
        ?? null;
    const providerEmail =
        readNonEmptyValue(payload.values, 'providerEmail')
        ?? params.metadata?.providerIdentity?.email
        ?? null;

    if (credentialKind === 'token') {
        const token = selectVisibleToken(payload.values);
        if (!token) return payload;
        return ConnectedServiceCredentialRecordV1Schema.parse({
            v: 1,
            serviceId: legacy.serviceId,
            profileId: params.ref.accountId,
            createdAt: params.now,
            updatedAt: params.now,
            expiresAt: null,
            kind: 'token',
            oauth: null,
            token: {
                token,
                providerAccountId,
                providerEmail,
                raw,
            },
        });
    }

    const accessToken = readNonEmptyValue(payload.values, 'accessToken');
    const refreshToken = readNonEmptyValue(payload.values, 'refreshToken');
    if (!accessToken || !refreshToken) return payload;
    const expiresAt = readNonnegativeIntegerValue(
        payload.values,
        'expiresAtMs',
    );
    const scope =
        readNonEmptyValue(payload.values, 'scopes')
        ?? (
            params.metadata?.scopes && params.metadata.scopes.length > 0
                ? params.metadata.scopes.join(' ')
                : null
        );
    return ConnectedServiceCredentialRecordV1Schema.parse({
        v: 1,
        serviceId: legacy.serviceId,
        profileId: params.ref.accountId,
        createdAt: params.now,
        updatedAt: params.now,
        expiresAt,
        kind: 'oauth',
        oauth: {
            accessToken,
            refreshToken,
            idToken: readNonEmptyValue(payload.values, 'idToken'),
            tokenType: readNonEmptyValue(payload.values, 'tokenType'),
            scope,
            providerAccountId,
            providerEmail,
            raw,
        },
        token: null,
    });
}

function throwLegacyAssertionMismatch(): never {
    throw new BuiltInLegacyConnectedServiceCompatibilityError(
        'connected_account_credential_legacy_assertion_mismatch',
    );
}

function assertLegacyVisibleCredentialMatchesEmbeddedPayload(
    record: ConnectedServiceCredentialRecordV1,
    payload: QualifiedConnectedAccountCredentialPayloadV1,
    metadata: QualifiedCredentialMetadata | undefined,
): void {
    if (record.kind === 'token') {
        const visibleToken = selectVisibleToken(payload.values);
        const expectedProviderAccountId =
            readNonEmptyValue(payload.values, 'providerAccountId')
            ?? readNonEmptyValue(payload.values, 'identity')
            ?? metadata?.providerIdentity?.accountId
            ?? null;
        const expectedProviderEmail =
            readNonEmptyValue(payload.values, 'providerEmail')
            ?? metadata?.providerIdentity?.email
            ?? null;
        if (
            !visibleToken
            || record.token.token !== visibleToken
            || record.token.providerAccountId !== expectedProviderAccountId
            || record.token.providerEmail !== expectedProviderEmail
        ) {
            throwLegacyAssertionMismatch();
        }
        return;
    }

    const expectedExpiresAt =
        readNonnegativeIntegerValue(payload.values, 'expiresAtMs');
    const expectedScope =
        readNonEmptyValue(payload.values, 'scopes')
        ?? (
            metadata?.scopes && metadata.scopes.length > 0
                ? metadata.scopes.join(' ')
                : null
        );
    const expectedProviderAccountId =
        readNonEmptyValue(payload.values, 'providerAccountId')
        ?? metadata?.providerIdentity?.accountId
        ?? null;
    const expectedProviderEmail =
        readNonEmptyValue(payload.values, 'providerEmail')
        ?? metadata?.providerIdentity?.email
        ?? null;
    if (
        record.oauth.accessToken
            !== readNonEmptyValue(payload.values, 'accessToken')
        || record.oauth.refreshToken
            !== readNonEmptyValue(payload.values, 'refreshToken')
        || record.oauth.idToken
            !== readNonEmptyValue(payload.values, 'idToken')
        || record.oauth.tokenType
            !== readNonEmptyValue(payload.values, 'tokenType')
        || record.expiresAt !== expectedExpiresAt
        || record.oauth.scope !== expectedScope
        || record.oauth.providerAccountId !== expectedProviderAccountId
        || record.oauth.providerEmail !== expectedProviderEmail
    ) {
        throwLegacyAssertionMismatch();
    }
}

function normalizeHistoricalLegacyCredentialPayload(
    record: ConnectedServiceCredentialRecordV1,
    authenticationModeId: string,
): QualifiedConnectedAccountCredentialPayloadV1 {
    if (record.kind === 'token') {
        const secretKey =
            authenticationModeId === 'setup-token'
                ? 'setupToken'
                : authenticationModeId === 'api-key'
                    ? 'apiKey'
                    : 'token';
        return QualifiedConnectedAccountCredentialPayloadV1Schema.parse({
            v: 1,
            values: {
                [secretKey]: record.token.token,
                ...(record.token.providerAccountId
                    ? {
                        [authenticationModeId === 'manual'
                            ? 'identity'
                            : 'providerAccountId']:
                            record.token.providerAccountId,
                    }
                    : {}),
                ...(record.token.providerEmail
                    ? { providerEmail: record.token.providerEmail }
                    : {}),
            },
        });
    }

    return QualifiedConnectedAccountCredentialPayloadV1Schema.parse({
        v: 1,
        values: {
            accessToken: record.oauth.accessToken,
            refreshToken: record.oauth.refreshToken,
            ...(record.oauth.idToken
                ? { idToken: record.oauth.idToken }
                : {}),
            ...(record.oauth.tokenType
                ? { tokenType: record.oauth.tokenType }
                : {}),
            ...(record.oauth.scope
                ? { scopes: record.oauth.scope }
                : {}),
            ...(record.expiresAt !== null
                ? { expiresAtMs: String(record.expiresAt) }
                : {}),
            ...(record.oauth.providerAccountId
                ? { providerAccountId: record.oauth.providerAccountId }
                : {}),
            ...(record.oauth.providerEmail
                ? { providerEmail: record.oauth.providerEmail }
                : {}),
        },
    });
}

/**
 * Canonical plaintext reader for qualified credentials. Identity and mode come
 * from the qualified row. Legacy root fields are assertions only and cannot
 * redirect the read to another service, profile, or authentication mode.
 */
export function parseQualifiedConnectedAccountCredentialPlaintextV1(params: Readonly<{
    ref: QualifiedConnectedAccountRef;
    authenticationModeId: string;
    plaintext: unknown;
    metadata?: QualifiedCredentialMetadata;
}>): QualifiedConnectedAccountCredentialPayloadV1 {
    const qualified =
        QualifiedConnectedAccountCredentialPayloadV1Schema.safeParse(
            params.plaintext,
        );
    if (qualified.success) return qualified.data;

    const record = ConnectedServiceCredentialRecordV1Schema.safeParse(
        params.plaintext,
    );
    if (!record.success) {
        throw new BuiltInLegacyConnectedServiceCompatibilityError(
            'connected_service_credential_invalid',
        );
    }
    const legacy = findLegacyCompatibilityForRef(params.ref);
    if (
        !legacy
        || record.data.serviceId !== legacy.serviceId
        || record.data.profileId !== params.ref.accountId
        || legacy.compatibility.authenticationModeByCredentialKind[
            record.data.kind
        ] !== params.authenticationModeId
    ) {
        throwLegacyAssertionMismatch();
    }

    const raw = record.data.kind === 'oauth'
        ? record.data.oauth.raw
        : record.data.token.raw;
    const embedded =
        QualifiedCredentialPayloadInLegacyRecordV1Schema.safeParse(raw);
    if (!embedded.success) {
        return normalizeHistoricalLegacyCredentialPayload(
            record.data,
            params.authenticationModeId,
        );
    }
    if (
        embedded.data.happierQualifiedConnectedAccountCredentialV1
            .authenticationModeId !== params.authenticationModeId
    ) {
        throwLegacyAssertionMismatch();
    }
    const payload =
        embedded.data.happierQualifiedConnectedAccountCredentialV1.payload;
    assertLegacyVisibleCredentialMatchesEmbeddedPayload(
        record.data,
        payload,
        params.metadata,
    );
    return payload;
}

export function parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(
    value: unknown,
): ConnectedServiceQuotaSnapshotV1 {
    const canonical = ConnectedServiceQuotaSnapshotV1Schema.safeParse(value);
    if (canonical.success) return canonical.data;
    const translated = ConnectedServiceQuotaSnapshotV1Schema.safeParse(
        replaceRecoveryCredits(value, parseLegacyRecoveryCredits),
    );
    if (!translated.success) {
        throw new BuiltInLegacyConnectedServiceCompatibilityError(
            'connected_service_quota_snapshot_invalid',
        );
    }
    return translated.data;
}

export function projectBuiltInLegacyConnectedServiceQuotaSnapshotV1(
    value: ConnectedServiceQuotaSnapshotV1,
): unknown {
    const canonical = ConnectedServiceQuotaSnapshotV1Schema.parse(value);
    return replaceRecoveryCredits(canonical, projectLegacyRecoveryCredits);
}

export function parseBuiltInLegacyProviderAccountUsageSnapshotV1(
    value: unknown,
): ProviderAccountUsageSnapshotV1 {
    const canonical = ProviderAccountUsageSnapshotV1Schema.safeParse(value);
    if (canonical.success) return canonical.data;
    const translated = ProviderAccountUsageSnapshotV1Schema.safeParse(
        replaceRecoveryCredits(value, parseLegacyRecoveryCredits),
    );
    if (!translated.success) {
        throw new BuiltInLegacyConnectedServiceCompatibilityError(
            'provider_account_usage_snapshot_invalid',
        );
    }
    return translated.data;
}

export function projectBuiltInLegacyProviderAccountUsageSnapshotV1(
    value: ProviderAccountUsageSnapshotV1,
): unknown {
    const canonical = ProviderAccountUsageSnapshotV1Schema.parse(value);
    return replaceRecoveryCredits(canonical, projectLegacyRecoveryCredits);
}
