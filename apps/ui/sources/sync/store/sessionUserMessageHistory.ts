import { readMessageDisplayText, type Message } from '@happier-dev/session-core/messages';
import type { OrderedTranscript } from '@happier-dev/session-core/transcript';
import type { SessionMessageChange } from './sessionMessageChanges';

/** Decrypted history facts only; retired with the owning transcript, never persisted. */
export type UserMessageHistoryFact = Readonly<{
    kind: 'user-text';
    id: string;
    realID: string | null;
    seq: number | undefined;
    transcriptBlockIndex: number | undefined;
    createdAt: number;
    text: string;
}>;
export type SessionUserMessageHistory = Readonly<Record<string, Readonly<Record<string, UserMessageHistoryFact>>>>;
export const EMPTY_SESSION_USER_MESSAGE_HISTORY: SessionUserMessageHistory = Object.freeze({});
export const EMPTY_USER_MESSAGE_HISTORY: Readonly<Record<string, UserMessageHistoryFact>> = Object.freeze({});

function projectHistoryFact(message: Extract<Message, { kind: 'user-text' }>, previous?: UserMessageHistoryFact): UserMessageHistoryFact {
    const text = readMessageDisplayText(message);
    const realID = message.realID ?? null;
    if (previous && previous.text === text && previous.realID === realID && previous.seq === message.seq
        && previous.transcriptBlockIndex === message.transcriptBlockIndex && previous.createdAt === message.createdAt) return previous;
    return { kind: 'user-text', id: message.id, realID, seq: message.seq,
        transcriptBlockIndex: message.transcriptBlockIndex, createdAt: message.createdAt, text };
}

/** Changed-row publication; only first admission/replacement reads the full transcript. */
export function applySessionUserMessageHistory(
    previous: SessionUserMessageHistory | undefined,
    sessionId: string,
    transcript: OrderedTranscript,
    changes: readonly SessionMessageChange[] | null,
): SessionUserMessageHistory {
    const history = previous ?? EMPTY_SESSION_USER_MESSAGE_HISTORY;
    const before = history[sessionId];
    const rebuild = before === undefined || changes === null;
    let rows: Record<string, UserMessageHistoryFact> = rebuild ? {} : before!;
    const messages = rebuild
        ? transcript.messageIdsOldestFirst.map(id => transcript.messagesById[id]).filter((message): message is Message => Boolean(message))
        : changes.map(change => change.next);
    for (const message of messages) {
        if (message.kind === 'user-text') {
            const fact = projectHistoryFact(message, before?.[message.id]);
            if (rows[message.id] === fact) continue;
            if (rows === before) rows = { ...before };
            rows[message.id] = fact;
        } else if (rows[message.id]) {
            if (rows === before) rows = { ...before };
            delete rows[message.id];
        }
    }
    if (rows === before) return history;
    // Empty admission remembers that this transcript was indexed without becoming a user fact.
    if (Object.keys(rows).length === 0) rows = EMPTY_USER_MESSAGE_HISTORY;
    if (rows === before || (rebuild && before && Object.keys(rows).length === Object.keys(before).length
        && Object.keys(rows).every(id => rows[id] === before[id]))) return history;
    return { ...history, [sessionId]: rows };
}

export function removeSessionUserMessageHistory(previous: SessionUserMessageHistory | undefined, sessionId: string): SessionUserMessageHistory {
    const history = previous ?? EMPTY_SESSION_USER_MESSAGE_HISTORY;
    if (!(sessionId in history)) return history;
    const { [sessionId]: _removed, ...remaining } = history;
    return remaining;
}
