import { describe, expect, it } from 'vitest';

import {
    formatResetCountdown,
    formatResetCountdownDays,
    type ResetCountdownDaysFormatter,
    type ResetCountdownFormatter,
} from './formatResetCountdown';

const formatter: ResetCountdownFormatter = {
    durationNow: () => 'now',
    durationOutdated: () => 'outdated',
    durationDaysHours: ({ days, hours }) => `${days}d ${hours}h`,
    durationHoursMinutes: ({ hours, minutes }) => `${hours}h ${minutes}m`,
    durationHours: ({ hours }) => `${hours}h`,
    durationMinutes: ({ minutes }) => `${minutes}m`,
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

    it('formats a future reset with day, hour, and minute granularity', () => {
        expect(formatResetCountdown(0, 2 * DAY + 3 * HOUR, formatter)).toBe('2d 3h');
        expect(formatResetCountdown(0, 3 * HOUR + 12 * MINUTE, formatter)).toBe('3h 12m');
        expect(formatResetCountdown(0, 3 * HOUR, formatter)).toBe('3h');
        expect(formatResetCountdown(0, 45 * MINUTE, formatter)).toBe('45m');
    });

    it('formats a current reset as "now" and past resets as outdated', () => {
        expect(formatResetCountdown(1000, 1000, formatter)).toBe('now');
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
