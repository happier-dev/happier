import { describe, expect, it } from 'vitest';

import {
  VoiceMediatorTurnStreamReadResponseSchema,
  VoiceMediatorTurnStreamStartResponseSchema,
} from './voiceMediator.js';

describe('Voice mediator streaming schemas', () => {
  it('parses stream start response payloads', () => {
    const parsed = VoiceMediatorTurnStreamStartResponseSchema.parse({ streamId: 'stream-1' });
    expect(parsed).toEqual({ streamId: 'stream-1' });
  });

  it('parses stream read responses with delta and done events', () => {
    const parsed = VoiceMediatorTurnStreamReadResponseSchema.parse({
      streamId: 'stream-1',
      events: [
        { t: 'delta', textDelta: 'hello ' },
        { t: 'delta', textDelta: 'world' },
        { t: 'done', assistantText: 'hello world', actions: [{ t: 'messageClaudeCode', args: { message: 'do X' } }] },
      ],
      nextCursor: 3,
      done: true,
    });

    expect(parsed.done).toBe(true);
    expect(parsed.events.map((event) => event.t)).toEqual(['delta', 'delta', 'done']);
    const done = parsed.events[2];
    expect(done.t).toBe('done');
    if (done.t !== 'done') {
      throw new Error('Expected done event');
    }
    expect(done.actions?.[0]?.t).toBe('messageClaudeCode');
  });

  it('parses stream read responses with an error event', () => {
    const parsed = VoiceMediatorTurnStreamReadResponseSchema.parse({
      streamId: 'stream-2',
      events: [
        { t: 'error', error: 'backend failed', errorCode: 'VOICE_MEDIATOR_UNSUPPORTED' },
      ],
      nextCursor: 1,
      done: true,
    });

    expect(parsed.events[0]).toMatchObject({
      t: 'error',
      errorCode: 'VOICE_MEDIATOR_UNSUPPORTED',
    });
  });
});
