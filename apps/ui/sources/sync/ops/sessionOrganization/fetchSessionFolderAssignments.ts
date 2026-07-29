import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchSessionFolderAssignmentsForSessions } from '@/sync/api/session/sessionOrganizationApi';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storageStore';

type SessionFolderAssignmentFetchPolicy = 'all' | 'missing';

const missingAssignmentFetchesBySessionKey = new Map<string, Promise<unknown>>();

function getSessionAssignmentKey(serverId: string, sessionId: string): string {
    return buildSessionOrganizationServerKey(serverId, sessionId);
}

function filterInFlightAssignmentSessionIds(params: Readonly<{
    serverId: string;
    sessionIds: readonly string[];
}>): string[] {
    return params.sessionIds.filter((sessionId) => (
        !missingAssignmentFetchesBySessionKey.has(getSessionAssignmentKey(params.serverId, sessionId))
    ));
}

function registerInFlightAssignmentFetch(params: Readonly<{
    serverId: string;
    sessionIds: readonly string[];
    promise: Promise<unknown>;
}>): void {
    for (const sessionId of params.sessionIds) {
        missingAssignmentFetchesBySessionKey.set(getSessionAssignmentKey(params.serverId, sessionId), params.promise);
    }
}

function unregisterInFlightAssignmentFetch(params: Readonly<{
    serverId: string;
    sessionIds: readonly string[];
    promise: Promise<unknown>;
}>): void {
    for (const sessionId of params.sessionIds) {
        const key = getSessionAssignmentKey(params.serverId, sessionId);
        if (missingAssignmentFetchesBySessionKey.get(key) === params.promise) {
            missingAssignmentFetchesBySessionKey.delete(key);
        }
    }
}

function filterMissingAssignmentSessionIds(params: Readonly<{
    assignmentsBySessionKey: Record<string, string | null>;
    serverId: string;
    sessionIds: readonly string[];
}>): string[] {
    return params.sessionIds.filter((sessionId) => (
        !Object.prototype.hasOwnProperty.call(
            params.assignmentsBySessionKey,
            buildSessionOrganizationServerKey(params.serverId, sessionId),
        )
    ));
}

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
    fetchPolicy?: SessionFolderAssignmentFetchPolicy;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const store = getStorage().getState();
    const sessionIdsMissingFromCache = params.fetchPolicy === 'missing'
        ? filterMissingAssignmentSessionIds({
            assignmentsBySessionKey: store.sessionOrganizationFolderAssignmentsBySessionKey,
            serverId: params.serverId,
            sessionIds: params.sessionIds,
        })
        : params.sessionIds;
    const sessionIds = params.fetchPolicy === 'missing'
        ? filterInFlightAssignmentSessionIds({
            serverId: params.serverId,
            sessionIds: sessionIdsMissingFromCache,
        })
        : sessionIdsMissingFromCache;
    if (sessionIds.length === 0) {
        if (sessionIdsMissingFromCache.length === 0) {
            store.setSessionFolderAssignmentsLoading(params.serverId, false);
        }
        return;
    }
    store.setSessionFolderAssignmentsLoading(params.serverId, true);
    const fetchPromise = fetchSessionFolderAssignmentsForSessions({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        sessionIds,
    });
    if (params.fetchPolicy === 'missing') {
        registerInFlightAssignmentFetch({
            serverId: params.serverId,
            sessionIds,
            promise: fetchPromise,
        });
    }
    try {
        const response = await fetchPromise;
        if (params.shouldContinue && !params.shouldContinue()) return;
        const currentStore = getStorage().getState();
        const applySessionIds = params.fetchPolicy === 'missing'
            ? filterMissingAssignmentSessionIds({
                assignmentsBySessionKey: currentStore.sessionOrganizationFolderAssignmentsBySessionKey,
                serverId: params.serverId,
                sessionIds,
            })
            : sessionIds;
        currentStore.applySessionFolderAssignments(params.serverId, resolveFetchedAssignments({
            requestedSessionIds: applySessionIds,
            assignments: response.assignments,
        }));
    } finally {
        if (params.fetchPolicy === 'missing') {
            unregisterInFlightAssignmentFetch({
                serverId: params.serverId,
                sessionIds,
                promise: fetchPromise,
            });
        }
        if (!params.shouldContinue || params.shouldContinue()) {
            getStorage().getState().setSessionFolderAssignmentsLoading(params.serverId, false);
        }
    }
}
