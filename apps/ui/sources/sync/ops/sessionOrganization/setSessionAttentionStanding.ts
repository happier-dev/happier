import { type AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionAttentionStanding as setSessionAttentionStandingApi } from '@/sync/api/session/sessionOrganizationApi';
import { resolveSessionOrganizationMutationScope } from '@/sync/domains/session/organization/mutationScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

export async function setSessionAttentionStanding(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
    standing: boolean | null;
}>): Promise<void> {
    const optimisticStanding = params.standing === null
        ? null
        : { sessionId: params.sessionId, standing: params.standing, updatedAt: Date.now() };
    const recordId = getStorage().getState().setSessionAttentionStandingOptimistic(params.serverId, params.sessionId, optimisticStanding);
    try {
        const response = await setSessionAttentionStandingApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            sessionId: params.sessionId,
            request: { standing: params.standing },
        });
        getStorage().getState().commitSessionOrganizationOptimistic(recordId);
        const reconcileRecordId = getStorage().getState().setSessionAttentionStandingOptimistic(params.serverId, params.sessionId, response.standing);
        getStorage().getState().commitSessionOrganizationOptimistic(reconcileRecordId);
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}

const MISSING_SCOPE_MESSAGE_BY_REASON = {
    'server-id': 'Missing server for session attention standing',
    'server-profile': 'Missing server profile for session attention standing',
    credentials: 'Missing server credentials for session attention standing',
} as const;

export type SessionSetAttentionStandingResult = Readonly<{
    success: boolean;
    message?: string;
}>;

/**
 * The single-session entrypoint used by the shared session actions.
 *
 * Callers that already hold a server mutation context (bulk selection, settings screens) call
 * `setSessionAttentionStanding` directly; a menu item only knows the session and its server, so this
 * resolves the credentials for it and still writes through that one path.
 */
export async function sessionSetAttentionStandingWithServerScope(
    sessionId: string,
    standing: boolean,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionSetAttentionStandingResult> {
    const requestedServerId = typeof opts?.serverId === 'string' ? opts.serverId.trim() : '';
    const serverId = requestedServerId || resolvePreferredServerIdForSessionId(sessionId) || '';
    try {
        const resolved = await resolveSessionOrganizationMutationScope(serverId);
        if (!resolved.ok) {
            return { success: false, message: MISSING_SCOPE_MESSAGE_BY_REASON[resolved.reason] };
        }
        await setSessionAttentionStanding({
            credentials: resolved.scope.credentials,
            serverId: resolved.scope.serverId,
            serverUrl: resolved.scope.serverUrl,
            sessionId,
            standing,
        });
        return { success: true };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}
