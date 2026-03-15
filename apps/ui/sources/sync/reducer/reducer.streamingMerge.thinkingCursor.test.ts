import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

describe('reducer (streaming merge: thinking cursor)', () => {
    it('merges consecutive thinking chunks across reducer calls when streamed messages lack seq', () => {
        const state = createReducer();

        const seeded: NormalizedMessage = {
            id: 'seed',
            seq: 100,
            localId: null,
            createdAt: 1000,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: 'seed', uuid: 'seed', parentUUID: null }],
        };

        const thinking1: NormalizedMessage = {
            id: 't1',
            // Intentionally omit `seq` to simulate streamed payloads that are missing transcript ordering.
            localId: null,
            createdAt: 2000,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'thinking', thinking: 'Hello', uuid: 't1', parentUUID: null }],
        };

        const thinking2: NormalizedMessage = {
            id: 't2',
            localId: null,
            createdAt: 2010,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'thinking', thinking: ' world', uuid: 't2', parentUUID: null }],
        };

        reducer(state, [seeded], null);
        reducer(state, [thinking1], null);
        reducer(state, [thinking2], null);

        const thinkingMessages = [...state.messages.values()].filter(
            (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
        );

        expect(thinkingMessages).toHaveLength(1);
        expect(thinkingMessages[0]?.text).toBe('Hello world');
    });

    it('does not merge thinking chunks across an event boundary', () => {
        const state = createReducer();

        const thinking1: NormalizedMessage = {
            id: 't1',
            localId: null,
            createdAt: 2000,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'thinking', thinking: 'Hello', uuid: 't1', parentUUID: null }],
        };

        const event: NormalizedMessage = {
            id: 'e1',
            localId: null,
            createdAt: 2005,
            role: 'event',
            isSidechain: false,
            content: {
                type: 'switch',
                mode: 'remote',
            },
        };

        const thinking2: NormalizedMessage = {
            id: 't2',
            localId: null,
            createdAt: 2010,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'thinking', thinking: ' world', uuid: 't2', parentUUID: null }],
        };

        reducer(state, [thinking1], null);
        reducer(state, [event], null);
        reducer(state, [thinking2], null);

        const thinkingMessages = [...state.messages.values()].filter(
            (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
        );

        expect(thinkingMessages).toHaveLength(2);
    });
});
