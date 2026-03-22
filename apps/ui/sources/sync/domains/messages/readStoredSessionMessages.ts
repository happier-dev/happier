import type { Message } from './messageTypes';

type SessionMessagesStateLike = Readonly<{
    messages?: ReadonlyArray<Message>;
    messageIdsOldestFirst?: ReadonlyArray<string>;
    messagesById?: Readonly<Record<string, Message>>;
    messagesMap?: Readonly<Record<string, Message>>;
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

export function readStoredSessionMessages(
    state: Readonly<{ sessionMessages?: Record<string, SessionMessagesStateLike> }> | null | undefined,
    sessionId: string,
): Message[] {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return [];
    return readStoredSessionMessagesFromStateLike(state?.sessionMessages?.[normalizedSessionId]);
}
