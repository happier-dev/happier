import { describe, expect, it } from 'vitest';

import { applyCursorUsageObservation } from './usage.js';

describe('applyCursorUsageObservation', () => {
  it('treats Cursor cost as cumulative per session', () => {
    const first = applyCursorUsageObservation(null, {
      sessionId: 'cursor-session',
      totalUsd: 0.12,
    });
    const second = applyCursorUsageObservation(first, {
      sessionId: 'cursor-session',
      totalUsd: 0.20,
    });

    expect(second).toEqual({
      sessionId: 'cursor-session',
      totalUsd: 0.20,
      deltaUsd: 0.08,
    });
  });
});
