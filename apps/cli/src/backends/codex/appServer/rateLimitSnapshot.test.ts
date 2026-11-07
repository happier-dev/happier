import { describe, expect, it } from 'vitest';

import {
  isCodexRateLimitSnapshotExhausted,
  readCodexRateLimitRecoveryResetAtMs,
} from './rateLimitSnapshot';

const nowMs = Date.parse('2026-06-11T10:00:00.000Z');

describe('readCodexRateLimitRecoveryResetAtMs', () => {
  it('waits for the latest reset when both primary and secondary meters are exhausted', () => {
    expect(readCodexRateLimitRecoveryResetAtMs({
      primary: { used_percent: 100, resets_at: '2026-06-11T12:00:00.000Z' },
      secondary: { used_percent: 100, resets_at: '2026-06-11T11:00:00.000Z' },
    }, nowMs)).toBe(Date.parse('2026-06-11T12:00:00.000Z'));
  });

  it('converts relative resets_in_seconds to an absolute reset (RD-QUO-1)', () => {
    expect(readCodexRateLimitRecoveryResetAtMs({
      primary: { used_percent: 100, resets_in_seconds: 1_800 },
    }, nowMs)).toBe(nowMs + 1_800_000);
  });

  it('uses the latest blocking timing across absolute and relative meters', () => {
    expect(readCodexRateLimitRecoveryResetAtMs({
      rate_limits: {
        primary_window: { used_percent: 100, resets_in_seconds: 600 },
        secondary_window: { used_percent: 100, resets_at: '2026-06-12T10:00:00.000Z' },
      },
    }, nowMs)).toBe(Date.parse('2026-06-12T10:00:00.000Z'));
  });

  it('ignores the reset of a window that still has available usage', () => {
    expect(readCodexRateLimitRecoveryResetAtMs({
      primary: { used_percent: 10, resets_in_seconds: 600 },
      secondary: { used_percent: 100, resets_in_seconds: 86_400 },
    }, nowMs)).toBe(nowMs + 86_400_000);
    expect(readCodexRateLimitRecoveryResetAtMs({
      primary: { used_percent: 100, resets_in_seconds: 600 },
      secondary: { used_percent: 10, resets_in_seconds: 86_400 },
    }, nowMs)).toBe(nowMs + 600_000);
  });

  it('prefers an absolute reset over a relative one on the same meter', () => {
    expect(readCodexRateLimitRecoveryResetAtMs({
      primary: { used_percent: 100, resets_at: '2026-06-11T13:00:00.000Z', resets_in_seconds: 60 },
    }, nowMs)).toBe(Date.parse('2026-06-11T13:00:00.000Z'));
  });

  it('returns null when no reset timing is present', () => {
    expect(readCodexRateLimitRecoveryResetAtMs({
      primary: { used_percent: 100 },
    }, nowMs)).toBeNull();
  });
});

describe('isCodexRateLimitSnapshotExhausted', () => {
  it('treats either meter at or above 100% used as exhausted', () => {
    expect(isCodexRateLimitSnapshotExhausted({
      primary: { used_percent: 12 },
      secondary: { used_percent: 100 },
    })).toBe(true);
    expect(isCodexRateLimitSnapshotExhausted({
      primary: { used_percent: 12 },
      secondary: { used_percent: 99 },
    })).toBe(false);
  });
});
