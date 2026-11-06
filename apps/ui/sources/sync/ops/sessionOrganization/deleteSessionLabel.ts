import { sessionOrganizationStoreFor } from './sessionOrganizationAccountStore';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { deleteSessionOrganizationLabel as deleteSessionOrganizationLabelApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { DeleteSessionOrganizationLabelRequest } from '@happier-dev/protocol';

export async function deleteSessionLabel(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    request: DeleteSessionOrganizationLabelRequest;
}>): Promise<void> {
    params.assertCurrent?.();
    const recordId = sessionOrganizationStoreFor(params).deleteSessionOrganizationLabelOptimistic(
        params.serverId,
        params.request.labelKind,
        params.request.scopeKey,
    );
    try {
        await deleteSessionOrganizationLabelApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            request: params.request,
        });
        params.assertCurrent?.();
        sessionOrganizationStoreFor(params).commitSessionOrganizationOptimistic(recordId);
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
