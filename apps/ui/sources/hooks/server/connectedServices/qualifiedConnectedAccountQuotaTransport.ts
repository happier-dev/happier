import {
    isTokenOnlyAuthCredentials,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import {
    getQualifiedConnectedAccountQuotaV4,
    requestQualifiedConnectedAccountQuotaRefreshV4,
} from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { ExpectedActiveServerFetchBasis } from '@/sync/http/client';
import { openQualifiedConnectedAccountQuotaResponseV4, type QualifiedConnectedAccountQuotaSnapshotV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { BuiltInLegacyConnectedAccountOperation } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';

export type QualifiedConnectedAccountQuotaTransportContext = Readonly<{
    credentials: AuthCredentials;
    ref: QualifiedConnectedAccountRef;
    serverBasis: ExpectedActiveServerFetchBasis;
    assertOperationAllowed(
        operation: BuiltInLegacyConnectedAccountOperation,
    ): Promise<void>;
}>;

export async function readQualifiedConnectedAccountQuota(
    context: QualifiedConnectedAccountQuotaTransportContext,
): Promise<Readonly<{ snapshot: QualifiedConnectedAccountQuotaSnapshotV4; recordId: ProviderAccountUsageRecordId }> | null> {
    // The server serves and scopes the read; the opened response is checked against `ref`.
    const response = await getQualifiedConnectedAccountQuotaV4(
        context.credentials,
        context.ref,
        { expectedActiveServer: context.serverBasis },
    );
    if (!response) return null;
    const material = isTokenOnlyAuthCredentials(context.credentials)
        ? null
        : resolveAccountScopedCryptoMaterialFromCredentials(
            context.credentials,
        );
    const opened = openQualifiedConnectedAccountQuotaResponseV4({
        response,
        expectedRef: context.ref,
        material,
    });
    if (!opened) {
        throw Object.assign(
            new Error('qualified_connected_account_quota_invalid'),
            { code: 'qualified_connected_account_quota_invalid' },
        );
    }
    return { snapshot: opened, recordId: response.sourceResolution.recordId };
}

export async function refreshQualifiedConnectedAccountQuota(
    context: QualifiedConnectedAccountQuotaTransportContext,
): Promise<void> {
    await context.assertOperationAllowed('quota_refresh');
    await requestQualifiedConnectedAccountQuotaRefreshV4(
        context.credentials,
        context.ref,
        { expectedActiveServer: context.serverBasis },
    );
}
