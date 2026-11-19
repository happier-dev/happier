import { lazyZodSchema } from '../lazyZodSchema.js';
import { parseBuiltInLegacyProviderAccountUsageSnapshotV1 } from './legacyConnectedServiceCompatibility.js';
import type { PluginConnectedAccountDescriptorContributionV2 } from './pluginConnectedAccountAuthenticationV2.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

import {
    createAccountScopedBlobOpener,
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
    type AccountScopedCryptoMaterial,
    type AccountScopedOpenResult,
} from '../crypto/accountScopedCipher.js';
import {
    ConnectedServiceCredentialFormatSchema,
    ConnectedServiceQuotaConfidenceV1Schema,
    ConnectedServiceQuotaMeterV1Schema,
    ConnectedServiceQuotaRecoveryCreditsV1Schema,
    ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema,
    ConnectedServiceQuotaSourceV1Schema,
    ConnectedServiceUsageSourceV1Schema,
    type ConnectedServiceQuotaConfidenceV1,
    type ConnectedServiceQuotaRecoveryCreditsV1,
    type ConnectedServiceQuotaSnapshotV1,
    type ConnectedServiceQuotaSourceV1,
    type ConnectedServiceUsageSourceV1,
} from './connectedServiceSchemas.js';
import { readBuiltInLegacyConnectedServiceIdForQualifiedService } from './connectedServiceBindings.js';
import { parseQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';
import {
    ProviderAccountUsageConfidenceV1Schema,
    ProviderAccountUsageRecordIdSchema,
    ProviderAccountUsageRecordKeyV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    ProviderAccountUsageSourceV1Schema,
    SealedProviderAccountUsageRecoveryCreditDetailsV1Schema,
    buildProviderAccountUsageRecordId,
    getProviderAccountUsageRefreshErrorAt,
    type ProviderAccountUsageConfidenceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
    type ProviderAccountUsageSourceV1,
} from './providerAccountUsagePrimitives.js';
import {
    ProviderAccountSubscriptionV1Schema,
    SealedProviderAccountSubscriptionV1Schema,
} from './accountSubscription.js';

export * from './providerAccountUsagePrimitives.js';

export type ProviderAccountUsageOrganizationContext = Readonly<{
    providerAccountId: string | null;
    providerOrganizationId: string | null;
}>;

/** Compare the account-owned organization allowance across PAU and its quota projection. */
export function isProviderAccountUsageOrganizationContextMatch(
    observed: Pick<ProviderAccountUsageRecordKeyV1, 'accountSubjectId' | 'subjectKind' | 'quotaScope' | 'quotaScopeId'>
        | Pick<ConnectedServiceQuotaSnapshotV1, 'activeAccountId' | 'providerOrganizationId'>,
    current: ProviderAccountUsageOrganizationContext | null,
): boolean {
    if (!current?.providerAccountId || !current.providerOrganizationId) return false;
    if ('quotaScope' in observed) {
        return observed.subjectKind === 'account'
            && observed.quotaScope === 'organization'
            && observed.accountSubjectId === current.providerAccountId
            && observed.quotaScopeId === current.providerOrganizationId;
    }
    return observed.activeAccountId === current.providerAccountId
        && observed.providerOrganizationId === current.providerOrganizationId;
}

/** Admit a usage observation against its declared provider and current account context. */
export function isProviderAccountUsageIdentityMatch(
    observed: Pick<ProviderAccountUsageRecordKeyV1, 'providerId' | 'accountSubjectId' | 'subjectKind' | 'quotaScope' | 'quotaScopeId'>
        | Pick<ConnectedServiceQuotaSnapshotV1, 'providerId' | 'activeAccountId' | 'providerOrganizationId'>,
    current: ProviderAccountUsageOrganizationContext | null,
    usageIdentity?: PluginConnectedAccountDescriptorContributionV2['usageIdentity'] | null,
): boolean {
    if (usageIdentity?.providerId !== undefined && observed.providerId !== undefined
        && observed.providerId !== usageIdentity.providerId) return false;
    const observedOrganization = 'quotaScope' in observed
        ? observed.quotaScope === 'organization'
        : Boolean(observed.providerOrganizationId);
    if (usageIdentity?.requiredContext === 'organization' || observedOrganization || current?.providerOrganizationId) {
        return isProviderAccountUsageOrganizationContextMatch(observed, current);
    }
    if (!current?.providerAccountId) return true;
    return 'quotaScope' in observed
        ? observed.subjectKind === 'account' && observed.accountSubjectId === current.providerAccountId
        : observed.activeAccountId === current.providerAccountId;
}

export const SealedProviderAccountUsageSnapshotV1Schema = lazyZodSchema(() => z.object({
    format: ConnectedServiceCredentialFormatSchema,
    ciphertext: z.string().check(z.minLength(1)),
    refreshErrorAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    subscription: z.optional(SealedProviderAccountSubscriptionV1Schema),
    recoveryCreditDetails: z.optional(SealedProviderAccountUsageRecoveryCreditDetailsV1Schema),
}));
export type SealedProviderAccountUsageSnapshotV1 = z.infer<typeof SealedProviderAccountUsageSnapshotV1Schema>;

export const ProviderAccountUsagePayloadModeV1Schema = lazyZodSchema(() => z.enum([
    'plain_json_v1',
    'sealed_account_scoped_v1',
]));

export const ProviderAccountUsageWriteStatusV1Schema = lazyZodSchema(() => z.enum([
    'ok',
    'unavailable',
    'estimated',
    'error',
    'refresh_requested',
]));

export const ProviderAccountUsageRecordMetadataV1Schema = lazyZodSchema(() => z.strictObject({
    materialFingerprint: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
}));

export const ProviderAccountUsageRecordWriteFieldsV1Schema = lazyZodSchema(() => z.strictObject({
    recordId: ProviderAccountUsageRecordIdSchema,
    recordKey: ProviderAccountUsageRecordKeyV1Schema,
    payloadMode: ProviderAccountUsagePayloadModeV1Schema,
    status: ProviderAccountUsageWriteStatusV1Schema,
    snapshot: z.optional(ProviderAccountUsageSnapshotV1Schema),
    sealedPayload: z.optional(SealedProviderAccountUsageSnapshotV1Schema),
    fetchedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    staleAfterMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    refreshRequestedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    metadata: z.optional(ProviderAccountUsageRecordMetadataV1Schema),
}));

export const ProviderAccountUsageRecordWriteV1Schema =
    lazyZodSchema(() => ProviderAccountUsageRecordWriteFieldsV1Schema.check(z.superRefine((write, context) => {
        if (write.recordId !== buildProviderAccountUsageRecordId(write.recordKey)) {
            context.addIssue({
                code: 'custom',
                path: ['recordId'],
                message: 'Provider account usage recordId must match recordKey',
            });
        }
        if (write.status === 'refresh_requested') {
            if (write.snapshot !== undefined || write.sealedPayload !== undefined) {
                context.addIssue({
                    code: 'custom',
                    path: ['status'],
                    message: 'Refresh-requested provider account usage records must not carry snapshot payload',
                });
            }
            return;
        }
        if (write.payloadMode === 'plain_json_v1') {
            if (write.snapshot === undefined || write.sealedPayload !== undefined) {
                context.addIssue({
                    code: 'custom',
                    path: ['payloadMode'],
                    message: 'Plain provider account usage records require exactly one plain snapshot payload',
                });
            } else if (write.snapshot.recordId !== write.recordId) {
                context.addIssue({
                    code: 'custom',
                    path: ['snapshot', 'recordId'],
                    message: 'Provider account usage snapshot recordId must match the write recordId',
                });
            }
        } else if (
            write.sealedPayload === undefined
            || write.snapshot !== undefined
        ) {
            context.addIssue({
                code: 'custom',
                path: ['payloadMode'],
                message: 'Sealed provider account usage records require exactly one sealed payload',
            });
        }
    })));
export type ProviderAccountUsageRecordWriteV1 = z.infer<
    typeof ProviderAccountUsageRecordWriteV1Schema
>;

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

export type ProviderAccountUsageQuotaSnapshotFieldsV1 = Omit<
    ConnectedServiceQuotaSnapshotV1,
    'serviceId' | 'profileId'
>;

export function projectProviderAccountUsageSnapshotToQuotaFieldsV1(
    snapshot: ProviderAccountUsageSnapshotV1,
): ProviderAccountUsageQuotaSnapshotFieldsV1 {
    const parsed = ProviderAccountUsageSnapshotV1Schema.parse(snapshot);

    return {
        v: 1,
        fetchedAt: parsed.fetchedAtMs,
        staleAfterMs: parsed.staleAfterMs,
        planLabel: parsed.planLabel ?? null,
        accountLabel: parsed.accountLabel ?? null,
        providerId: parsed.providerId,
        activeAccountId: parsed.recordKey.accountSubjectId,
        ...(parsed.recordKey.quotaScope === 'organization' && parsed.recordKey.quotaScopeId
            ? { providerOrganizationId: parsed.recordKey.quotaScopeId } : {}),
        fetchedAtMs: parsed.fetchedAtMs,
        staleAtMs: parsed.fetchedAtMs + parsed.staleAfterMs,
        source: mapUsageSourceToQuotaSource(parsed.source),
        confidence: mapUsageConfidenceToQuotaConfidence(parsed.confidence),
        ...(parsed.recoveryCredits ? { recoveryCredits: parsed.recoveryCredits satisfies ConnectedServiceQuotaRecoveryCreditsV1 } : {}),
        ...(parsed.recoveryCreditDetails ? { recoveryCreditDetails: parsed.recoveryCreditDetails } : {}),
        ...(parsed.subscription ? { subscription: parsed.subscription } : {}),
        meters: parsed.meters,
        ...(parsed.diagnostics ? { diagnostics: parsed.diagnostics } : {}),
        ...(parsed.state ? { state: parsed.state } : {}),
    };
}

export function projectProviderAccountUsageToConnectedServiceQuotaSnapshot(
    snapshot: ProviderAccountUsageSnapshotV1,
    source: ConnectedServiceUsageSourceV1,
): ConnectedServiceQuotaSnapshotV1 | null {
    const parsedSource = ConnectedServiceUsageSourceV1Schema.parse(source);
    const service = parseQualifiedPluginContributionKey(parsedSource.serviceId);
    const legacyServiceId = service
        ? readBuiltInLegacyConnectedServiceIdForQualifiedService(service)
        : null;
    if (!legacyServiceId) return null;
    return {
        ...projectProviderAccountUsageSnapshotToQuotaFieldsV1(snapshot),
        serviceId: legacyServiceId,
        profileId: parsedSource.profileId,
    };
}

export function projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1(params: Readonly<{
    snapshot: ProviderAccountUsageSnapshotV1;
    source: ConnectedServiceUsageSourceV1;
}>): ConnectedServiceQuotaSnapshotV1 | null {
    return projectProviderAccountUsageToConnectedServiceQuotaSnapshot(params.snapshot, params.source);
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

const ProviderAccountUsageSubscriptionFacetV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    recordId: ProviderAccountUsageRecordIdSchema,
    subscription: ProviderAccountSubscriptionV1Schema,
}));
const ProviderAccountUsageRecoveryCreditDetailsFacetV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), recordId: ProviderAccountUsageRecordIdSchema,
    fetchedAtMs: z.number().check(z.int(), z.nonnegative()), recoveryCreditDetails: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema,
}));

