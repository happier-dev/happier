import type { Message } from '@happier-dev/session-core/messages';
import { readSessionMessageInvocationV1, projectSessionMessageInvocationV1, type SessionMessageInvocationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';
import { SessionTargetV1Schema, withSessionTargetFanoutResultV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ActionExecuteFailureSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isRecord, readHappierActionCallId, readHappierActionCallInput, readHappierActionToolResultCandidates } from './happierActionToolResult';

export type SessionMessageInvocationEntry = Readonly<{
    invocation: SessionMessageInvocationV1;
    text: string;
    origin: 'composer' | 'agent_tool';
}>;
const SendResultSchema = withSessionTargetFanoutResultV1(SessionMessageSendResultV1Schema);

/** Cheap presentation gate: only these rows mount the invocation read (never a history scan). */
export function isSessionMessageInvocationAnchor(message: Message): boolean {
    if (message.kind === 'agent-event') return message.event.type === 'message' && readSessionMessageInvocationV1(message.event) !== null;
    return message.kind === 'tool-call' && readHappierActionCallId(message.tool.name, message.tool.input) === 'session.message.send';
}

/**
 * An agent's Ask/Send tool call whose result is a recognized send is presented as its Ask record alone;
 * a call without a recognizable result keeps its generic tool row (so a pending or unreadable call is never hidden).
 */
export function presentsAsSessionAskRecord(message: Message, source: Readonly<{ serverId: string; sessionId: string }>): boolean {
    return message.kind === 'tool-call' && isSessionMessageInvocationAnchor(message) && readSessionMessageInvocation(message, source) !== null;
}

/** Both origins feed one read model. Tool results keep their existing exact transcript anchor. */
export function readSessionMessageInvocation(message: Message, source: Readonly<{ serverId: string; sessionId: string }>): SessionMessageInvocationEntry | null {
    if (message.kind === 'agent-event') {
        const invocation = readSessionMessageInvocationV1(message.event);
        return invocation && message.event.type === 'message' ? { invocation, text: message.event.message, origin: 'composer' } : null;
    }
    if (message.kind !== 'tool-call' || readHappierActionCallId(message.tool.name, message.tool.input) !== 'session.message.send') return null;
    const input = readHappierActionCallInput(message.tool.name, message.tool.input);
    if (!isRecord(input)) return null;
    const target = SessionTargetV1Schema.safeParse(input.sessionId ?? source.sessionId);
    if (!target.success) return null;
    for (const raw of readHappierActionToolResultCandidates(message.tool.result, message.tool.input)) {
        let result: ActionExecuteResult | null = null;
        if (isRecord(raw) && raw.ok === true && Object.hasOwn(raw, 'result')) {
            const sent = SendResultSchema.safeParse(raw.result);
            if (sent.success) result = { ok: true, result: sent.data };
        }
        else {
            const failed = ActionExecuteFailureSchema.safeParse(raw);
            if (failed.success) result = failed.data;
            else {
                const sent = SendResultSchema.safeParse(raw);
                if (sent.success) result = { ok: true, result: sent.data };
            }
        }
        if (!result) continue;
        try {
            const invocation = projectSessionMessageInvocationV1({ serverId: source.serverId, localId: message.id,
                ...(typeof input.localId === 'string' ? { requestLocalId: input.localId } : {}),
                target: target.data, reply: input.reply === 'wait' || input.wait === true ? 'wait' : input.reply === 'return' ? 'return' : 'none', result });
            if (!invocation.targets.length && !invocation.resolutionError) continue;
            return { invocation, text: typeof input.message === 'string' ? input.message : '', origin: 'agent_tool' };
        } catch {
            // Persisted provider input is untrusted: malformed shorthand or ids
            // cannot become a Session address or crash the surrounding transcript.
            return null;
        }
    }
    return null;
}
