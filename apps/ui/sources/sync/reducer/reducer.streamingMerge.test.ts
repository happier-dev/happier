import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

describe('reducer (streaming merge across calls)', () => {
    it('merges root agent text chunks across reducer calls when happierStreamKey matches', () => {
        const state = createReducer();
        const now = 1_700_000_000_000;
        const streamKey = 'stream:turn:1';

        const mkChunk = (id: string, seq: number, createdAt: number, text: string): NormalizedMessage => ({
            id,
            seq,
            localId: null,
            createdAt,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text, uuid: id, parentUUID: null }],
            meta: { happierStreamKey: streamKey },
        });

        reducer(state, [mkChunk('a1', 1, now, 'Hello')], null);
        const afterFirst = [...state.messages.values()].filter(
            (m) => m.role === 'agent' && !m.isThinking && typeof m.text === 'string',
        );
        expect(afterFirst).toHaveLength(1);
        expect(afterFirst[0]?.text).toBe('Hello');
        expect(afterFirst[0]?.seq).toBe(1);

        reducer(state, [mkChunk('a2', 2, now + 1, ' world')], null);
        const afterSecond = [...state.messages.values()].filter(
            (m) => m.role === 'agent' && !m.isThinking && typeof m.text === 'string',
        );
        expect(afterSecond).toHaveLength(1);
        expect(afterSecond[0]?.text).toBe('Hello world');
        expect(afterSecond[0]?.seq).toBe(2);
    });

    it('merges root agent text chunks in chronological order even when chunks arrive out of order', () => {
        const state = createReducer();
        const now = 1_700_000_000_000;
        const streamKey = 'stream:turn:1';

        const mkChunk = (id: string, seq: number, createdAt: number, text: string): NormalizedMessage => ({
            id,
            seq,
            localId: null,
            createdAt,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text, uuid: id, parentUUID: null }],
            meta: { happierStreamKey: streamKey },
        });

        // Simulate a socket batch where a later chunk arrives before an earlier one.
        reducer(state, [mkChunk('a2', 2, now + 1, ' world'), mkChunk('a1', 1, now, 'Hello')], null);

        const agentMessages = [...state.messages.values()].filter(
            (m) => m.role === 'agent' && !m.isThinking && typeof m.text === 'string',
        );
        expect(agentMessages).toHaveLength(1);
        expect(agentMessages[0]?.text).toBe('Hello world');
        expect(agentMessages[0]?.seq).toBe(2);
    });
});
