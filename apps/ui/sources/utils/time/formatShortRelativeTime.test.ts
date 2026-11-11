import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTimeOrAbsolute, formatRelativeTimeShort, formatShortRelativeTime, formatShortRelativeTimeAt, readRelativeTimeShortRefreshAtMs, readShortRelativeTimeRefreshAtMs } from './formatShortRelativeTime';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Fixed "now" anchor: 2025-06-15T12:00:00.000Z
const NOW = new Date('2025-06-15T12:00:00.000Z').getTime();

describe('compact localized age display boundaries', () => {
    it.each([[-10_000, 70_000], [30_000, 30_000], [90_000, 30_000], [61 * MINUTE, 59 * MINUTE],
        [25 * HOUR, 23 * HOUR]])('keeps age %sms until its next display boundary', (age, delay) => {
        const at = NOW - age;
        const boundary = readRelativeTimeShortRefreshAtMs(at, NOW);
        expect(boundary).toBe(NOW + delay);
        expect(formatRelativeTimeShort(at, boundary! - 1)).toBe(formatRelativeTimeShort(at, NOW));
        expect(formatRelativeTimeShort(at, boundary!)).not.toBe(formatRelativeTimeShort(at, NOW));
    });
    it('does not register a deadline for an invalid timestamp', () => {
        expect(readRelativeTimeShortRefreshAtMs(NaN, NOW)).toBeNull();
    });
});

describe('formatShortRelativeTime', () => {
    it('falls back to a date when RelativeTimeFormat is unavailable', () => {
        const original = Intl.RelativeTimeFormat;
        Object.defineProperty(Intl, 'RelativeTimeFormat', { configurable: true, value: undefined });
        try {
            expect(formatRelativeTimeOrAbsolute(NOW - DAY, -1, 'day', 'en-US')).toContain('Jun');
        } finally {
            Object.defineProperty(Intl, 'RelativeTimeFormat', { configurable: true, value: original });
        }
    });
    it.each([-SECOND, 30 * SECOND, 59 * MINUTE, 23 * HOUR, 6 * DAY, 34 * DAY,
        59 * DAY, 359 * DAY, 364 * DAY, 729 * DAY])('reports the exact next display change for age %s', age => {
        const at = NOW - age;
        const next = readShortRelativeTimeRefreshAtMs(at, NOW);
        expect(next).not.toBeNull();
        expect(next).toBeGreaterThan(NOW);
        expect(formatShortRelativeTimeAt(at, next! - 1)).toBe(formatShortRelativeTimeAt(at, NOW));
        expect(formatShortRelativeTimeAt(at, next!)).not.toBe(formatShortRelativeTimeAt(at, NOW));
    });
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

    it.each([
        ['10s in the future', NOW + 10_000],
        ['1ms in the future', NOW + 1],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
    ])('returns an empty label for a %s timestamp', (_name, timestamp) => {
        setNow(NOW);
        expect(formatShortRelativeTime(timestamp)).toBe('');
    });

    // Each band is pinned at its lower edge and its last value; thresholds are monotone, so a
    // threshold, floor-vs-round or interpolation regression moves one of these labels.
    it.each([
        [0, 'now'],
        [59 * SECOND + 999, 'now'],
        [60 * SECOND, '1m'],
        [59 * MINUTE + 59 * SECOND, '59m'],
        [60 * MINUTE, '1h'],
        [23 * HOUR + 59 * MINUTE, '23h'],
        [24 * HOUR, '1d'],
        [6 * DAY + 23 * HOUR, '6d'],
        [7 * DAY, '1w'],
        [34 * DAY, '4w'],
        [35 * DAY, '1mo'],
        [359 * DAY, '11mo'],
        [360 * DAY, '1y'],
        [364 * DAY, '1y'],
        [365 * DAY, '1y'],
        [730 * DAY, '2y'],
    ])('labels an age of %s ms as %s', (age, label) => {
        setNow(NOW);
        expect(formatShortRelativeTime(NOW - age)).toBe(label);
    });

    it('treats timestamp 0 (Unix epoch) as a valid year-scale age, not a missing one', () => {
        setNow(NOW);
        expect(formatShortRelativeTime(0)).toMatch(/^\d+y$/);
    });
});
