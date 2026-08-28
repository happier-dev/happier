import { z } from 'zod';

import {
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
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageConfidenceV1,
    type ProviderAccountUsageSnapshotV1,
    type ProviderAccountUsageSourceV1,
} from './providerAccountUsagePrimitives.js';

export * from './providerAccountUsagePrimitives.js';

export const SealedProviderAccountUsageSnapshotV1Schema = z.object({
    format: ConnectedServiceCredentialFormatSchema,
    ciphertext: z.string().min(1),
});
export type SealedProviderAccountUsageSnapshotV1 = z.infer<typeof SealedProviderAccountUsageSnapshotV1Schema>;

export const ProviderAccountUsagePayloadModeV1Schema = z.enum([
    'plain_json_v1',
    'sealed_account_scoped_v1',
]);

export const ProviderAccountUsageWriteStatusV1Schema = z.enum([
    'ok',
    'unavailable',
    'estimated',
    'error',
    'refresh_requested',
]);

export const ProviderAccountUsageRecordMetadataV1Schema = z.object({
    materialFingerprint: z.string().trim().min(1).max(256).optional(),
}).strict();

export const ProviderAccountUsageRecordWriteFieldsV1Schema = z.object({
    recordId: ProviderAccountUsageRecordIdSchema,
    recordKey: ProviderAccountUsageRecordKeyV1Schema,
    payloadMode: ProviderAccountUsagePayloadModeV1Schema,
    status: ProviderAccountUsageWriteStatusV1Schema,
    snapshot: ProviderAccountUsageSnapshotV1Schema.optional(),
    sealedPayload: SealedProviderAccountUsageSnapshotV1Schema.optional(),
    fetchedAt: z.number().int().nonnegative().optional(),
    staleAfterMs: z.number().int().nonnegative().optional(),
    refreshRequestedAt: z.number().int().nonnegative().optional(),
    metadata: ProviderAccountUsageRecordMetadataV1Schema.optional(),
}).strict();

export const ProviderAccountUsageRecordWriteV1Schema =
    ProviderAccountUsageRecordWriteFieldsV1Schema.superRefine((write, context) => {
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
    });
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
        fetchedAtMs: parsed.fetchedAtMs,
        staleAtMs: parsed.fetchedAtMs + parsed.staleAfterMs,
        source: mapUsageSourceToQuotaSource(parsed.source),
        confidence: mapUsageConfidenceToQuotaConfidence(parsed.confidence),
        ...(parsed.recoveryCredits ? { recoveryCredits: parsed.recoveryCredits satisfies ConnectedServiceQuotaRecoveryCreditsV1 } : {}),
        meters: parsed.meters,
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
