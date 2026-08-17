import { describe, expect, it } from 'vitest';

import { classifyDiscordNonArchivedDeliveryResponse } from './discordDelivery.js';

describe('Discord non-archive delivery response facts', () => {
  it('retains returned message identifiers and distinguishes rate limiting from post-dispatch ambiguity', () => {
    expect(classifyDiscordNonArchivedDeliveryResponse({
      status: 200,
      body: { id: 'message-1', channel_id: 'thread-1' },
    })).toEqual({ kind: 'sent', messageId: 'message-1', channelId: 'thread-1' });
    expect(classifyDiscordNonArchivedDeliveryResponse({
      status: 429,
      body: { retry_after: 2.5, message: 'You are being rate limited.' },
    })).toEqual({
      kind: 'notSent',
      retry: 'after',
      retryAfterMs: 2_500,
      diagnostic: 'You are being rate limited.',
    });
    expect(classifyDiscordNonArchivedDeliveryResponse({
      status: 503,
      body: { message: 'Discord is unavailable.' },
    })).toEqual({
      kind: 'outcomeUnknown',
    });
    expect(classifyDiscordNonArchivedDeliveryResponse({ status: 0, body: null })).toEqual({
      kind: 'outcomeUnknown',
    });
  });
});
