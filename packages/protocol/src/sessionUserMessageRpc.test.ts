import { describe, expect, it } from 'vitest';

import { SessionUserMessageSendResponseSchema } from './sessionUserMessageRpc.js';

describe('SessionUserMessageSendResponseSchema', () => {
  it('accepts successful ACK payloads', () => {
    expect(SessionUserMessageSendResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it('accepts runtime error ACK payloads', () => {
    expect(
      SessionUserMessageSendResponseSchema.parse({
        ok: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      }),
    ).toEqual({
      ok: false,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    });
  });
});
