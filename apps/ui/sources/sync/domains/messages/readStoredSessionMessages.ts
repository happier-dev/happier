import type { Message } from './messageTypes';
import type { TranscriptRenderableAggregate } from './transcriptRenderableAggregate';
import {
    resolveLatestUnreadAffectingCommittedMessageSeq,
    type ResolveSessionReadableSeqInput,
} from '@/sync/domains/session/readCursor/resolveSessionReadableSeq';

type SessionMessagesStateLike = Readonly<{
    messages?: ReadonlyArray<Message>;
    messageIdsOldestFirst?: ReadonlyArray<string>;
    messagesById?: Readonly<Record<string, Message>>;
    messagesMap?: Readonly<Record<string, Message>>;
    renderableAggregate?: Pick<TranscriptRenderableAggregate, 'messageCount' | 'latestUnreadAffectingMessageSeq'>;
}>;

function readMessagesFromRecord(
    value: Readonly<Record<string, Message>> | null | undefined,
    ids: ReadonlyArray<string>,
): Message[] {
    return ids
        .map((id) => value?.[id])
        .filter((message): message is Message => Boolean(message));
}

export function readStoredSessionMessagesFromStateLike(sessionMessages: SessionMessagesStateLike | null | undefined): Message[] {
    if (!sessionMessages || typeof sessionMessages !== 'object') return [];

    if (Array.isArray(sessionMessages.messages)) {
        return [...sessionMessages.messages];
    }

    const ids = Array.isArray(sessionMessages.messageIdsOldestFirst)
        ? sessionMessages.messageIdsOldestFirst
        : [];
    const messagesById = sessionMessages.messagesById ?? sessionMessages.messagesMap;
    return readMessagesFromRecord(messagesById, ids);
}

export function readStoredSessionMessagesReadProjectionFromStateLike(
    sessionMessages: SessionMessagesStateLike | null | undefined,
): NonNullable<ResolveSessionReadableSeqInput['messagesProjection']> {
    const aggregate = sessionMessages?.renderableAggregate;
    if (aggregate) {
        // The store maintains or invalidates this aggregate with each message change.
        // Copy its primitives: the aggregate itself is mutated in place.
        return {
            hasMessages: aggregate.messageCount > 0,
            latestUnreadAffectingMessageSeq: aggregate.latestUnreadAffectingMessageSeq,
        };
    }

    const messages = readStoredSessionMessagesFromStateLike(sessionMessages);
    return {
        hasMessages: messages.length > 0,
        latestUnreadAffectingMessageSeq: resolveLatestUnreadAffectingCommittedMessageSeq(messages),
    };
}

export function readStoredSessionMessages(
    state: Readonly<{ sessionMessages?: Record<string, SessionMessagesStateLike> }> | null | undefined,
    sessionId: string,
): Message[] {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return [];
    return readStoredSessionMessagesFromStateLike(state?.sessionMessages?.[normalizedSessionId]);
}
