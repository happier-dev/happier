import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchSessionFolderAssignmentsForSessions } from '@/sync/api/session/sessionOrganizationApi';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { isHomeCredentialCurrent } from '@/sync/runtime/orchestration/homeAccountChange';
import { getStorage } from '@/sync/domains/state/storageStore';

function resolveFetchedAssignments(params: Readonly<{
    requestedSessionIds: readonly string[];
    assignments: readonly { sessionId: string; folderId: string | null }[];
}>): { sessionId: string; folderId: string | null }[] {
    const assignedFolderBySessionId = new Map(
        params.assignments.map((assignment) => [assignment.sessionId, assignment.folderId]),
    );
    return Array.from(new Set(params.requestedSessionIds)).map((sessionId) => ({
        sessionId,
        folderId: assignedFolderBySessionId.get(sessionId) ?? null,
    }));
}

export async function fetchAndApplySessionFolderAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionIds: readonly string[];
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const activation = captureActiveServerAccountScopeCurrentness();
    const sessionIds = params.sessionIds;
    if (sessionIds.length === 0) return;
    const fetchPromise = fetchSessionFolderAssignmentsForSessions({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        sessionIds,
    });
    const response = await fetchPromise;
    if (!activation.isCurrent()) return;
    if (params.shouldContinue && !params.shouldContinue()) return;
    if (!isHomeCredentialCurrent(params.serverId, params.credentials)) return;
    getStorage().getState().applySessionFolderAssignments(params.serverId, resolveFetchedAssignments({
        requestedSessionIds: sessionIds,
        assignments: response.assignments,
    }));
}