export function sealProviderAccountUsageSnapshot(params: Readonly<{
    material: AccountScopedCryptoMaterial;
    snapshot: ProviderAccountUsageSnapshotV1;
    randomBytes: (length: number) => Uint8Array;
}>): SealedProviderAccountUsageSnapshotV1 {
    const { subscription, recoveryCreditDetails, ...snapshot } = ProviderAccountUsageSnapshotV1Schema.parse(params.snapshot);
    return {
        format: 'account_scoped_v1',
        ciphertext: sealProviderAccountUsageSnapshotCiphertext({ ...params, payload: snapshot }),
        ...(getProviderAccountUsageRefreshErrorAt(snapshot) !== undefined
            ? { refreshErrorAt: getProviderAccountUsageRefreshErrorAt(snapshot) } : {}),
        ...(subscription ? {
            subscription: {
                observedAtMs: Math.max(subscription.observedAtMs, subscription.lastRefreshError?.observedAtMs ?? 0),
                ciphertext: sealProviderAccountUsageSnapshotCiphertext({
                    ...params,
                    payload: { v: 1, recordId: snapshot.recordId, subscription },
                }),
            },
        } : {}),
        ...(recoveryCreditDetails ? {
            recoveryCreditDetails: { ciphertext: sealProviderAccountUsageSnapshotCiphertext({ ...params,
                payload: { v: 1, recordId: snapshot.recordId, fetchedAtMs: snapshot.fetchedAtMs, recoveryCreditDetails },
            }) },
        } : {}),
    };
}

