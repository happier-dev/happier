import { describe, expect, it } from 'vitest';

import type { TranscriptNavigationLoadedMessage } from './transcriptNavigationTypes';
import {
    deriveTranscriptNavigationRemoteUserTurns,
    resolveTranscriptNavigationRemoteUserTurnBeforeSeq,
} from './transcriptNavigationRemoteUserTurns';

function loadedMessage(
    overrides: Partial<TranscriptNavigationLoadedMessage> = {},
): TranscriptNavigationLoadedMessage {
    return {
        sessionId: 'session-1',
        messageId: 'm1',
        routeMessageId: 'local:m1',
        seq: 7,
        transcriptBlockIndex: 0,
        role: 'user',
        text: 'Loaded prompt',
        createdAtMs: 70,
        loaded: true,
        ...overrides,
    };
}

describe('transcriptNavigationRemoteUserTurns', () => {
    it('uses the earliest loaded user seq as the remote history cursor', () => {
        expect(resolveTranscriptNavigationRemoteUserTurnBeforeSeq([
            loadedMessage({ seq: 12, role: 'user' }),
            loadedMessage({ seq: 7, role: 'assistant' }),
            loadedMessage({ seq: 4, role: 'user' }),
            loadedMessage({ seq: null, role: 'user' }),
        ])).toBe(4);
    });

    it('maps remote user history entries into unloaded navigation user turns before the loaded cursor', () => {
        expect(deriveTranscriptNavigationRemoteUserTurns({
            sessionId: 'session-1',
            beforeSeq: 7,
            entries: [
                { seq: 8, createdAt: 80, text: 'already loaded side' },
                { seq: 6, createdAt: 60, text: ' Earlier prompt ' },
                { seq: 5, createdAt: 50, text: '   ' },
                { seq: 4, createdAt: 40, text: 'Oldest prompt' },
            ],
        })).toEqual([
            {
                sessionId: 'session-1',
                seq: 6,
                text: 'Earlier prompt',
                createdAtMs: 60,
            },
            {
                sessionId: 'session-1',
                seq: 4,
                text: 'Oldest prompt',
                createdAtMs: 40,
            },
        ]);
    });
});
