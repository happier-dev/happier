import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionFolderAssignment as setSessionFolderAssignmentApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';

export async function setSessionFolderAssignment(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
    folderId: string | null;
}>): Promise<void> {
    const recordId = getStorage().getState().setSessionOrganizationFolderAssignmentOptimistic(
        params.serverId,
        params.sessionId,
        params.folderId,
    );
    try {
        const response = await setSessionFolderAssignmentApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            sessionId: params.sessionId,
            request: { folderId: params.folderId },
        });
        getStorage().getState().commitSessionOrganizationOptimistic(recordId);
        getStorage().getState().applySessionFolderAssignments(params.serverId, [response]);
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
