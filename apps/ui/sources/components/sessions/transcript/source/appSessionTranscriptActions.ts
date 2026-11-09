import { sync } from '@/sync/sync';
import { serverFetch } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { HappyError } from '@/utils/errors/errors';
import { projectServerScopedSessionSendMessageResult } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { submitSessionUserMessage } from '@/sync/domains/session/input/submitSessionUserMessage';
import type { SessionSubmitPort, SubmitSessionUserMessageOptions, SubmitSessionUserMessageResult } from '@/sync/domains/session/input/types';

import type { SessionRequestReadOutcome, SessionTranscriptActions } from './types';

function requireSendSuccess(result: ActionExecuteResult) {
    requireActionSuccess(result);
    if (!result.ok) throw new Error('Unreachable Action refusal');
    const sent = SessionMessageSendResultV1Schema.parse(result.result);
    if (sent.status === 'rejected' || sent.status === 'failed' || sent.status === 'cancelled') {
        throw new HappyError(sent.code, false, { code: sent.code, details: sent });
    }
    return sent;
}

/** Composer and option-chip Send share Action admission; the incumbent submit owner keeps delivery and draft custody. */
export async function submitAppSessionComposerMessage(port: SessionSubmitPort, options: SubmitSessionUserMessageOptions): Promise<SubmitSessionUserMessageResult> {
    let submitted: SubmitSessionUserMessageResult | undefined;
    const execute = createFrontDoorActionExecute(undefined, {
        sessionSendMessage: async ({ permissionModeOverride, context }) => {
            submitted = await submitSessionUserMessage(port, { ...options, actionContext: context,
                metaOverrides: permissionModeOverride
                    ? { ...options.metaOverrides, permissionMode: permissionModeOverride }
                    : options.metaOverrides,
            });
            if (submitted.type === 'send_failed' || submitted.type === 'wake_failed' || submitted.type === 'rejected') {
                throw new HappyError(submitted.errorMessage ?? submitted.type, false, { code: submitted.errorCode ?? submitted.type });
            }
            return projectServerScopedSessionSendMessageResult({ ok: true, ack: {
                localId: submitted.localId,
                accepted: submitted.type === 'success' && submitted.providerAcceptancePending !== true,
            } });
        },
    });
    const execution = await execute('session.message.send', {
        sessionId: options.sessionId, message: options.text,
        ...(options.metaOverrides?.happierStructuredInputV1 !== undefined ? { structuredInput: options.metaOverrides.happierStructuredInputV1 } : {}),
        ...(typeof options.metaOverrides?.permissionMode === 'string' ? { permissionModeOverride: options.metaOverrides.permissionMode } : {}),
        ...(options.localId ? { localId: options.localId } : {}),
        ...(options.recipient ? { recipient: options.recipient } : {}),
        ...(options.requestedAction ? { requestedAction: options.requestedAction } : {}),
    }, { surface: 'ui', defaultSessionId: options.sessionId, ...(options.serverId ? { serverId: options.serverId } : {}) });
    // An admitted local effect retains the submit owner's failure/custody result.
    // Admission refusals still throw below because no local effect ran.
    if (submitted && (submitted.type === 'send_failed' || submitted.type === 'wake_failed' || submitted.type === 'rejected')) return submitted;
    const sent = requireSendSuccess(execution);
    if (submitted) return submitted;
    // API-token clients receive the canonical remote receipt; their callback
    // clears the exact captured draft just as the local submit owner does.
    if (sent.status === 'outcomeUnknown') return { type: 'rejected', persistence: 'none', errorCode: sent.code,
        errorMessage: sent.code, wake: { attempted: false, state: 'not_needed' } };
    options.onOutboundHandoff?.({ persistence: 'pending', localId: sent.localId });
    return { type: 'success', persistence: 'pending', localId: sent.localId,
        wake: { attempted: false, state: 'not_needed' } };
}

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
                ...(params.decision === 'reject'
                    ? { decision: 'reject' as const }
                    : { answers: Object.entries(params.answers).map(([question, values]) => ({ question, values: [...values] })) }),
            }, context));
        },
        abort: async () => { requireActionSuccess(await execute('session.turn.cancel', { sessionId }, context)); },
        readRequestOutcome: (requestId) => readSessionRequestOutcome(sessionId, serverId, requestId),
        submitMessage: async (text, options) => {
            // Keep the app submit owner's message-mode, wake and option-chip
            // origin semantics. Its effect runs only after Action admission.
            const submit = createFrontDoorActionExecute(undefined, {
                sessionSendMessage: async ({ sessionId: targetId, message, serverId: targetServerId, permissionModeOverride, context: actionContext }) => {
                    const result = await sync.submitMessage(targetId, message, undefined,
                        permissionModeOverride ? { permissionMode: permissionModeOverride } : undefined,
                        { ...options, actionContext, ...(targetServerId ? { serverId: targetServerId } : {}) });
                    return projectServerScopedSessionSendMessageResult({ ok: true, ack: {
                        localId: result.localId,
                        accepted: result.type === 'success' && result.providerAcceptancePending !== true,
                    } });
                },
            });
            requireSendSuccess(await submit('session.message.send', { sessionId, message: text,
                ...(options?.permissionModeOverride ? { permissionModeOverride: options.permissionModeOverride } : {}),
            }, context));
        },
    } satisfies SessionTranscriptActions);
}
