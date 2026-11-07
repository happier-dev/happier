import { describe, expect, it } from 'vitest';

import {
    formatResetCountdown,
    formatResetCountdownDays,
    isResetCountdownOutdated,
    type ResetCountdownDaysFormatter,
    type ResetCountdownFormatter,
} from './formatResetCountdown';

const formatter: ResetCountdownFormatter = {
    durationNow: () => 'now',
    durationOutdated: () => 'outdated',
    durationDaysHours: ({ days, hours }) => `${days}d ${hours}h`,
    durationHoursMinutes: ({ hours, minutes }) => `${hours}h ${minutes}m`,
    durationMinutes: ({ minutes }) => `${minutes}m`,
    durationHoursMinutesSeconds: ({ hours, minutes, seconds }) => `${hours}h ${minutes}m ${seconds}s`,
    durationMinutesSeconds: ({ minutes, seconds }) => `${minutes}m ${seconds}s`,
};

const daysFormatter: ResetCountdownDaysFormatter = {
    now: () => 'now',
    inDays: ({ days }) => `in ${days}d`,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatResetCountdown', () => {
    it('returns null when there is no reset timestamp', () => {
        expect(formatResetCountdown(0, null, formatter)).toBeNull();
    });

    it('formats a future reset with day granularity from one day up', () => {
        expect(formatResetCountdown(0, 2 * DAY + 3 * HOUR, formatter)).toBe('2d 3h');
    });

    it('formats a sub-day reset as hours, minutes and seconds, flooring the seconds', () => {
        expect(formatResetCountdown(0, 3 * HOUR + 12 * MINUTE + 5_900, formatter)).toBe('3h 12m 5s');
        expect(formatResetCountdown(0, 3 * HOUR, formatter)).toBe('3h 0m 0s');
        expect(formatResetCountdown(0, 45 * MINUTE + 7_000, formatter)).toBe('45m 7s');
        expect(formatResetCountdown(0, 59_000, formatter)).toBe('0m 59s');
    });

    it('counts down second by second as the clock advances', () => {
        expect(formatResetCountdown(0, 3 * HOUR, formatter)).toBe('3h 0m 0s');
        expect(formatResetCountdown(1_000, 3 * HOUR, formatter)).toBe('2h 59m 59s');
    });

    it('formats a current reset as "now"', () => {
        expect(formatResetCountdown(1000, 1000, formatter)).toBe('now');
    });

    it('reports outdated only for elapsed or malformed reset boundaries', () => {
        // Label composers use this to DROP the "resets in …" clause for stale snapshots instead of
        // composing the nonsense phrase "resets in outdated" (observed live 2026-07-10).
        expect(isResetCountdownOutdated(2000, 1000)).toBe(true);
        expect(isResetCountdownOutdated(2000, Number.NaN)).toBe(false);
        expect(isResetCountdownOutdated(2000, null)).toBe(false);
        expect(isResetCountdownOutdated(2000, 3000)).toBe(false);
    });

    it('formats a past reset as outdated rather than live-now', () => {
        expect(formatResetCountdown(2000, 1000, formatter)).toBe('outdated');
    });
});

describe('formatResetCountdownDays', () => {
    it('returns null when there is no reset timestamp', () => {
        expect(formatResetCountdownDays(0, null, daysFormatter)).toBeNull();
    });

    it('rounds up to whole days for future resets', () => {
        expect(formatResetCountdownDays(0, 2 * DAY, daysFormatter)).toBe('in 2d');
        // Anything under a day still reads as a full day so it never says "in 0d".
        expect(formatResetCountdownDays(0, 3 * HOUR, daysFormatter)).toBe('in 1d');
        expect(formatResetCountdownDays(0, 2 * DAY + 1 * HOUR, daysFormatter)).toBe('in 3d');
    });

    it('formats a past or current reset as "now"', () => {
        expect(formatResetCountdownDays(1000, 1000, daysFormatter)).toBe('now');
        expect(formatResetCountdownDays(2000, 1000, daysFormatter)).toBe('now');
    });
});
