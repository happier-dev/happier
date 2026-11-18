import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTimeOrAbsolute, formatRelativeTimeShort, formatShortRelativeTime, formatShortRelativeTimeAt, readRelativeTimeShortRefreshAtMs, readShortRelativeTimeRefreshAtMs } from './formatShortRelativeTime';
import { preloadTranslationsForSettings, setPreferredLanguageFromSettings } from '@/text/i18n';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Fixed "now" anchor: 2025-06-15T12:00:00.000Z
const NOW = new Date('2025-06-15T12:00:00.000Z').getTime();

describe('compact localized age display boundaries', () => {
    // Minute and hour ages change on the wall-clock minute (one shared wake for every due label); days stay exact.
    it.each([[-10_000, 2 * MINUTE, MINUTE], [30_000, MINUTE, MINUTE], [90_000, MINUTE, MINUTE], [61 * MINUTE, 59 * MINUTE, MINUTE],
        [25 * HOUR, 23 * HOUR, 1]])('keeps age %sms until its next display boundary', (age, delay, granularity) => {
        const at = NOW - age;
        const boundary = readRelativeTimeShortRefreshAtMs(at, NOW);
        expect(boundary).toBe(NOW + delay);
        expect(boundary! % granularity).toBe(0);
        expect(formatRelativeTimeShort(at, boundary! - granularity)).toBe(formatRelativeTimeShort(at, NOW));
        expect(formatRelativeTimeShort(at, boundary!)).not.toBe(formatRelativeTimeShort(at, NOW));
    });
    it('does not register a deadline for an invalid timestamp', () => {
        expect(readRelativeTimeShortRefreshAtMs(NaN, NOW)).toBeNull();
    });
});

describe('formatShortRelativeTime', () => {
    it('localizes Run column ages through the shared compact formatter', async () => {
        await preloadTranslationsForSettings('de');
        setPreferredLanguageFromSettings('de');
        try {
            expect(formatShortRelativeTimeAt(NOW, NOW)).toBe('jetzt');
            expect(formatShortRelativeTimeAt(NOW - 4 * MINUTE, NOW)).toBe('4min');
            expect(formatShortRelativeTimeAt(NOW - 2 * DAY, NOW)).toBe('2T');
            expect(formatShortRelativeTimeAt(NOW - 14 * DAY, NOW)).toBe('2W');
        } finally { setPreferredLanguageFromSettings(null); }
    });
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
        59 * DAY, 359 * DAY, 364 * DAY, 729 * DAY])('reports the next display change for age %s', age => {
        const at = NOW - age;
        const next = readShortRelativeTimeRefreshAtMs(at, NOW);
        // Future, day and longer labels change at their exact instant; minute and hour labels on the wall-clock minute.
        const granularity = age < 0 || age >= DAY ? 1 : MINUTE;
        expect(next).not.toBeNull();
        expect(next).toBeGreaterThan(NOW);
        expect(next! % granularity).toBe(0);
        expect(formatShortRelativeTimeAt(at, next! - granularity)).toBe(formatShortRelativeTimeAt(at, NOW));
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
