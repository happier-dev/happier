import { describe, expect, it } from 'vitest';

import { deriveDirectSessionActivityFromTimestamp } from './deriveDirectSessionActivityFromTimestamp';

describe('deriveDirectSessionActivityFromTimestamp', () => {
  it('treats missing or invalid timestamps as unknown', () => {
    expect(deriveDirectSessionActivityFromTimestamp({ updatedAtMs: null, nowMs: 1_000 })).toBe('unknown');
    expect(deriveDirectSessionActivityFromTimestamp({ updatedAtMs: undefined, nowMs: 1_000 })).toBe('unknown');
    expect(deriveDirectSessionActivityFromTimestamp({ updatedAtMs: -1, nowMs: 1_000 })).toBe('unknown');
  });

  it('marks recent timestamps as active_recently and older ones as idle', () => {
    expect(
      deriveDirectSessionActivityFromTimestamp({
        updatedAtMs: 9_500,
        nowMs: 10_000,
        env: { HAPPIER_DIRECT_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '1000' },
      }),
    ).toBe('active_recently');

    expect(
      deriveDirectSessionActivityFromTimestamp({
        updatedAtMs: 7_000,
        nowMs: 10_000,
        env: { HAPPIER_DIRECT_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '1000' },
      }),
    ).toBe('idle');
  });
});
