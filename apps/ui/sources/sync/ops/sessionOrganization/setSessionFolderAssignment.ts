import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionFolderAssignment as setSessionFolderAssignmentApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';

export async function setSessionFolderAssignment(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    sessionId: string;
    folderId: string | null;
}>): Promise<void> {
    params.assertCurrent?.();
    const recordId = getStorage().getState().setSessionOrganizationFolderAssignmentOptimistic(
        params.serverId,
        params.sessionId,
        params.folderId,
    );
    try {
        const response = await setSessionFolderAssignmentApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            sessionId: params.sessionId,
            request: { folderId: params.folderId },
        });
        params.assertCurrent?.();
        getStorage().getState().commitSessionOrganizationOptimistic(recordId);
        getStorage().getState().applySessionFolderAssignments(params.serverId, [response]);
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
