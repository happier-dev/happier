import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    getQualifiedConnectedAccountQuotaV4,
    requestQualifiedConnectedAccountQuotaRefreshV4,
} from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { ExpectedActiveServerFetchBasis } from '@/sync/http/client';
import {
    openQualifiedConnectedAccountQuotaResponseV4,
    type BuiltInLegacyConnectedAccountOperation,
    type QualifiedConnectedAccountQuotaSnapshotV4,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

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
): Promise<QualifiedConnectedAccountQuotaSnapshotV4 | null> {
    const material =
        resolveAccountScopedCryptoMaterialFromCredentials(
            context.credentials,
        );
    await context.assertOperationAllowed('quota_read');
    const response = await getQualifiedConnectedAccountQuotaV4(
        context.credentials,
        context.ref,
        { expectedActiveServer: context.serverBasis },
    );
    if (!response) return null;
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
    return opened;
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
