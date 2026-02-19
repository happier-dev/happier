import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

describe('reducer (streaming merge: thinking interleaving)', () => {
  it('merges streamed text chunks across reducer calls even when thinking deltas arrive between them', () => {
    const state = createReducer();
    const streamKey = 'stream:turn:1';

    const chunk1: NormalizedMessage = {
      id: 'a1',
      seq: 1,
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [{ type: 'text', text: 'Hello', uuid: 'a1', parentUUID: null }],
      meta: { happierStreamKey: streamKey },
    };

    const thinking: NormalizedMessage = {
      id: 't1',
      seq: 2,
      localId: null,
      createdAt: 1001,
      role: 'agent',
      isSidechain: false,
      content: [{ type: 'thinking', thinking: '...', uuid: 't1', parentUUID: null }],
      meta: { happierStreamKey: streamKey },
    };

    const chunk2: NormalizedMessage = {
      id: 'a2',
      seq: 3,
      localId: null,
      createdAt: 1002,
      role: 'agent',
      isSidechain: false,
      content: [{ type: 'text', text: ' world', uuid: 'a2', parentUUID: null }],
      meta: { happierStreamKey: streamKey },
    };

    reducer(state, [chunk1], null);
    reducer(state, [thinking], null);
    reducer(state, [chunk2], null);

    const agentTextMessages = [...state.messages.values()].filter(
      (m) => m.role === 'agent' && !m.isThinking && typeof m.text === 'string',
    );

    expect(agentTextMessages).toHaveLength(1);
    expect(agentTextMessages[0]?.text).toBe('Hello world');
    expect(agentTextMessages[0]?.seq).toBe(3);
  });
});

