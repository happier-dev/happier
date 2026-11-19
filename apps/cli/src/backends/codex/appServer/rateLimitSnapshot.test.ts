import { describe, expect, it } from 'vitest';

import {
  isCodexRateLimitSnapshotExhausted,
  readLatestExhaustedCodexRateLimitResetAtMs,
} from './rateLimitSnapshot';

const nowMs = Date.parse('2026-06-11T10:00:00.000Z');

describe('readLatestExhaustedCodexRateLimitResetAtMs', () => {
  it('reads the latest exhausted reset across primary and secondary meters', () => {
    expect(readLatestExhaustedCodexRateLimitResetAtMs({
      primary: { used_percent: 100, resets_at: '2026-06-11T12:00:00.000Z' },
      secondary: { used_percent: 100, resets_at: '2026-06-11T11:00:00.000Z' },
    }, nowMs)).toBe(Date.parse('2026-06-11T12:00:00.000Z'));
  });

  it('converts relative resets_in_seconds to an absolute reset (RD-QUO-1)', () => {
    expect(readLatestExhaustedCodexRateLimitResetAtMs({
      primary: { used_percent: 100, resets_in_seconds: 1_800 },
    }, nowMs)).toBe(nowMs + 1_800_000);
  });

  it('ignores timing on available meters', () => {
    expect(readLatestExhaustedCodexRateLimitResetAtMs({
      rate_limits: {
        primary_window: { used_percent: 50, resets_in_seconds: 600 },
        secondary_window: { used_percent: 100, resets_at: '2026-06-12T10:00:00.000Z' },
      },
    }, nowMs)).toBe(Date.parse('2026-06-12T10:00:00.000Z'));
  });

  it('prefers an absolute reset over a relative one on the same meter', () => {
    expect(readLatestExhaustedCodexRateLimitResetAtMs({
      primary: { used_percent: 100, resets_at: '2026-06-11T13:00:00.000Z', resets_in_seconds: 60 },
    }, nowMs)).toBe(Date.parse('2026-06-11T13:00:00.000Z'));
  });

  it('returns null when any exhausted meter has unknown timing', () => {
    expect(readLatestExhaustedCodexRateLimitResetAtMs({
      primary: { status: 'limited' },
      secondary: { used_percent: 100, resets_in_seconds: 1_800 },
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
