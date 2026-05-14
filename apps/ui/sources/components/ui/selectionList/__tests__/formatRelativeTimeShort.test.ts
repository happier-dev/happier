import { describe, expect, it } from 'vitest';

import { formatRelativeTimeShort } from '../formatRelativeTimeShort';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelativeTimeShort', () => {
    const now = 1_700_000_000_000;

    it('returns "now" within the first minute', () => {
        expect(formatRelativeTimeShort(now - 0, now)).toBe('now');
        expect(formatRelativeTimeShort(now - 30_000, now)).toBe('now');
        expect(formatRelativeTimeShort(now - (MIN - 1), now)).toBe('now');
    });

    it('returns Nm ago between 1m and 59m', () => {
        expect(formatRelativeTimeShort(now - MIN, now)).toBe('1m ago');
        expect(formatRelativeTimeShort(now - 5 * MIN, now)).toBe('5m ago');
        expect(formatRelativeTimeShort(now - 59 * MIN, now)).toBe('59m ago');
    });

    it('returns Nh ago between 1h and 23h', () => {
        expect(formatRelativeTimeShort(now - HOUR, now)).toBe('1h ago');
        expect(formatRelativeTimeShort(now - 2 * HOUR, now)).toBe('2h ago');
        expect(formatRelativeTimeShort(now - 23 * HOUR, now)).toBe('23h ago');
    });

    it('returns Nd ago between 1d and 13d', () => {
        expect(formatRelativeTimeShort(now - DAY, now)).toBe('1d ago');
        expect(formatRelativeTimeShort(now - 13 * DAY, now)).toBe('13d ago');
    });

    it('returns Nd ago at the 14d boundary and beyond', () => {
        expect(formatRelativeTimeShort(now - 14 * DAY, now)).toBe('14d ago');
        expect(formatRelativeTimeShort(now - 365 * DAY, now)).toBe('365d ago');
    });

    it('clamps future timestamps to "now" (defensive against clock skew)', () => {
        expect(formatRelativeTimeShort(now + 5_000, now)).toBe('now');
    });
});