type ProviderAccountUsageEncryptedContentV4 = Readonly<{ t: 'encrypted'; c: string }>
    & Omit<SealedProviderAccountUsageSnapshotV1, 'format' | 'ciphertext'>;

/** @internal Share key setup within one finite reader with fixed Account material. */
export function createProviderAccountUsageEncryptedContentOpenerV4(material: AccountScopedCryptoMaterial) {
    const openCiphertext = createAccountScopedBlobOpener({ kind: 'provider_account_usage_snapshot', material });
    return (content: ProviderAccountUsageEncryptedContentV4): ProviderAccountUsageSnapshotV1 | null =>
        openSealedUsageSnapshot({ ...content, format: 'account_scoped_v1', ciphertext: content.c }, openCiphertext);
}

/** Open the V4 encrypted transport through the same supplemental-envelope owner. */
export function openProviderAccountUsageEncryptedContentV4(params: Readonly<{
    material: AccountScopedCryptoMaterial; content: ProviderAccountUsageEncryptedContentV4;
}>): ProviderAccountUsageSnapshotV1 | null {
    return createProviderAccountUsageEncryptedContentOpenerV4(params.material)(params.content);
}

export function openSealedProviderAccountUsageSnapshot(params: Readonly<{
    material: AccountScopedCryptoMaterial;
    sealed: SealedProviderAccountUsageSnapshotV1;
}>): ProviderAccountUsageSnapshotV1 | null {
    return openSealedUsageSnapshot(params.sealed,
        createAccountScopedBlobOpener({ kind: 'provider_account_usage_snapshot', material: params.material }));
}

