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

  it('preserves localId on materialized agent events', () => {
    const state = createReducer();
    const messages: NormalizedMessage[] = [
      {
        id: 'event-1',
        seq: 3,
        localId: 'agent-transition-divider:local-1',
        createdAt: 124,
        role: 'event',
        content: { type: 'message', message: 'Agent changed' },
        isSidechain: false,
      },
    ];

    const res = reducer(state, messages, null);
    expect(res.messages[0]).toMatchObject({
      kind: 'agent-event',
      localId: 'agent-transition-divider:local-1',
    });
  });
});

