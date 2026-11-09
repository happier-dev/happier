import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { deleteSessionOrganizationTag as deleteSessionOrganizationTagApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import { sessionOrganizationStoreFor } from './sessionOrganizationAccountStore';
import type { DeleteSessionOrganizationTagRequest, DeleteSessionOrganizationTagResponse } from '@happier-dev/protocol/sessions/organization/mutations';

export async function deleteSessionTag(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    request: DeleteSessionOrganizationTagRequest;
}>): Promise<DeleteSessionOrganizationTagResponse> {
    params.assertCurrent?.();
    const recordId = sessionOrganizationStoreFor(params).deleteSessionOrganizationTagOptimistic(params.serverId, params.request.tagId);
    try {
        const response = await deleteSessionOrganizationTagApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            request: params.request,
        });
        params.assertCurrent?.();
        sessionOrganizationStoreFor(params).commitSessionOrganizationOptimistic(recordId);
        if (response.removedAssignmentCount > 0) {
            sessionOrganizationStoreFor(params).reconcileSessionOrganizationTagDelete(params.serverId, response.tagId);
        }
        return response;
    } catch (error) {
        try {
            params.assertCurrent?.();
            getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        } catch { /* The retired Account owns its optimistic record. */ }
        throw error;
    }
}
