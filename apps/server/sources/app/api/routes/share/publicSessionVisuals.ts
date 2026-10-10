import { createReducer, normalizeRawMessages, reducer } from '@happier-dev/session-core';
import { isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1, resolveTranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board';
import type { PublicSessionOpenedMessage } from './publicShareViewerClient';

/** The same transcript normalizer/reducer and exact acknowledgement parser as authenticated replay. */
export function readPublicSessionVisualMessages(messages: readonly PublicSessionOpenedMessage[]): ReadonlySet<string> {
    if (!messages.some(message => message.reference && message.loadVisual)) return new Set();
    const ordered = [...messages].sort((left, right) => left.seq - right.seq);
    const normalized = normalizeRawMessages(ordered.map(message => ({ id: message.id, localId: message.localId,
        seq: message.seq, createdAt: message.createdAt, raw: message.raw, messageRole: message.messageRole })));
    const completed = reducer(createReducer(), normalized, null).messages;
    const publishedById = new Map(ordered.map(message => [message.id, message]));
    const resultsByCallId = new Map<string, { messageId: string; result: unknown; isError: boolean }[]>();
    for (const message of normalized) {
        if (message.role !== 'agent') continue;
        for (const content of message.content) {
            if (content.type !== 'tool-result') continue;
            const ids = resultsByCallId.get(content.tool_use_id) ?? [];
            ids.push({ messageId: message.id, result: content.content, isError: content.is_error });
            resultsByCallId.set(content.tool_use_id, ids);
        }
    }
    const visible = new Set<string>();
    for (const message of completed) {
        if (message.kind !== 'tool-call' || message.tool.state !== 'completed') continue;
        for (const result of resultsByCallId.get(message.tool.id ?? '') ?? []) {
            if (result.isError) continue;
            const published = publishedById.get(result.messageId);
            if (!published?.reference || !published.loadVisual) continue;
            const reference = resolveTranscriptSessionBoardItemReferenceV1({ toolName: message.tool.name, state: message.tool.state,
                input: message.tool.input, result: result.result, address: published.reference.sourceAddress });
            if (reference && isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1({
                acknowledgedReference: reference, publishedReference: published.reference,
                publishedSessionId: published.publishedSessionId,
            })) visible.add(published.id);
        }
    }
    return visible;
}
