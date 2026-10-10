import { sync } from '@/sync/sync';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { HappyError } from '@/utils/errors/errors';
import { projectServerScopedSessionSendMessageResult } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import type { SessionTranscriptActions } from './types';

/** The app's Session actions, shared by transcript, Companion and linked plugin approvals. */
export function createAppSessionTranscriptActions(sessionId: string, serverId: string | null): SessionTranscriptActions {
    const execute = createFrontDoorActionExecute();
    const context = { surface: 'ui' as const, defaultSessionId: sessionId, ...(serverId ? { serverId } : {}) };
    const requireSuccess = (result: ActionExecuteResult): void => {
        if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode, details: result.details });
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (approval.success) throw new HappyError(approval.data.kind, false, { code: approval.data.kind, details: approval.data });
    };
    return Object.freeze({
        respondToPermission: async (params) => {
            const { id, approved, decision, ...fields } = params;
            requireSuccess(await execute('session.permission.respond', {
                ...fields, sessionId, requestId: id, decision: decision ?? (approved ? 'allow' : 'deny'),
            }, context));
        },
        answerUserAction: async (params) => {
            requireSuccess(await execute('session.user_action.answer', { sessionId, requestId: params.id,
                answers: Object.entries(params.answers).map(([question, values]) => ({ question, values: [...values] })),
            }, context));
        },
        abort: async () => { requireSuccess(await execute('session.turn.cancel', { sessionId }, context)); },
        submitMessage: async (text, options) => {
            // Keep the app submit owner's message-mode, wake and option-chip
            // origin semantics. Its effect runs only after Action admission.
            const submit = createFrontDoorActionExecute(undefined, {
                sessionSendMessage: async ({ sessionId: targetId, message, serverId: targetServerId }) => {
                    const result = await sync.submitMessage(targetId, message, undefined, undefined,
                        { ...options, ...(targetServerId ? { serverId: targetServerId } : {}) });
                    return projectServerScopedSessionSendMessageResult({ ok: true, ack: {
                        localId: result.localId,
                        accepted: result.type === 'success' && result.providerAcceptancePending !== true,
                    } });
                },
            });
            const result = await submit('session.message.send', { sessionId, message: text }, context);
            requireSuccess(result);
            if (result.ok) {
                const sent = SessionMessageSendResultV1Schema.parse(result.result);
                if (sent.status === 'rejected' || sent.status === 'failed' || sent.status === 'cancelled') {
                    throw new HappyError(sent.code, false, { code: sent.code, details: sent });
                }
            }
        },
    } satisfies SessionTranscriptActions);
}
