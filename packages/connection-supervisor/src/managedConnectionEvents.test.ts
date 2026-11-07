import { describe, expect, it } from 'vitest';

import { isRetryOfKnownFailure } from './managedConnectionEvents.js';

describe('isRetryOfKnownFailure', () => {
  it('only a timer-driven re-entry (attempt > 0) of an already presented failure is a retry; start and explicit retry are not', () => {
    expect(isRetryOfKnownFailure({ phase: 'connecting', attempt: 2 }, true)).toBe(true);
    expect(isRetryOfKnownFailure({ phase: 'connecting', attempt: 0 }, true)).toBe(false);
    expect(isRetryOfKnownFailure({ phase: 'connecting', attempt: 2 }, false)).toBe(false);
    expect(isRetryOfKnownFailure({ phase: 'offline', attempt: 2 }, true)).toBe(false);
  });
});
