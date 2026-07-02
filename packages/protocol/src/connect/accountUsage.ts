import { sha256 } from '@noble/hashes/sha2';

import {
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
    type AccountScopedCryptoMaterial,
    type AccountScopedOpenResult,
} from '../crypto/accountScopedCipher.js';
import { encodeBase64 } from '../crypto/base64.js';
import { z } from 'zod';

import {
    ConnectedServiceCredentialFormatSchema,
    ConnectedServiceIdSchema,
    ConnectedServiceProfileIdSchema,
    ConnectedServiceQuotaConfidenceV1Schema,
    ConnectedServiceQuotaMeterV1Schema,
    ConnectedServiceQuotaSourceV1Schema,
    type ConnectedServiceQuotaConfidenceV1,
    type ConnectedServiceQuotaSnapshotV1,
    type ConnectedServiceQuotaSourceV1,
} from './connectedServiceSchemas.js';

const encoder = new TextEncoder();

export const ProviderAccountUsageRecordIdSchema = z.string().regex(/^paug_v1_[A-Za-z0-9_-]{8,}$/);
export type ProviderAccountUsageRecordId = z.infer<typeof ProviderAccountUsageRecordIdSchema>;

const ProviderAccountUsageOpaqueRefPartSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

function isPathLikeLocalCredentialRef(value: string): boolean {
    return value.startsWith('/')
        || value.startsWith('~/')
        || value.startsWith('~\\')
        || value.startsWith('file:')
        || /^[A-Za-z]:[\\/]/u.test(value)
        || value.includes('\\')
        || value.includes('/');
}

export function buildProviderAccountUsageOpaqueLocalCredentialRef(params: Readonly<{
    providerId: string;
    kind: string;
    value: string;
}>): string {
    const providerId = ProviderAccountUsageOpaqueRefPartSchema.parse(params.providerId);
    const kind = ProviderAccountUsageOpaqueRefPartSchema.parse(params.kind);
    const value = z.string().trim().min(1).max(4096).parse(params.value);
    const digest = sha256(encoder.encode(JSON.stringify({ providerId, kind, value })));
    return `opaque:${providerId}:${kind}:${encodeBase64(digest, 'base64url')}`;
}

export const ProviderAccountUsageSubjectKindV1Schema = z.enum([
    'account',
    'workspace',
    'organization',
    'tenant',
    'subscription',
    'project',
    'modelFamily',
    'unknown',
]);
export type ProviderAccountUsageSubjectKindV1 = z.infer<typeof ProviderAccountUsageSubjectKindV1Schema>;

export const ProviderAccountUsageQuotaScopeV1Schema = z.enum([
    'account',
    'workspace',
    'organization',
    'project',
    'model',
    'provider',
    'unknown',
]);
export type ProviderAccountUsageQuotaScopeV1 = z.infer<typeof ProviderAccountUsageQuotaScopeV1Schema>;

export const ProviderAccountUsageRecordKeyV1Schema = z.object({
    providerId: z.string().trim().min(1).max(128),
    accountSubjectId: z.string().trim().min(1).max(512),
    subjectKind: ProviderAccountUsageSubjectKindV1Schema,
    quotaScope: ProviderAccountUsageQuotaScopeV1Schema,
    quotaScopeId: z.string().trim().min(1).max(256).optional(),
}).strict();
export type ProviderAccountUsageRecordKeyV1 = z.infer<typeof ProviderAccountUsageRecordKeyV1Schema>;

export const ProviderAccountSubjectRefV1Schema = z.object({
    kind: z.enum(['providerSubject', 'provisionalLocalSubject']),
    id: z.string().trim().min(1).max(512),
    mergeKey: z.string().trim().min(1).max(512).optional(),
}).strict();
export type ProviderAccountSubjectRefV1 = z.infer<typeof ProviderAccountSubjectRefV1Schema>;

