import type { Message } from '@happier-dev/session-core/messages';
import type { SessionInputReturnedAnswerV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { sessionMessageReplyKey } from '@/sync/api/session/sessionMessageReplyApi';
import { readReturnedAnswer } from '@/sync/domains/session/input/returnedAnswer';
import { areSessionValuesDeepEqual } from './domains/areStoredSessionsEqual';
import type { SessionMessageChange } from './sessionMessageChanges';

export type ReturnedAnswerEntry = Readonly<{
    messageId: string;
    answer: SessionInputReturnedAnswerV1;
    /** One readable line for an answer; passes and unavailable text have no snippet. */
    snippet: string;
}>;
export type SessionReturnedAnswersByRequest = Readonly<Record<string, readonly ReturnedAnswerEntry[]>>;
export const EMPTY_SESSION_RETURNED_ANSWERS: SessionReturnedAnswersByRequest = Object.freeze({});

function projectReturnedAnswer(message: Message): ReturnedAnswerEntry | null {
    const answer = readReturnedAnswer(message);
    if (!answer) return null;
    const snippet = answer.outcome === 'answer' && message.kind === 'user-text'
        ? (message.displayText ?? message.text).replace(/[`*_>#]/g, '').replace(/\s+/g, ' ').trim()
        : '';
    return { messageId: message.id, answer, snippet };
}

function entryKey(entry: ReturnedAnswerEntry): string {
    return sessionMessageReplyKey({ sessionId: entry.answer.requestSessionId, localId: entry.answer.requestLocalId });
}

/**
 * Owned by the transcript commit: ordinary arrivals examine changed rows only. Missing projections
 * on retained transcripts are admitted once; replacement/reset/eviction use the transcript's lifetime.
 * These are derived presentation facts, never a reply-status authority or persisted copy.
 */
export function applySessionReturnedAnswerChanges(input: Readonly<{
    previous: SessionReturnedAnswersByRequest | undefined;
    messages: Readonly<Record<string, Message>>;
    changes: readonly SessionMessageChange[];
}>): SessionReturnedAnswersByRequest {
    const changes = input.previous === undefined
        ? Object.values(input.messages).map(next => ({ previous: null, next }))
        : input.changes;
    let projected = input.previous ?? EMPTY_SESSION_RETURNED_ANSWERS;
    for (const change of changes) {
        const next = projectReturnedAnswer(change.next);
        const beforeAnswer = change.previous ? readReturnedAnswer(change.previous) : null;
        const beforeKey = beforeAnswer ? sessionMessageReplyKey({ sessionId: beforeAnswer.requestSessionId, localId: beforeAnswer.requestLocalId }) : null;
        const nextKey = next ? entryKey(next) : null;
        if (beforeKey && beforeKey !== nextKey && projected[beforeKey]) {
            const remaining = projected[beforeKey].filter(entry => entry.messageId !== change.next.id);
            if (remaining.length !== projected[beforeKey].length) {
                const updated = { ...projected };
                if (remaining.length) updated[beforeKey] = remaining;
                else delete updated[beforeKey];
                projected = updated;
            }
        }
        if (!next || !nextKey) continue;
        const entries = projected[nextKey] ?? [];
        const index = entries.findIndex(entry => entry.messageId === next.messageId);
        const previous = entries[index];
        if (previous && previous.snippet === next.snippet && areSessionValuesDeepEqual(previous.answer, next.answer)) continue;
        const updated = [...entries];
        if (index < 0) updated.push(next);
        else updated[index] = next;
        projected = { ...projected, [nextKey]: updated };
    }
    return projected;
}
