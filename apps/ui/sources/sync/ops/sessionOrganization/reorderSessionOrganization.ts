import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { reorderSessionOrganization as reorderSessionOrganizationApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { ReorderSessionOrganizationRequest } from '@happier-dev/protocol';

export async function reorderSessionOrganization(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    request: ReorderSessionOrganizationRequest;
}>): Promise<void> {
    const optimisticEntries = params.request.entries.map((entry) => ({
        scopeKind: params.request.scopeKind,
        scopeKey: params.request.scopeKey,
        itemKind: entry.itemKind,
        itemKey: entry.itemKey,
        sortKey: entry.sortKey,
    }));
    const recordId = getStorage().getState().applySessionOrganizationOrderEntriesOptimistic(params.serverId, optimisticEntries);
    try {
        const response = await reorderSessionOrganizationApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            request: params.request,
        });
        getStorage().getState().commitSessionOrganizationOptimistic(recordId);
        const reconcileRecordId = getStorage().getState().applySessionOrganizationOrderEntriesOptimistic(params.serverId, response.orderEntries);
        getStorage().getState().commitSessionOrganizationOptimistic(reconcileRecordId);
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