export const ProviderAccountUsageAliasV1Schema = z.object({
    kind: z.enum([
        'connectedServiceProfile',
        'connectedServiceGroupMember',
        'nativeCli',
        'appServerNative',
        'envCredential',
        'pluginCredential',
        'runtimeSession',
    ]),
    providerId: z.string().trim().min(1).max(128),
    serviceId: ConnectedServiceIdSchema.optional(),
    profileId: ConnectedServiceProfileIdSchema.optional(),
    groupId: z.string().trim().min(1).max(128).optional(),
    pluginId: z.string().trim().min(1).max(128).optional(),
    localCredentialRef: z.string().trim().min(1).max(256).optional(),
    sessionId: z.string().trim().min(1).max(256).optional(),
    accountSubjectId: z.string().trim().min(1).max(512),
}).strict().superRefine((alias, ctx) => {
    if ((alias.kind === 'connectedServiceProfile' || alias.kind === 'connectedServiceGroupMember')
        && (!alias.serviceId || !alias.profileId)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Connected-service aliases require serviceId and profileId',
        });
    }
    if (alias.kind === 'connectedServiceGroupMember' && !alias.groupId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Connected-service group member aliases require groupId',
            path: ['groupId'],
        });
    }
    if (alias.kind === 'pluginCredential' && !alias.pluginId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Plugin credential aliases require pluginId',
            path: ['pluginId'],
        });
    }
    if (alias.localCredentialRef && isPathLikeLocalCredentialRef(alias.localCredentialRef)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Local credential refs must be opaque and must not contain raw local paths',
            path: ['localCredentialRef'],
        });
    }
});
export type ProviderAccountUsageAliasV1 = z.infer<typeof ProviderAccountUsageAliasV1Schema>;

export const ProviderAccountUsageSourceV1Schema = z.enum([
    'runtimeSignal',
    'providerHttp',
    'proxy',
    'connectedServiceProbe',
    'cached',
    'manual',
    'unknown',
]);
export type ProviderAccountUsageSourceV1 = z.infer<typeof ProviderAccountUsageSourceV1Schema>;

export const ProviderAccountUsageConfidenceV1Schema = z.enum(['confirmed', 'estimated', 'unknown']);
export type ProviderAccountUsageConfidenceV1 = z.infer<typeof ProviderAccountUsageConfidenceV1Schema>;

export const ProviderAccountUsageStateV1Schema = z.enum([
    'not_loaded',
    'loaded_empty',
    'loaded_data',
    'stale_data',
    'error_last_known_good',
]);
export type ProviderAccountUsageStateV1 = z.infer<typeof ProviderAccountUsageStateV1Schema>;

const SECRET_FIELD_VALUE_PATTERN =
    /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|password|token|secret)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}/i;
