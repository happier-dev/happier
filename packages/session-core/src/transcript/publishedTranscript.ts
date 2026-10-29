import type { SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';

import type { Message } from '../messages/messageTypes.js';
import type { NormalizedMessage } from '../raw/normalize.js';
import { normalizeRawMessages } from '../raw/normalize.js';
import { createReducer, reducer } from '../reducer/reducer.js';

export type PublishedSessionTranscriptMessage = Readonly<{
    id: string;
    seq: number;
    localId: string | null;
    createdAt: number;
    raw: unknown;
    messageRole?: SessionMessageRole;
}>;

export type PublishedSessionTranscript = Readonly<{
    normalizedMessages: readonly NormalizedMessage[];
    messages: readonly Message[];
}>;

/**
 * Reduces a complete published page set through the canonical transcript model.
 * Callers re-fold after adding an older page; they never interpret provider rows.
 */
export function readPublishedSessionTranscript(
    source: readonly PublishedSessionTranscriptMessage[],
): PublishedSessionTranscript {
    const ordered = [...source].sort((left, right) => left.seq - right.seq);
    const normalizedMessages = normalizeRawMessages(ordered.map(message => ({
        id: message.id,
        localId: message.localId,
        seq: message.seq,
        createdAt: message.createdAt,
        raw: message.raw,
        messageRole: message.messageRole,
    })));
    return {
        normalizedMessages,
        messages: reducer(createReducer(), normalizedMessages, null).messages,
    };
}
