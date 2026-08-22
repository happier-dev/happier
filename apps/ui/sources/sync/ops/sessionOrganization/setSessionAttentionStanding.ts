import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionAttentionStanding as setSessionAttentionStandingApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

import { resolveSessionOrganizationMutationScope } from './sessionOrganizationMutationOwner';

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

export type SessionSetAttentionStandingResult = Readonly<{
    success: boolean;
    message?: string;
}>;

/**
 * The single-session entrypoint used by the shared session actions.
 *
 * Callers that already hold an organization mutation scope (bulk selection, settings screens) call
 * `setSessionAttentionStanding` directly; a menu item only knows the session and maybe its server,
 * so this resolves the scope through the one owner of organization credentials and still writes
 * through that same path.
 */
export async function sessionSetAttentionStandingWithServerScope(
    sessionId: string,
    standing: boolean,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionSetAttentionStandingResult> {
    const requestedServerId = typeof opts?.serverId === 'string' ? opts.serverId.trim() : '';
    const scopeResult = await resolveSessionOrganizationMutationScope(
        requestedServerId || resolvePreferredServerIdForSessionId(sessionId) || '',
    );
    if (!scopeResult.ok) {
        return { success: false, message: `Cannot set session attention standing: ${scopeResult.reason}` };
    }
    try {
        await setSessionAttentionStanding({
            ...scopeResult.scope,
            sessionId,
            standing,
        });
        return { success: true };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}
