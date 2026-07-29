import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveExternalSessionActivity } from './externalSession.js';

describe('deriveExternalSessionActivity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('classifies the exact configured boundary as recent and the next millisecond as idle', () => {
    const env = {
      HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
    };

    expect(deriveExternalSessionActivity({ updatedAtMs: 5_000, nowMs: 10_000, env })).toBe('active_recently');
    expect(deriveExternalSessionActivity({ updatedAtMs: 4_999, nowMs: 10_000, env })).toBe('idle');
  });

  it('preserves the current one-second and one-hour environment clamps', () => {
    expect(deriveExternalSessionActivity({
      updatedAtMs: 9_000,
      nowMs: 10_000,
      env: { HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '1' },
    })).toBe('active_recently');
    expect(deriveExternalSessionActivity({
      updatedAtMs: 8_999,
      nowMs: 10_000,
      env: { HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '1' },
    })).toBe('idle');

    expect(deriveExternalSessionActivity({
      updatedAtMs: 1_000,
      nowMs: 3_601_000,
      env: { HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '9999999' },
    })).toBe('active_recently');
    expect(deriveExternalSessionActivity({
      updatedAtMs: 999,
      nowMs: 3_601_000,
      env: { HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '9999999' },
    })).toBe('idle');
  });

  it('uses the current process environment when an explicit environment is omitted', () => {
    vi.stubEnv('HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS', '2000');

    expect(deriveExternalSessionActivity({ updatedAtMs: 8_000, nowMs: 10_000 })).toBe('active_recently');
    expect(deriveExternalSessionActivity({ updatedAtMs: 7_999, nowMs: 10_000 })).toBe('idle');
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'returns unknown for an invalid timestamp (%s)',
    (updatedAtMs) => {
      expect(deriveExternalSessionActivity({ updatedAtMs, nowMs: 10_000, env: {} })).toBe('unknown');
    },
  );

  it('returns unknown for a timestamp in the future', () => {
    expect(deriveExternalSessionActivity({ updatedAtMs: 10_001, nowMs: 10_000, env: {} })).toBe('unknown');
  });
});
