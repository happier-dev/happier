import { describe, expect, it } from 'vitest';
import { formatUsageCalendarDate, formatUsageCalendarRange, formatUsageChartClock, formatUsageDuration,
    formatUsageDurationCompact, formatUsageSharePercent, formatUsageUtcOffset, isUnattributedUsageAgentId } from './usageFormatting.js';

describe('shared Usage formatting', () => {
    it('keeps measured duration rounding and host-owned long/narrow unit labels', () => {
        const labels = {
            seconds: (seconds: number) => `${seconds} s`,
            minutes: (minutes: number) => `${minutes} min`,
            hours: (hours: number, minutes: number) => `${hours} h ${minutes} min`,
        };
        expect(formatUsageDuration(0, labels)).toBe('0 min');
        expect(formatUsageDuration(40_000, labels)).toBe('40 s');
        expect(formatUsageDuration(59_500, labels)).toBe('1 min');
        expect(formatUsageDuration(3_570_000, labels)).toBe('1 h 0 min');
        expect(formatUsageDuration(11_520_000, labels)).toBe('3 h 12 min');
        expect(formatUsageDurationCompact(0, 'en-US')).toBe('0m');
        expect(formatUsageDurationCompact(3_570_000, 'en-US')).toBe('1h');
        expect(formatUsageDurationCompact(11_520_000, 'en-US')).toBe('3h 12m');
        expect(formatUsageDurationCompact(40_000, 'fr-FR')).toBe(new Intl.NumberFormat('fr-FR', {
            style: 'unit', unit: 'second', unitDisplay: 'narrow',
        }).format(40));
    });

    it('formats the supplied fixed-offset calendar with an exclusive end and collapses one displayed day', () => {
        const date = (day: number) => new Intl.DateTimeFormat('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        }).format(Date.UTC(2026, 0, day));
        const startMs = Date.parse('2026-01-01T22:00:00Z');
        const oneDayEnd = Date.parse('2026-01-02T22:00:00Z');
        expect(formatUsageCalendarDate(startMs, 120, undefined, 'en-US')).toBe(date(2));
        expect(formatUsageCalendarRange(startMs, oneDayEnd, 120, 'en-US')).toBe(date(2));
        expect(formatUsageCalendarRange(startMs, oneDayEnd + 86_400_000, 120, 'en-US')).toBe(`${date(2)} – ${date(3)}`);
        expect(formatUsageCalendarRange(startMs, startMs, 120, 'en-US')).toBe(date(2));
        expect(formatUsageCalendarDate(Date.UTC(2026, 0, 2, 2), -330, undefined, 'en-US')).toBe(date(1));
    });

    it('retains the chart closing tick, fractional hours, share units and explicit fixed offsets', () => {
        expect(formatUsageChartClock(0)).toBe('00:00');
        expect(formatUsageChartClock(24)).toBe('24:00');
        expect(formatUsageChartClock(7.5)).toBe('07:30');
        expect(formatUsageSharePercent(0)).toBe('0%');
        expect(formatUsageSharePercent(0.245)).toBe('25%');
        expect(formatUsageUtcOffset(120)).toBe('UTC+02:00');
        expect(formatUsageUtcOffset(-330)).toBe('UTC−05:30');
    });

    it('identifies Usage bridge ids that mean the Agent was not attributed', () => {
        expect(['', 'unknown', 'legacy'].map(isUnattributedUsageAgentId)).toEqual([true, true, true]);
        expect(isUnattributedUsageAgentId('custom-acp')).toBe(false);
    });
});
