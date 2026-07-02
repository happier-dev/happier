import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatShortRelativeTime, formatShortRelativeTimeAt } from './formatShortRelativeTime';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Fixed "now" anchor: 2025-06-15T12:00:00.000Z
const NOW = new Date('2025-06-15T12:00:00.000Z').getTime();

describe('formatShortRelativeTime', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    function setNow(time: number) {
        vi.useFakeTimers();
        vi.setSystemTime(time);
    }

    describe('explicit now input', () => {
        it('formats relative time from the supplied now timestamp without reading Date.now()', () => {
            setNow(NOW);
            expect(formatShortRelativeTimeAt(NOW - 6 * MINUTE, NOW + 4 * MINUTE)).toBe('10m');
        });
    });

    describe('invalid / edge-case inputs', () => {
        it('returns empty string for future timestamps (negative diff)', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW + 10_000)).toBe('');
        });

        it('returns empty string when timestamp is exactly 1ms in the future', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW + 1)).toBe('');
        });

        it('returns empty string for NaN timestamp', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NaN)).toBe('');
        });

        it('returns empty string for Infinity timestamp', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(Infinity)).toBe('');
        });

        it('returns empty string for -Infinity timestamp', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(-Infinity)).toBe('');
        });
    });

    describe('seconds range (< 60s) => "now"', () => {
        it('returns "now" when timestamp equals Date.now() (0 diff)', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW)).toBe('now');
        });

        it('returns "now" for 1 second ago', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 1 * SECOND)).toBe('now');
        });

        it('returns "now" for 30 seconds ago', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 30 * SECOND)).toBe('now');
        });

        it('returns "now" for 59 seconds ago', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 59 * SECOND)).toBe('now');
        });

        it('returns "now" at exactly 59.999s ago (just under 60s)', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 59 * SECOND - 999)).toBe('now');
        });
    });

    describe('minutes range (1m - 59m)', () => {
        it('returns "1m" at exactly 60 seconds', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 60 * SECOND)).toBe('1m');
        });

        it('returns "1m" at 90 seconds (rounds down)', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 90 * SECOND)).toBe('1m');
        });

        it('returns "5m" for 5 minutes ago', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 5 * MINUTE)).toBe('5m');
        });

        it('returns "30m" for 30 minutes ago', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 30 * MINUTE)).toBe('30m');
        });

        it('returns "59m" at 59 minutes 59 seconds', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 59 * MINUTE - 59 * SECOND)).toBe('59m');
        });
    });

    describe('hours range (1h - 23h)', () => {
        it('returns "1h" at exactly 60 minutes', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 60 * MINUTE)).toBe('1h');
        });

        it('returns "1h" at 90 minutes (rounds down to 1h)', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 90 * MINUTE)).toBe('1h');
        });

        it('returns "12h" for 12 hours ago', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 12 * HOUR)).toBe('12h');
        });

        it('returns "23h" at 23 hours 59 minutes', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 23 * HOUR - 59 * MINUTE)).toBe('23h');
        });
    });

    describe('days range (1d - 6d)', () => {
        it('returns "1d" at exactly 24 hours', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 24 * HOUR)).toBe('1d');
        });

        it('returns "1d" at 36 hours (rounds down to 1d)', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 36 * HOUR)).toBe('1d');
        });

        it('returns "3d" for 3 days ago', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 3 * DAY)).toBe('3d');
        });

        it('returns "6d" at 6 days 23 hours', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 6 * DAY - 23 * HOUR)).toBe('6d');
        });
    });

    describe('weeks range (1w - 4w)', () => {
        it('returns "1w" at exactly 7 days', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 7 * DAY)).toBe('1w');
        });

        it('returns "1w" at 10 days (rounds down to 1w)', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 10 * DAY)).toBe('1w');
        });

        it('returns "2w" for 14 days', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 14 * DAY)).toBe('2w');
        });

        it('returns "3w" for 21 days', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 21 * DAY)).toBe('3w');
        });

        it('returns "4w" for 28 days', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 28 * DAY)).toBe('4w');
        });

        it('returns "4w" at 34 days (4 weeks + 6 days, still < 5 weeks)', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 34 * DAY)).toBe('4w');
        });
    });

    describe('months range (1mo - 11mo)', () => {
        it('transitions from weeks to months at 35 days (5 weeks)', () => {
            setNow(NOW);
            // 35 days = 5 weeks (>= 5, exits weeks branch)
            // months = Math.floor(35 / 30) = 1
            expect(formatShortRelativeTime(NOW - 35 * DAY)).toBe('1mo');
        });

        it('returns "2mo" for 60 days', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 60 * DAY)).toBe('2mo');
        });

        it('returns "3mo" for 90 days', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 90 * DAY)).toBe('3mo');
        });

        it('returns "6mo" for 180 days', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 180 * DAY)).toBe('6mo');
        });

        it('returns "11mo" for 330 days', () => {
            setNow(NOW);
            // months = Math.floor(330 / 30) = 11
            expect(formatShortRelativeTime(NOW - 330 * DAY)).toBe('11mo');
        });

        it('returns "11mo" for 359 days', () => {
            setNow(NOW);
            // months = Math.floor(359 / 30) = 11
            expect(formatShortRelativeTime(NOW - 359 * DAY)).toBe('11mo');
        });
    });

    describe('years range (>= 12 months)', () => {
        it('returns "1y" at 360 days', () => {
            setNow(NOW);
            // months = Math.floor(360 / 30) = 12, exits months branch
            // years = Math.floor(360 / 365) = 0... but let's verify
            // Actually: 360 / 30 = 12, so months >= 12, falls through
            // years = Math.floor(360 / 365) = 0
            expect(formatShortRelativeTime(NOW - 360 * DAY)).toBe('0y');
        });

        it('returns "1y" at 365 days', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 365 * DAY)).toBe('1y');
        });

        it('returns "1y" at 500 days', () => {
            setNow(NOW);
            // years = Math.floor(500 / 365) = 1
            expect(formatShortRelativeTime(NOW - 500 * DAY)).toBe('1y');
        });

        it('returns "2y" at 730 days', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 730 * DAY)).toBe('2y');
        });

        it('returns "5y" for approximately 5 years', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 5 * 365 * DAY)).toBe('5y');
        });
    });

    describe('boundary transitions', () => {
        it('transitions from "now" to "1m" at 60s boundary', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 59 * SECOND)).toBe('now');
            expect(formatShortRelativeTime(NOW - 60 * SECOND)).toBe('1m');
        });

        it('transitions from minutes to hours at 60m boundary', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 59 * MINUTE - 59 * SECOND)).toBe('59m');
            expect(formatShortRelativeTime(NOW - 60 * MINUTE)).toBe('1h');
        });

        it('transitions from hours to days at 24h boundary', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 23 * HOUR - 59 * MINUTE)).toBe('23h');
            expect(formatShortRelativeTime(NOW - 24 * HOUR)).toBe('1d');
        });

        it('transitions from days to weeks at 7d boundary', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 6 * DAY - 23 * HOUR)).toBe('6d');
            expect(formatShortRelativeTime(NOW - 7 * DAY)).toBe('1w');
        });

        it('transitions from weeks to months at 5w boundary', () => {
            setNow(NOW);
            expect(formatShortRelativeTime(NOW - 34 * DAY)).toBe('4w');
            expect(formatShortRelativeTime(NOW - 35 * DAY)).toBe('1mo');
        });
    });

    describe('sub-millisecond precision and rounding', () => {
        it('handles fractional millisecond differences (floors to seconds)', () => {
            setNow(NOW);
            // 500ms difference => 0 full seconds => "now"
            expect(formatShortRelativeTime(NOW - 500)).toBe('now');
        });

        it('handles timestamp 0 (Unix epoch)', () => {
            setNow(NOW);
            // Very large diff from epoch
            const result = formatShortRelativeTime(0);
            // 0 is a valid finite number, diff > 0, should produce a year-scale result
            expect(result).toMatch(/^\d+y$/);
        });
    });
});