function openSealedUsageSnapshot(input: SealedProviderAccountUsageSnapshotV1,
    openCiphertext: (ciphertext: string) => AccountScopedOpenResult): ProviderAccountUsageSnapshotV1 | null {
    const sealed = createStoredReadSchema(SealedProviderAccountUsageSnapshotV1Schema).safeParse(input);
    if (!sealed.success) return null;
    const opened = openCiphertext(sealed.data.ciphertext);
    let snapshot: ProviderAccountUsageSnapshotV1;
    try {
        snapshot = parseBuiltInLegacyProviderAccountUsageSnapshotV1(opened?.value);
    } catch {
        return null;
    }
    const result = { ...snapshot };
    if (sealed.data.recoveryCreditDetails) {
        const facet = openCiphertext(sealed.data.recoveryCreditDetails.ciphertext);
        const parsedFacet = createStoredReadSchema(ProviderAccountUsageRecoveryCreditDetailsFacetV1Schema).safeParse(facet?.value);
        if (!parsedFacet.success || parsedFacet.data.recordId !== snapshot.recordId || parsedFacet.data.fetchedAtMs !== snapshot.fetchedAtMs) return null;
        result.recoveryCreditDetails = parsedFacet.data.recoveryCreditDetails;
    }
    if (!sealed.data.subscription) return result;
    const facet = openCiphertext(sealed.data.subscription.ciphertext);
    const parsedFacet = createStoredReadSchema(ProviderAccountUsageSubscriptionFacetV1Schema).safeParse(facet?.value);
    if (!parsedFacet.success || parsedFacet.data.recordId !== snapshot.recordId) return null;
    const subscription = parsedFacet.data.subscription;
    if (
        Math.max(subscription.observedAtMs, subscription.lastRefreshError?.observedAtMs ?? 0)
        !== sealed.data.subscription.observedAtMs
    ) return null;
    return { ...result, subscription };
}
