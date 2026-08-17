import type { Message } from './messageTypes';

export type SessionMessagesStateLike<TMessage = Message> = Readonly<{
    messages?: ReadonlyArray<TMessage>;
    messageIdsOldestFirst?: ReadonlyArray<string>;
    messagesById?: Readonly<Record<string, TMessage>>;
    messagesMap?: Readonly<Record<string, TMessage>>;
}>;

type StoredMessageFromStateLike<TState, TFallback = Message> =
    TState extends Readonly<{ messagesById?: Readonly<Record<string, infer TMessage>> }>
        ? TMessage
        : TState extends Readonly<{ messagesMap?: Readonly<Record<string, infer TMessage>> }>
            ? TMessage
            : TState extends Readonly<{ messages?: ReadonlyArray<infer TMessage> }>
                ? TMessage
                : TFallback;

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
    return value !== null && typeof value === 'object';
}

function readMessagesFromRecord(
    value: unknown,
    ids: ReadonlyArray<PropertyKey>,
): unknown[] {
    const record = isRecord(value) ? value : null;
    return ids
        .map((id) => record?.[id])
        .filter(Boolean);
}

export function readStoredSessionMessagesFromStateLike<TState, TFallback = Message>(
    sessionMessages: TState | null | undefined,
): StoredMessageFromStateLike<TState, TFallback>[];
export function readStoredSessionMessagesFromStateLike(sessionMessages: unknown): unknown[] {
    return readStoredSessionMessagesFromUnknown(sessionMessages);
}

function readStoredSessionMessagesFromUnknown(sessionMessages: unknown): unknown[] {
    if (!isRecord(sessionMessages)) return [];

    if (Array.isArray(sessionMessages.messages)) {
        return [...sessionMessages.messages];
    }

    const ids = Array.isArray(sessionMessages.messageIdsOldestFirst)
        ? sessionMessages.messageIdsOldestFirst
        : [];
    const messagesById = sessionMessages.messagesById ?? sessionMessages.messagesMap;
    return readMessagesFromRecord(messagesById, ids);
}

export function readStoredSessionMessages<TState, TFallback = Message>(
    state: Readonly<{
        sessionMessages?: Record<string, TState>;
    }> | null | undefined,
    sessionId: string,
): StoredMessageFromStateLike<TState, TFallback>[];
export function readStoredSessionMessages(
    state: Readonly<{
        sessionMessages?: Record<string, unknown>;
    }> | null | undefined,
    sessionId: string,
): unknown[] {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return [];
    return readStoredSessionMessagesFromUnknown(state?.sessionMessages?.[normalizedSessionId]);
}
