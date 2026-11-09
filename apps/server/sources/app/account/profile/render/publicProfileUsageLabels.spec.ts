import { describe, expect, it } from 'vitest';
import { PublicProfileViewV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { formatUsageCalendarRange } from '@happier-dev/protocol/usage/usageFormatting';
import { publicProfilePageLabels, PUBLIC_PROFILE_ASSET_LABELS, PUBLIC_PROFILE_LOCALE } from './publicProfileLabels';
import { publicProfileUsageLabels } from './publicProfileUsageLabels';

const view = PublicProfileViewV1Schema.parse({
    v: 1, handle: 'nadia', indexable: false, state: 'published', identity: {}, metadata: {},
    service: { displayName: 'Home', publicBaseUrl: 'https://profiles.example' },
    snapshot: { v: 1, computedAtMs: 1, period: { startMs: Date.UTC(2026, 0, 1, 22),
        endMs: Date.UTC(2026, 0, 2, 22), timeZoneOffsetMinutes: 120 },
        coverage: { status: 'unknown', method: 'unknown' }, fieldCoverage: {}, facts: {} },
    layout: { v: 1, items: [] }, appearance: { theme: 'auto', atmosphere: { source: 'none' } },
    urls: { page: 'https://profiles.example/@nadia', json: 'https://profiles.example/json',
        badgeBase: 'https://profiles.example/badge', card: 'https://profiles.example/card.svg',
        og: 'https://profiles.example/og.png', report: 'mailto:operator@example.test' },
});

describe('anonymous Usage chart labels', () => {
    it('says the range and how long ago it synced, in the owner preview words', () => {
        const range = formatUsageCalendarRange(view.snapshot.period.startMs, view.snapshot.period.endMs,
            view.snapshot.period.timeZoneOffsetMinutes, PUBLIC_PROFILE_LOCALE);
        expect(PUBLIC_PROFILE_ASSET_LABELS.period(view.snapshot.period)).toBe(range);
        const at = view.snapshot.computedAtMs;
        expect(publicProfilePageLabels(view, at + 30_000).periodDetail).toBe(`${range} · synced just now`);
        expect(publicProfilePageLabels(view, at + 2 * 3_600_000 + 5_000).periodDetail).toBe(`${range} · synced 2 hours ago`);
        expect(publicProfilePageLabels(view, at + 3 * 86_400_000).periodDetail).toBe(`${range} · synced 3 days ago`);
    });

    it('writes the Totals token figure as the owner preview does, compact', () => {
        const labels = publicProfileUsageLabels(view);
        expect(labels.original?.formatMetric('tokens', 1_148_055_254)).toBe('1.1B');
        expect(labels.original?.formatMetric('activeDays', 26)).toBe('26');
    });

    it('labels shared ordinal intensity as levels rather than manufacturing amounts', () => {
        const labels = publicProfileUsageLabels(view);
        expect(labels.weekTide?.peak(0, 23, 4)).toContain(labels.weekTide?.values.levelNames[4]);
        expect(labels.sky?.day('2026-01-02')).toBe('Fri, Jan 2');
        expect(labels.river?.values.formatTotal(1234)).toBe('—');
    });

    it('distinguishes unknown shares from measured zero, with measured durations and explicit English grouping', () => {
        const labels = publicProfileUsageLabels(view);
        expect(labels.daylight?.night(23, 7, null)).toBe('Night · 23:00–07:00');
        expect(labels.daylight?.night(23, 7, 0)).toBe('Night · 23:00–07:00 · 0%');
        expect(labels.runLength?.detail(59_500, 1234)).toBe('p90 1 min · 1,234');
        expect(labels.shipped?.countLine(1234)).toContain('1,234');
        expect(labels.records?.format('peakParallel', 1234).value.match(/[\d,]+/)?.[0]).toBe('1,234');
        expect(labels.records?.format('longestTurnMs', 59_500).value).toBe('1 min');
        expect(labels.records?.format('activeDays', 0).value.match(/\d+/)?.[0]).toBe('0');
    });

    it('says one day in the singular wherever a day count is spoken', () => {
        const labels = publicProfileUsageLabels(view);
        expect(labels.sky?.streakNow(1)).toBe('Now · 1 day');
        expect(labels.sky?.streakBest(2)).toBe('Best · 2 days');
        expect(labels.planet?.trailNote(1)).toBe('Lengthens toward the best this period, 1 day');
        expect(labels.crew?.days(1)).toBe('1 day');
        expect(labels.sky?.caption({ runs: false, band: false })).not.toMatch(/Faint lines|soft band/u);
        expect(labels.sky?.caption({ runs: true, band: true })).toContain('Faint lines join runs of five days or more; the soft band is the 7-day average.');
    });
});
