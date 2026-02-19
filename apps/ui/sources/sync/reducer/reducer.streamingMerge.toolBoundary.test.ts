import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

describe('reducer (streaming merge: tool boundaries)', () => {
    it('does not merge streamed text chunks across a tool-call boundary (even when createdAt is non-monotonic)', () => {
        const state = createReducer();
        const streamKey = 'stream:turn:1';

        const chunk1: NormalizedMessage = {
            id: 'a1',
            seq: 10,
            localId: null,
            createdAt: 2000,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: 'Hello', uuid: 'a1', parentUUID: null }],
            meta: { happierStreamKey: streamKey },
        };

        const toolCall: NormalizedMessage = {
            id: 'a2',
            seq: 11,
            localId: null,
            createdAt: 1500,
            role: 'agent',
            isSidechain: false,
            content: [
                {
                    type: 'tool-call',
                    id: 'tool_1',
                    name: 'task',
                    input: { description: 'Do a thing' },
                    description: 'Do a thing',
                    uuid: 'a2',
                    parentUUID: null,
                },
            ],
        };

        const chunk2: NormalizedMessage = {
            id: 'a3',
            seq: 12,
            localId: null,
            createdAt: 1600,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: ' world', uuid: 'a3', parentUUID: null }],
            meta: { happierStreamKey: streamKey },
        };

        reducer(state, [chunk1], null);
        reducer(state, [toolCall], null);
        reducer(state, [chunk2], null);

        const agentTextMessages = [...state.messages.values()].filter(
            (m) => m.role === 'agent' && !m.isThinking && typeof m.text === 'string',
        );

        expect(agentTextMessages).toHaveLength(2);
        expect(agentTextMessages.some((m) => m.text === 'Hello')).toBe(true);
        expect(agentTextMessages.some((m) => m.text === ' world')).toBe(true);
    });
});

