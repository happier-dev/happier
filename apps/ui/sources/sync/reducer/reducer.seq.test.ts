import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

describe('reducer (message seq propagation)', () => {
  it('preserves the transcript seq on materialized transcript messages', () => {
    const state = createReducer();
    const messages: NormalizedMessage[] = [
      {
        id: 'm1',
        seq: 2,
        localId: null,
        createdAt: 123,
        role: 'user',
        content: { type: 'text', text: 'hello' },
        isSidechain: false,
      },
    ];

    const res = reducer(state, messages, null);
    const first = res.messages[0] as any;
    expect(first.kind).toBe('user-text');
    expect(first.seq).toBe(2);
  });

  it('preserves intra-message content block order for text and tool calls with the same seq', () => {
    const state = createReducer();
    const messages: NormalizedMessage[] = [
      {
        id: 'm1',
        seq: 7,
        localId: null,
        createdAt: 123,
        role: 'agent',
        isSidechain: false,
        content: [
          { type: 'text', text: 'before', uuid: 'uuid-text-before', parentUUID: null },
          {
            type: 'tool-call',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'pwd' },
            description: 'Run shell command',
            uuid: 'uuid-tool-1',
            parentUUID: null,
          },
          { type: 'text', text: 'after', uuid: 'uuid-text-after', parentUUID: null },
        ],
      },
    ];

    const res = reducer(state, messages, null);

    expect(res.messages.map((message) => message.kind)).toEqual([
      'agent-text',
      'tool-call',
      'agent-text',
    ]);
    expect(res.messages.map((message) => message.transcriptBlockIndex)).toEqual([0, 1, 2]);
  });
});