const AUTHORIZATION_BEARER_VALUE_PATTERN = /\bauthorization\s*:\s*bearer\s+\S+/i;
const X_API_KEY_HEADER_VALUE_PATTERN = /\bx-api-key\s*:\s*\S{12,}/i;
const JWT_VALUE_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/;
const AWS_ACCESS_KEY_VALUE_PATTERN = /\b(?:A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/;
const GITHUB_TOKEN_VALUE_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/;
const OPENAI_SECRET_KEY_VALUE_PATTERN = /\bsk-[A-Za-z0-9]{20,}\b/;

function containsUnsafeProviderAccountUsageDiagnosticText(value: string | undefined): boolean {
    if (!value) return false;
    return SECRET_FIELD_VALUE_PATTERN.test(value)
        || AUTHORIZATION_BEARER_VALUE_PATTERN.test(value)
        || X_API_KEY_HEADER_VALUE_PATTERN.test(value)
        || JWT_VALUE_PATTERN.test(value)
        || AWS_ACCESS_KEY_VALUE_PATTERN.test(value)
        || GITHUB_TOKEN_VALUE_PATTERN.test(value)
        || OPENAI_SECRET_KEY_VALUE_PATTERN.test(value);
}

const ProviderAccountUsageDiagnosticV1Schema = z.object({
    kind: z.enum(['unavailable', 'provider_http', 'runtime_signal', 'projection', 'validation', 'storage', 'unknown']),
    code: z.string().trim().min(1).max(128).optional(),
    message: z.string().trim().min(1).max(512).optional(),
    status: z.number().int().min(100).max(599).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    observedAtMs: z.number().int().nonnegative().optional(),
}).strict().superRefine((diagnostic, ctx) => {
    if (diagnostic.headers) {
        for (const headerName of Object.keys(diagnostic.headers)) {
            const normalized = headerName.trim().toLowerCase();
            if (
                normalized === 'authorization'
                || normalized === 'proxy-authorization'
                || normalized === 'cookie'
                || normalized === 'set-cookie'
                || normalized.includes('authorization')
                || normalized.includes('token')
                || normalized.includes('secret')
                || normalized.includes('api-key')
            ) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Unsafe provider account usage diagnostic header',
                    path: ['headers', headerName],
                });
            }
        }
    }
    if (containsUnsafeProviderAccountUsageDiagnosticText(diagnostic.code)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Unsafe provider account usage diagnostic code',
            path: ['code'],
        });
    }
    if (containsUnsafeProviderAccountUsageDiagnosticText(diagnostic.message)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Unsafe provider account usage diagnostic message',
            path: ['message'],
        });
    }
});
export type ProviderAccountUsageDiagnosticV1 = z.infer<typeof ProviderAccountUsageDiagnosticV1Schema>;

export const ProviderAccountUsageSnapshotV1Schema = z.object({
    v: z.literal(1),
    recordId: ProviderAccountUsageRecordIdSchema,
    recordKey: ProviderAccountUsageRecordKeyV1Schema,
    providerId: z.string().trim().min(1).max(128),
    accountSubject: ProviderAccountSubjectRefV1Schema,
    aliases: z.array(ProviderAccountUsageAliasV1Schema),
    observedAtMs: z.number().int().nonnegative(),
    fetchedAtMs: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().min(1),
    source: ProviderAccountUsageSourceV1Schema,
    confidence: ProviderAccountUsageConfidenceV1Schema,
    state: ProviderAccountUsageStateV1Schema.default('loaded_data'),
    planLabel: z.string().trim().min(1).max(256).nullable().optional(),
    accountLabel: z.string().trim().min(1).max(256).nullable().optional(),
    meters: z.array(ConnectedServiceQuotaMeterV1Schema),
    diagnostics: z.array(ProviderAccountUsageDiagnosticV1Schema).optional(),
}).strict().superRefine((snapshot, ctx) => {
    if (snapshot.recordId !== buildProviderAccountUsageRecordId(snapshot.recordKey)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Snapshot recordId must match recordKey',
            path: ['recordId'],
        });
    }
    if (snapshot.providerId !== snapshot.recordKey.providerId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Snapshot providerId must match recordKey providerId',
            path: ['providerId'],
        });
    }
    if (snapshot.accountSubject.id !== snapshot.recordKey.accountSubjectId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Account subject id must match recordKey accountSubjectId',
            path: ['accountSubject', 'id'],
        });
    }
    for (const [index, alias] of snapshot.aliases.entries()) {
        if (alias.providerId !== snapshot.providerId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Alias providerId must match snapshot providerId',
                path: ['aliases', index, 'providerId'],
            });
        }
        if (alias.accountSubjectId !== snapshot.recordKey.accountSubjectId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Alias accountSubjectId must match recordKey accountSubjectId',
                path: ['aliases', index, 'accountSubjectId'],
            });
        }
    }
});
export type ProviderAccountUsageSnapshotV1 = z.infer<typeof ProviderAccountUsageSnapshotV1Schema>;

