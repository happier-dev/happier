import { z } from 'zod/mini';
import { StructuredQuestionAnswerDetailsV1Schema, StructuredQuestionAnswersV1Schema } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';
import { SessionQuestionContextV1Schema, SessionQuestionHandlerV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';
import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { deliverSessionMessageReply } from '@/session/services/sessionMessageReply';
import type { AgentStateRequestStore } from './agentStateRequestStore';
import { isAgentStructuredQuestionRequest } from './requestKind';
import type { ActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';

const QuestionResponseTarget = z.strictObject({
    kind: z.literal('session_question_answer'),
    sessionId: z.string().check(z.minLength(1)),
    sourceTurnId: z.optional(z.string().check(z.minLength(1))),
    sourceInputId: z.optional(z.string().check(z.minLength(1))),
});

/** Adapt the existing durable response target to S3's sole returned-information owner. */
export function registerSessionQuestionAnswerDelivery(input: Readonly<{
    store: Pick<AgentStateRequestStore, 'registerResponseTargetHandler'>;
    sessionId: string;
    serverUrl: string;
    readCredentials: () => Promise<StoredCredentials | null>;
    /** Resolve only this question's admitted turn, including after host recovery. */
    readAdmittedCause: (source: Readonly<{ sourceTurnId?: string; sourceInputId?: string }>) => Promise<ActionRequestAttributionV1 | undefined>;
    machineAdmissionTransport?: Parameters<typeof deliverSessionMessageReply>[0]['machineAdmissionTransport'];
    signal: AbortSignal;
}>): () => void {
    return input.store.registerResponseTargetHandler('session_question_answer', async dispatch => {
        const target = QuestionResponseTarget.safeParse(dispatch.responseTarget);
        if (!target.success || target.data.sessionId !== input.sessionId) return false;
        const row = dispatch.completedRequest;
        if (!isAgentStructuredQuestionRequest({ toolName: typeof row.tool === 'string' ? row.tool : '',
            ...(typeof row.kind === 'string' ? { kind: row.kind } : {}),
            ...(typeof row.source === 'string' ? { source: row.source } : {}) })) return false;
        // Explicit withdrawal is terminal, not another message to the asker.
        if (row.status === 'canceled' || row.status === 'denied') return true;
        if (row.status !== 'approved' || input.signal.aborted) return false;
        const question = SessionQuestionContextV1Schema.safeParse(row.questionV1 ?? { mode: 'wait', lasting: false });
        const answers = StructuredQuestionAnswersV1Schema.safeParse(row.structuredAnswersV1 ?? row.answers);
        const answerDetails = row.answerDetails === undefined ? undefined : StructuredQuestionAnswerDetailsV1Schema.safeParse(row.answerDetails);
        const actor = row.answeredBy === undefined ? undefined : SessionQuestionHandlerV1Schema.safeParse(row.answeredBy);
        if (!question.success || !answers.success || (answerDetails && !answerDetails.success) || (actor && !actor.success)) return false;
        const credentials = await input.readCredentials();
        if (!credentials || input.signal.aborted) return false;
        const result = await runWithServerHttpBaseUrl(input.serverUrl, async () => {
            const actionRequestAttributionV1 = target.data.sourceTurnId || target.data.sourceInputId
                ? await input.readAdmittedCause(target.data) : undefined;
            if (input.signal.aborted) return { ok: false } as const;
            return deliverSessionMessageReply({
                credentials, sessionId: input.sessionId, requestSessionId: input.sessionId,
                requestLocalId: dispatch.requestId, mode: question.data.mode, outcome: 'answer',
                ...(actionRequestAttributionV1 ? { actionRequestAttributionV1 } : {}),
                message: JSON.stringify({ requestId: dispatch.requestId, question: row.arguments,
                    context: question.data, answers: answers.data,
                    ...(answerDetails?.success ? { answerDetails: answerDetails.data } : {}) }),
                ...(actor?.success && actor.data.kind === 'session' ? {
                    senderSessionId: actor.data.sessionId,
                    answeredBy: { v: 1 as const, kind: 'happierSession' as const,
                        sourceSessionId: actor.data.sessionId, via: 'action' as const },
                } : actor?.success && actor.data.kind === 'person' && actor.data.accountId ? {
                    answeredBy: { v: 1 as const, kind: 'happierApp' as const,
                        actor: { kind: 'person' as const, accountId: actor.data.accountId } },
                } : {}),
                ...(input.machineAdmissionTransport ? { machineAdmissionTransport: input.machineAdmissionTransport } : {}),
                signal: input.signal,
            });
        });
        return result.ok && !('suppressed' in result && result.suppressed === true);
    });
}
