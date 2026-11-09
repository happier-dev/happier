import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { deleteSessionOrganizationFolder as deleteSessionOrganizationFolderApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import { sessionOrganizationStoreFor } from './sessionOrganizationAccountStore';
import type { DeleteSessionOrganizationFolderRequest, DeleteSessionOrganizationFolderResponse } from '@happier-dev/protocol/sessions/organization/mutations';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization/keys';

export async function deleteSessionFolder(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    request: DeleteSessionOrganizationFolderRequest;
}>): Promise<DeleteSessionOrganizationFolderResponse> {
    params.assertCurrent?.();
    const previousFolder = sessionOrganizationStoreFor(params).sessionOrganizationFoldersByFolderKey[
        buildSessionOrganizationServerKey(params.serverId, params.request.folderId)];
    const recordId = sessionOrganizationStoreFor(params).deleteSessionOrganizationFolderOptimistic(params.serverId, params.request.folderId);
    try {
        const response = await deleteSessionOrganizationFolderApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            request: params.request,
        });
        params.assertCurrent?.();
        sessionOrganizationStoreFor(params).commitSessionOrganizationOptimistic(recordId);
        for (const folderId of response.deletedFolderIds) {
            const reconcileRecordId = sessionOrganizationStoreFor(params).deleteSessionOrganizationFolderOptimistic(params.serverId, folderId);
            sessionOrganizationStoreFor(params).commitSessionOrganizationOptimistic(reconcileRecordId);
        }
        sessionOrganizationStoreFor(params).reconcileSessionOrganizationFolderDelete(
            params.serverId,
            response.deletedFolderIds,
            response.assignmentTargetFolderId,
            previousFolder?.parentFolderId === response.assignmentTargetFolderId ? previousFolder.parentFolderKey : undefined,
        );
        return response;
    } catch (error) {
        try {
            params.assertCurrent?.();
            getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        } catch { /* The retired Account owns its optimistic record. */ }
        throw error;
    }
}
