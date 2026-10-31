import { describe, expect, it } from 'vitest';
import { MAX_CONVERSATION_RECEIVE_WAIT_MS } from '@happier-dev/channels-protocol/v1';

import { conversationRetryDelayMs } from './retryBackoff.js';

describe('Channels retry backoff', () => {
  it('doubles below the receive-wait boundary and saturates there without exhausting retries', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20, Number.MAX_SAFE_INTEGER].map(conversationRetryDelayMs)).toEqual([
      1_000,
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      MAX_CONVERSATION_RECEIVE_WAIT_MS,
      MAX_CONVERSATION_RECEIVE_WAIT_MS,
      MAX_CONVERSATION_RECEIVE_WAIT_MS,
    ]);
  });
});
