import { sync } from '@/sync/sync';
import { serverFetch } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { buildSessionUserActionAnswerItems } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

import type { SessionRequestReadOutcome, SessionTranscriptActions } from './types';

export { submitUiSessionMessage as submitAppSessionComposerMessage } from '@/sync/ops/actions/submitSessionMessage';

/**
 * One exact read of the Session on the Home these Actions answer on: the request is still waiting when the
 * Session lists it, settled when the Session lists it as completed. Anything else cannot be told, so it rejects.
 * The read is bound to the Home and Account authority captured when it started: if that Account is no longer
 * current when the response arrives, the read rejects rather than speaking for a retired Account. A settled
 * answer is only returned once the fresh Session is published through the sync owner, so the card that showed
 * the request as waiting leaves that state.
 */
async function readSessionRequestOutcome(sessionId: string, serverId: string | null, requestId: string): Promise<SessionRequestReadOutcome> {
    const homeId = serverId ?? getActiveServerSnapshot().serverId;
    return await runWithServerRequestAuthorityForServerAccountScope(
        { serverId: homeId, activeRequest: serverFetch },
        (authority) => runWithServerAccountScopeRequestGuard(
            { scope: authority.scope, staleError: () => new Error('The Account changed while the request was being checked') },
            async (guard) => {
                guard.check();
                const { session } = await readSessionSnapshotForAuthority({ authority, sessionId, isCurrent: guard.isCurrent });
                guard.check();
                if (session.agentState?.requests?.[requestId]) return 'pending';
                if (!session.agentState?.completedRequests?.[requestId]) {
                    throw new Error('The Session does not say whether the request is still waiting');
                }
                const published = await sync.ensureSessionVisibleForMessageRoute(sessionId, {
                    serverId: authority.scope.serverId, forceRefresh: true, hydrateMessages: false,
                    authority, scopeCurrentness: guard.isCurrent,
                });
                guard.check();
                if (published.kind !== 'available') throw new Error('The settled Session could not be published');
                return 'settled';
            },
        ),
    );
}

/** The app's Session actions, shared by transcript, Companion and linked plugin approvals. */
export function createAppSessionTranscriptActions(sessionId: string, serverId: string | null): SessionTranscriptActions {
    const execute = createFrontDoorActionExecute();
    const context = { surface: 'ui' as const, defaultSessionId: sessionId, ...(serverId ? { serverId } : {}) };
    return Object.freeze({
        respondToPermission: async (params) => {
            const { id, approved, decision, ...fields } = params;
            requireActionSuccess(await execute('session.permission.respond', {
                ...fields, sessionId, requestId: id, decision: decision ?? (approved ? 'allow' : 'deny'),
            }, context));
        },
        answerUserAction: async (params) => {
            requireActionSuccess(await execute('session.user_action.answer', { sessionId, requestId: params.id,
                ...(params.turnId ? { turnId: params.turnId } : {}),
                ...(params.decision === 'reject'
                    ? { decision: 'reject' as const }
                    : { answers: buildSessionUserActionAnswerItems(params.answers, params.answerDetails) }),
            }, context));
        },
        abort: async () => { requireActionSuccess(await execute('session.turn.cancel', { sessionId }, context)); },
        readRequestOutcome: (requestId) => readSessionRequestOutcome(sessionId, serverId, requestId),
        submitMessage: async (text, options) => {
            await sync.submitMessage(sessionId, text, undefined,
                options?.permissionModeOverride ? { permissionMode: options.permissionModeOverride } : undefined,
                { ...options, ...(serverId ? { serverId } : {}) });
        },
    } satisfies SessionTranscriptActions);
}
