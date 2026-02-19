import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

describe('reducer (streaming merge: agent message id reuse)', () => {
    it('merges incremental agent text chunks even when the provider reuses the same message id', () => {
        const state = createReducer();
        const streamKey = 'stream:turn:1';

        const chunk1: NormalizedMessage = {
            id: 'agent_msg_1',
            seq: 1,
            localId: null,
            createdAt: 1000,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: 'Hello', uuid: 'c1', parentUUID: null }],
            meta: { happierStreamKey: streamKey },
        };

        const chunk2: NormalizedMessage = {
            id: 'agent_msg_1',
            seq: 2,
            localId: null,
            createdAt: 1001,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: ' world', uuid: 'c2', parentUUID: 'c1' }],
            meta: { happierStreamKey: streamKey },
        };

        reducer(state, [chunk1], null);
        reducer(state, [chunk2], null);

        const agentTextMessages = [...state.messages.values()].filter(
            (m) => m.role === 'agent' && !m.isThinking && typeof m.text === 'string',
        );
        expect(agentTextMessages).toHaveLength(1);
        expect(agentTextMessages[0]?.text).toBe('Hello world');

        // Re-applying the same chunk should not double-append.
        reducer(state, [chunk2], null);
        const replay = [...state.messages.values()].filter(
            (m) => m.role === 'agent' && !m.isThinking && typeof m.text === 'string',
        );
        expect(replay).toHaveLength(1);
        expect(replay[0]?.text).toBe('Hello world');
    });
});
