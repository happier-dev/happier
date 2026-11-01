import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchSessionFolderAssignmentsForSessions } from '@/sync/api/session/sessionOrganizationApi';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';

type SessionFolderAssignmentFetchPolicy = 'all' | 'missing';

type MissingAssignmentFetchScope = Readonly<{
    profileScope: ServerAccountScope | null;
    requestsBySessionId: Map<string, Promise<unknown>>;
}>;

const missingAssignmentFetchesByScope = new Map<string, MissingAssignmentFetchScope>();

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
    if (params.shouldContinue && !params.shouldContinue()) return;
    const store = getStorage().getState();
    const profileScope = store.profileScope;
    const serverGeneration = getActiveServerSnapshot().generation;
    const isScopeCurrent = () => getStorage().getState().profileScope === profileScope
        && getActiveServerSnapshot().generation === serverGeneration;
    const fetchScopeKey = JSON.stringify([
        params.serverId, params.serverUrl ?? null, params.credentials.token, serverGeneration,
    ]);
    const existingFetchScope = missingAssignmentFetchesByScope.get(fetchScopeKey);
    const fetchScope: MissingAssignmentFetchScope = existingFetchScope?.profileScope === profileScope
        ? existingFetchScope
        : { profileScope, requestsBySessionId: new Map() };
    const sessionIdsMissingFromCache = params.fetchPolicy === 'missing'
        ? filterMissingAssignmentSessionIds({
            assignmentsBySessionKey: store.sessionOrganizationFolderAssignmentsBySessionKey,
            serverId: params.serverId,
            sessionIds: params.sessionIds,
        })
        : params.sessionIds;
    const sessionIds = params.fetchPolicy === 'missing'
        ? sessionIdsMissingFromCache.filter((sessionId) => !fetchScope.requestsBySessionId.has(sessionId))
        : sessionIdsMissingFromCache;
    if (sessionIds.length === 0) {
        if (sessionIdsMissingFromCache.length === 0 && fetchScope.requestsBySessionId.size === 0) {
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
        missingAssignmentFetchesByScope.set(fetchScopeKey, fetchScope);
        for (const sessionId of sessionIds) fetchScope.requestsBySessionId.set(sessionId, fetchPromise);
    }
    try {
        const response = await fetchPromise;
        // Missing reads learn for the account/server activation, even if source churn
        // has already replaced the render effect that originally requested them.
        if (!isScopeCurrent()) return;
        if (params.fetchPolicy !== 'missing' && params.shouldContinue && !params.shouldContinue()) return;
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
            for (const sessionId of sessionIds) {
                if (fetchScope.requestsBySessionId.get(sessionId) === fetchPromise) {
                    fetchScope.requestsBySessionId.delete(sessionId);
                }
            }
            if (fetchScope.requestsBySessionId.size === 0 && missingAssignmentFetchesByScope.get(fetchScopeKey) === fetchScope) {
                missingAssignmentFetchesByScope.delete(fetchScopeKey);
            }
        }
        if (isScopeCurrent() && (params.fetchPolicy === 'missing' || !params.shouldContinue || params.shouldContinue())) {
            getStorage().getState().setSessionFolderAssignmentsLoading(params.serverId, fetchScope.requestsBySessionId.size > 0);
        }
    }
}
