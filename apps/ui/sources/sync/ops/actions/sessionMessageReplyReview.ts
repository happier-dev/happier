import { SessionMessageReplyMutationResultV1Schema, type SessionMessageReplyAccountMutationV1,
    type SessionMessageReplyMutationResultV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { readSessionMessageReply } from '@/sync/api/session/sessionMessageReplyApi';
import type { LazyActionAccountContext } from './actionAccountContext';

/** A declined original is authoritative even when its mutation acknowledgement was lost. */
export async function executeSessionMessageReplyReview(account: LazyActionAccountContext, params: Readonly<{
    sessionId: string;
    requestLocalId: string;
    reviewDecision: Extract<SessionMessageReplyAccountMutationV1, { kind: 'discussion_review' | 'discussion_publication' }>;
    signal?: AbortSignal;
}>): Promise<SessionMessageReplyMutationResultV1 | ActionExecuteFailure> {
    const { sessionId, requestLocalId, reviewDecision, signal } = params;
    let failure: ActionExecuteFailure;
    try {
        const response = await account.request(`/v2/sessions/${encodeURIComponent(sessionId)}/messages/by-local-id/${encodeURIComponent(requestLocalId)}/reply`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewDecision), ...(signal ? { signal } : {}) });
        account.assertCurrent();
        const payload: unknown = await response.json();
        const parsed = SessionMessageReplyMutationResultV1Schema.safeParse(payload);
        account.assertCurrent();
        if (response.ok) return parsed.success ? parsed.data
            : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        const error = parsed.success && !parsed.data.ok ? parsed.data.error : 'unavailable';
        const refusal = readActionFailureEnvelope(payload) ?? { ok: false as const, errorCode: error, error };
        const code = payload && typeof payload === 'object'
            ? 'code' in payload ? payload.code : 'error' in payload ? payload.error : error : error;
        failure = { ...refusal, failureCause: refusal.failureCause ?? projectActionFailureCauseV1({
            name: 'HttpStatusError', code, status: response.status,
        }, 'session.message.reply') };
    } catch (error) {
        account.assertCurrent();
        if (signal?.aborted) throw error;
        failure = { ok: false, errorCode: 'unavailable', error: 'unavailable',
            failureCause: projectActionFailureCauseV1(error, 'session.message.reply') };
    }
    if (reviewDecision.kind === 'discussion_review') {
        const observed = await readSessionMessageReply({ scope: account.accountLifetime.scope, sessionId, localId: requestLocalId,
            isCurrent: account.accountLifetime.isCurrent, signal });
        account.assertCurrent();
        // The protocol decision owner validates the exact original tuple.
        if (observed.status === 'available' && observed.progress.disposition === 'released' && observed.progress.outcome?.kind === 'declined') {
            return { v: 1, ok: true, progress: observed.progress };
        }
    }
    return failure;
}
