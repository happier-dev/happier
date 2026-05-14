import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchSessionFolderAssignmentsForSessions } from '@/sync/api/session/sessionFolderAssignmentsApi';
import { buildSessionFolderAssignmentKey } from '@/sync/domains/session/folders';
import { getStorage } from '@/sync/domains/state/storageStore';

type SessionFolderAssignmentFetchPolicy = 'all' | 'missing';

export async function fetchAndApplySessionFolderAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionIds: readonly string[];
    fetchPolicy?: SessionFolderAssignmentFetchPolicy;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const store = getStorage().getState();
    const sessionIds = params.fetchPolicy === 'missing'
        ? params.sessionIds.filter((sessionId) => (
            !Object.prototype.hasOwnProperty.call(
                store.sessionFolderAssignmentsBySessionKey,
                buildSessionFolderAssignmentKey(params.serverId, sessionId),
            )
        ))
        : params.sessionIds;
    if (sessionIds.length === 0) {
        store.setSessionFolderAssignmentsLoading(params.serverId, false);
        return;
    }
    store.setSessionFolderAssignmentsLoading(params.serverId, true);
    try {
        const response = await fetchSessionFolderAssignmentsForSessions({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            sessionIds,
        });
        if (params.shouldContinue && !params.shouldContinue()) return;
        getStorage().getState().applySessionFolderAssignments(params.serverId, response.assignments);
    } finally {
        if (!params.shouldContinue || params.shouldContinue()) {
            getStorage().getState().setSessionFolderAssignmentsLoading(params.serverId, false);
        }
    }
}
