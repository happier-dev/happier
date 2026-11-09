import type { SetSessionAttentionStandingResponse } from '@happier-dev/protocol/sessions/organization/standings';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionAttentionStanding as setSessionAttentionStandingApi } from '@/sync/api/session/sessionOrganizationApi';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storageStore';
import { sessionOrganizationStoreFor } from './sessionOrganizationAccountStore';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

import { resolveSessionOrganizationMutationScope } from './sessionOrganizationMutationOwner';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';

const executeAttentionAction = createFrontDoorActionExecute();

export async function setSessionAttentionStanding(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    sessionId: string;
    standing?: boolean | null;
    remindAt?: number | null;
}>): Promise<SetSessionAttentionStandingResponse> {
    params.assertCurrent?.();
    const previousStanding = sessionOrganizationStoreFor(params).sessionOrganizationAttentionStandingsBySessionKey[
        buildSessionOrganizationSessionKey(params.serverId, params.sessionId)
    ];
    const optimisticStanding = params.standing === null
        ? null
        : params.standing !== undefined
            ? { sessionId: params.sessionId, standing: params.standing, updatedAt: Date.now() }
            : typeof params.remindAt === 'number'
                ? { sessionId: params.sessionId, standing: previousStanding?.standing ?? false, remindAt: params.remindAt, updatedAt: Date.now() }
                : previousStanding == null
                    ? null
                    : { sessionId: params.sessionId, standing: previousStanding.standing, updatedAt: Date.now() };
    const recordId = sessionOrganizationStoreFor(params).setSessionAttentionStandingOptimistic(params.serverId, params.sessionId, optimisticStanding);
    try {
        const response = await setSessionAttentionStandingApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            sessionId: params.sessionId,
            request: params.standing !== undefined ? { standing: params.standing } : { remindAt: params.remindAt ?? null },
        });
        params.assertCurrent?.();
        // Confirm this write's own key through the optimistic-record owner: a second blind
        // optimistic write would republish this response over a newer reminder change that is
        // still in flight for the same Session.
        sessionOrganizationStoreFor(params).confirmSessionOrganizationOptimistic(
            recordId,
            'sessionOrganizationAttentionStandingsBySessionKey',
            buildSessionOrganizationSessionKey(params.serverId, params.sessionId),
            response.standing,
        );
        return response;
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}

async function sessionSetAttentionIntentWithServerScope(
    sessionId: string,
    intent: Readonly<{ standing?: boolean | null; remindAt?: number | null }>,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionSetAttentionStandingResult> {
    const requestedServerId = typeof opts?.serverId === 'string' ? opts.serverId.trim() : '';
    const serverId = requestedServerId || resolvePreferredServerIdForSessionId(sessionId) || '';
    try {
        const result = await executeAttentionAction('session.attention.set', { sessionId, ...intent }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId,
        });
        requireActionSuccess(result);
        return { success: true };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error',
            ...(error instanceof HappyError ? { code: error.code, details: error.details } : {}) };
    }
}

export async function sessionSetAttentionReminderWithServerScope(sessionId: string, remindAt: number, opts?: Readonly<{ serverId?: string | null }>): Promise<SessionSetAttentionStandingResult> {
    return sessionSetAttentionIntentWithServerScope(sessionId, { remindAt }, opts);
}

export async function sessionClearAttentionReminderWithServerScope(sessionId: string, opts?: Readonly<{ serverId?: string | null }>): Promise<SessionSetAttentionStandingResult> {
    return sessionSetAttentionIntentWithServerScope(sessionId, { remindAt: null }, opts);
}

export type SessionSetAttentionStandingResult = Readonly<{
    success: boolean;
    message?: string;
    code?: string;
    details?: unknown;
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
    return sessionSetAttentionIntentWithServerScope(sessionId, { standing }, opts);
}

/**
 * The UI host port for `session.attention.set` (ORC R-10): the same optimistic writer the session
 * menus use, resolved to the exact Home, returning the route's `{ standing }` payload so the
 * Action executor projects it. A missing scope is the Action's `unavailable`, never a local write.
 */
export async function executeSessionAttentionSetAction(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    request: Readonly<{ standing?: boolean | null; remindAt?: number | null }>;
}>): Promise<SetSessionAttentionStandingResponse | Readonly<{ ok: false; errorCode: string; error: string }>> {
    const requestedServerId = typeof params.serverId === 'string' ? params.serverId.trim() : '';
    const serverId = requestedServerId || resolvePreferredServerIdForSessionId(params.sessionId) || '';
    const resolved = await resolveSessionOrganizationMutationScope(serverId);
    if (!resolved.ok) return { ok: false, errorCode: 'unavailable', error: 'unavailable' };
    return await setSessionAttentionStanding({ ...resolved.scope, sessionId: params.sessionId, ...params.request });
}
