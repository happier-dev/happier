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
});

