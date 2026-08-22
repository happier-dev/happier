import { describe, expect, it } from 'vitest';

import { conversationRetryDelayMs } from './retryBackoff.js';

describe('Channels retry backoff', () => {
  it('doubles from the base delay and saturates at the ceiling', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(conversationRetryDelayMs)).toEqual([
      1_000,
      1_000,
      2_000,
      4_000,
      8_000,
      8_000,
      8_000,
      8_000,
    ]);
  });

  it('never returns a sub-base delay for an unattempted count', () => {
    // The predecessor ingress formula computed `1_000 * 2 ** -1` here, which
    // would have scheduled a retry sooner than the first backoff step.
    expect(conversationRetryDelayMs(0)).toBe(conversationRetryDelayMs(1));
  });
});
