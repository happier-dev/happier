import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { reorderSessionOrganization as reorderSessionOrganizationApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import { sessionOrganizationStoreFor } from './sessionOrganizationAccountStore';
import type { ReorderSessionOrganizationRequest } from '@happier-dev/protocol/sessions/organization/mutations';

export async function reorderSessionOrganization(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    request: ReorderSessionOrganizationRequest;
}>): Promise<void> {
    params.assertCurrent?.();
    const optimisticEntries = params.request.entries.map((entry) => ({
        scopeKind: params.request.scopeKind,
        scopeKey: params.request.scopeKey,
        itemKind: entry.itemKind,
        itemKey: entry.itemKey,
        sortKey: entry.sortKey,
    }));
    const recordId = sessionOrganizationStoreFor(params).applySessionOrganizationOrderEntriesOptimistic(params.serverId, optimisticEntries);
    try {
        const response = await reorderSessionOrganizationApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            request: params.request,
        });
        params.assertCurrent?.();
        sessionOrganizationStoreFor(params).commitSessionOrganizationOptimistic(recordId);
        const reconcileRecordId = sessionOrganizationStoreFor(params).applySessionOrganizationOrderEntriesOptimistic(params.serverId, response.orderEntries);
        sessionOrganizationStoreFor(params).commitSessionOrganizationOptimistic(reconcileRecordId);
    } catch (error) {
        try {
            params.assertCurrent?.();
        } catch {
            // The retired Account owns its optimistic record.
            throw error;
        }
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