export const SealedProviderAccountUsageSnapshotV1Schema = z.object({
    format: ConnectedServiceCredentialFormatSchema,
    ciphertext: z.string().min(1),
});
export type SealedProviderAccountUsageSnapshotV1 = z.infer<typeof SealedProviderAccountUsageSnapshotV1Schema>;

const ProviderAccountUsageAdoptionProofV1Schema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('id_token_account_id'), issuer: z.string().trim().min(1).max(256).optional() }).strict(),
    z.object({ kind: z.literal('provider_account_id_match') }).strict(),
    z.object({ kind: z.literal('provider_owned_subject_proof'), detail: z.string().trim().min(1).max(256).optional() }).strict(),
]);

export const ProviderAccountUsageAdoptionV1Schema = z.object({
    providerId: z.string().trim().min(1).max(128),
    fromRecordId: ProviderAccountUsageRecordIdSchema,
    toRecordId: ProviderAccountUsageRecordIdSchema,
    stableRecordKey: ProviderAccountUsageRecordKeyV1Schema,
    proof: ProviderAccountUsageAdoptionProofV1Schema,
    observedAtMs: z.number().int().nonnegative(),
    aliases: z.array(ProviderAccountUsageAliasV1Schema),
}).strict().superRefine((adoption, ctx) => {
    if (adoption.providerId !== adoption.stableRecordKey.providerId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Adoption providerId must match stable record key providerId',
            path: ['providerId'],
        });
    }
    if (adoption.toRecordId !== buildProviderAccountUsageRecordId(adoption.stableRecordKey)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Adoption toRecordId must match stable record key',
            path: ['toRecordId'],
        });
    }
    for (const [index, alias] of adoption.aliases.entries()) {
        if (alias.providerId !== adoption.providerId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Adoption alias providerId must match adoption providerId',
                path: ['aliases', index, 'providerId'],
            });
        }
        if (alias.accountSubjectId !== adoption.stableRecordKey.accountSubjectId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Adoption alias accountSubjectId must match stable record key accountSubjectId',
                path: ['aliases', index, 'accountSubjectId'],
            });
        }
    }
});
export type ProviderAccountUsageAdoptionV1 = z.infer<typeof ProviderAccountUsageAdoptionV1Schema>;

function canonicalRecordKeyJson(key: ProviderAccountUsageRecordKeyV1): string {
    return JSON.stringify({
        providerId: key.providerId,
        accountSubjectId: key.accountSubjectId,
        subjectKind: key.subjectKind,
        quotaScope: key.quotaScope,
        ...(key.quotaScopeId ? { quotaScopeId: key.quotaScopeId } : {}),
    });
}

export function buildProviderAccountUsageRecordId(key: ProviderAccountUsageRecordKeyV1): ProviderAccountUsageRecordId {
    const parsed = ProviderAccountUsageRecordKeyV1Schema.parse(key);
    const digest = sha256(encoder.encode(canonicalRecordKeyJson(parsed)));
    return ProviderAccountUsageRecordIdSchema.parse(`paug_v1_${encodeBase64(digest, 'base64url')}`);
}

function aliasSortKey(alias: ProviderAccountUsageAliasV1): string {
    return JSON.stringify([
        alias.kind,
        alias.providerId,
        alias.serviceId ?? '',
        alias.profileId ?? '',
        alias.groupId ?? '',
        alias.pluginId ?? '',
        alias.localCredentialRef ?? '',
        alias.sessionId ?? '',
        alias.accountSubjectId,
    ]);
}

export function normalizeProviderAccountUsageAliases(
    aliases: readonly ProviderAccountUsageAliasV1[],
): readonly ProviderAccountUsageAliasV1[] {
    const byKey = new Map<string, ProviderAccountUsageAliasV1>();
    for (const rawAlias of aliases) {
        const alias = ProviderAccountUsageAliasV1Schema.parse(rawAlias);
        byKey.set(aliasSortKey(alias), alias);
    }
    return [...byKey.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, alias]) => alias);
}

