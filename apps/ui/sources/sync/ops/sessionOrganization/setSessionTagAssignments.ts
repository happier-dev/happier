import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionTagAssignments as setSessionTagAssignmentsApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';

export async function setSessionTagAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
    tagIds: readonly string[];
}>): Promise<void> {
    const recordId = getStorage().getState().setSessionTagAssignmentsOptimistic(params.serverId, params.sessionId, params.tagIds);
    try {
        const response = await setSessionTagAssignmentsApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            sessionId: params.sessionId,
            request: { tagIds: [...params.tagIds] },
        });
        getStorage().getState().commitSessionOrganizationOptimistic(recordId);
        const reconcileRecordId = getStorage().getState().setSessionTagAssignmentsOptimistic(params.serverId, response.sessionId, response.tagIds);
        getStorage().getState().commitSessionOrganizationOptimistic(reconcileRecordId);
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
