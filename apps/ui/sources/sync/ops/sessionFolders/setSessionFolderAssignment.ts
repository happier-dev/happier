import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionFolderAssignment as setSessionFolderAssignmentApi } from '@/sync/api/session/sessionFolderAssignmentsApi';
import { getStorage } from '@/sync/domains/state/storageStore';

export async function setSessionFolderAssignment(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
    folderId: string | null;
}>): Promise<void> {
    const store = getStorage().getState();
    const previousFolderId = store.setSessionFolderAssignmentOptimistic(params.serverId, params.sessionId, params.folderId);
    try {
        const response = await setSessionFolderAssignmentApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            sessionId: params.sessionId,
            folderId: params.folderId,
        });
        getStorage().getState().applySessionFolderAssignments(params.serverId, [response]);
    } catch (error) {
        getStorage().getState().rollbackSessionFolderAssignment(params.serverId, params.sessionId, previousFolderId);
        throw error;
    }
}
