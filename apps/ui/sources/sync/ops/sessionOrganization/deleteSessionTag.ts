import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { deleteSessionOrganizationTag as deleteSessionOrganizationTagApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { DeleteSessionOrganizationTagRequest } from '@happier-dev/protocol';

export async function deleteSessionTag(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    request: DeleteSessionOrganizationTagRequest;
}>): Promise<void> {
    const recordId = getStorage().getState().deleteSessionOrganizationTagOptimistic(params.serverId, params.request.tagId);
    try {
        const response = await deleteSessionOrganizationTagApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            request: params.request,
        });
        getStorage().getState().commitSessionOrganizationOptimistic(recordId);
        if (response.removedAssignmentCount > 0) {
            getStorage().getState().reconcileSessionOrganizationTagDelete(params.serverId, response.tagId);
        }
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