function mapUsageSourceToQuotaSource(source: ProviderAccountUsageSourceV1): ConnectedServiceQuotaSourceV1 {
    const mapped: Record<ProviderAccountUsageSourceV1, ConnectedServiceQuotaSourceV1> = {
        runtimeSignal: 'in_band_provider_snapshot',
        providerHttp: 'provider_api',
        proxy: 'background_fetch',
        connectedServiceProbe: 'user_probe',
        cached: 'cached',
        manual: 'manual_refresh',
        unknown: 'unknown',
    };
    return ConnectedServiceQuotaSourceV1Schema.parse(mapped[source]);
}

function mapUsageConfidenceToQuotaConfidence(confidence: ProviderAccountUsageConfidenceV1): ConnectedServiceQuotaConfidenceV1 {
    const mapped: Record<ProviderAccountUsageConfidenceV1, ConnectedServiceQuotaConfidenceV1> = {
        confirmed: 'exact',
        estimated: 'estimated',
        unknown: 'unknown',
    };
    return ConnectedServiceQuotaConfidenceV1Schema.parse(mapped[confidence]);
}

export function projectProviderAccountUsageToConnectedServiceQuotaSnapshot(
    snapshot: ProviderAccountUsageSnapshotV1,
    target: Readonly<{ serviceId: string; profileId: string }>,
): ConnectedServiceQuotaSnapshotV1 | null {
    const parsed = ProviderAccountUsageSnapshotV1Schema.parse(snapshot);
    const serviceId = ConnectedServiceIdSchema.parse(target.serviceId);
    const profileId = ConnectedServiceProfileIdSchema.parse(target.profileId);
    const alias = parsed.aliases.find(candidate =>
        (candidate.kind === 'connectedServiceProfile' || candidate.kind === 'connectedServiceGroupMember')
        && candidate.serviceId === serviceId
        && candidate.profileId === profileId
    );
    if (!alias) return null;

    return {
        v: 1,
        serviceId,
        profileId,
        fetchedAt: parsed.fetchedAtMs,
        staleAfterMs: parsed.staleAfterMs,
        planLabel: parsed.planLabel ?? null,
        accountLabel: parsed.accountLabel ?? null,
        providerId: parsed.providerId,
        activeAccountId: parsed.recordKey.accountSubjectId,
        fetchedAtMs: parsed.fetchedAtMs,
        staleAtMs: parsed.fetchedAtMs + parsed.staleAfterMs,
        source: mapUsageSourceToQuotaSource(parsed.source),
        confidence: mapUsageConfidenceToQuotaConfidence(parsed.confidence),
        meters: parsed.meters,
    };
}

export function projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1(params: Readonly<{
    snapshot: ProviderAccountUsageSnapshotV1;
    serviceId: string;
    profileId: string;
}>): ConnectedServiceQuotaSnapshotV1 | null {
    return projectProviderAccountUsageToConnectedServiceQuotaSnapshot(params.snapshot, {
        serviceId: params.serviceId,
        profileId: params.profileId,
    });
}

export function sealProviderAccountUsageSnapshotCiphertext(params: Readonly<{
    material: AccountScopedCryptoMaterial;
    payload: unknown;
    randomBytes: (length: number) => Uint8Array;
}>): string {
    return sealAccountScopedBlobCiphertext({
        kind: 'provider_account_usage_snapshot',
        material: params.material,
        payload: params.payload,
        randomBytes: params.randomBytes,
    });
}

export function openProviderAccountUsageSnapshotCiphertext(params: Readonly<{
    material: AccountScopedCryptoMaterial;
    ciphertext: string;
}>): AccountScopedOpenResult {
    return openAccountScopedBlobCiphertext({
        kind: 'provider_account_usage_snapshot',
        material: params.material,
        ciphertext: params.ciphertext,
    });
}
