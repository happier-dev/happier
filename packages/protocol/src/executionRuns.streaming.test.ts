import { describe, expect, it } from 'vitest';

import {
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from './executionRuns.js';

describe('execution run streaming schemas', () => {
  it('parses start response', () => {
    const parsed = ExecutionRunTurnStreamStartResponseSchema.parse({ streamId: 'stream-1' });
    expect(parsed.streamId).toBe('stream-1');
  });

  it('parses read response with deltas + done actions', () => {
    const parsed = ExecutionRunTurnStreamReadResponseSchema.parse({
      streamId: 'stream-1',
      events: [
        { t: 'delta', textDelta: 'hello ' },
        { t: 'delta', textDelta: 'world' },
        { t: 'done', assistantText: 'hello world', actions: [{ t: 'sendSessionMessage', args: { message: 'do X' } }] },
      ],
      nextCursor: 3,
      done: true,
    });
    expect(parsed.done).toBe(true);
    expect(parsed.events[2]).toEqual(
      expect.objectContaining({ t: 'done', assistantText: 'hello world' }),
    );
  });
});

