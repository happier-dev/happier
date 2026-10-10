import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { Heatmap } from '@happier-dev/plugin-ui/presentation';

import { renderScreen } from '@/dev/testkit';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { lightTheme } from '@/theme';
import { usageActivityGridPresentation, usageHeatmapPresentation } from './usageGridPresentation';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings } from '@/text';
import { formatUsageWeekdayHourLabel } from '@/sync/api/account/formatUsageRhythmLabel';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { createUsageHourRhythmSeries } from './usageSeriesPresentation';

describe('recap activity matrix facts', () => {
    it('keeps recap activity and rhythm labels in the selected locale and explicit calendar', async () => {
        const previous = getPreferredLanguage();
        try {
            setPreferredLanguageFromSettings('fr');
            await preloadTranslations();
            const start = Date.UTC(2026, 8, 27, 12);
            const facts = usageActivityGridPresentation([{ timestamp: start, active: true, tokens: 1, cost: 0 }], '#ff8800', '#fff', 1, 1, 840);
            expect(facts.cells[0]!.label).toBe(new Intl.DateTimeFormat('fr', {
                month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
            }).format(Date.UTC(2026, 8, 28)));
            const weekday = new Intl.DateTimeFormat('fr', { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 8));
            const hour = new Intl.DateTimeFormat('fr', { hour: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1, 8));
            expect(formatUsageWeekdayHourLabel(1, 8)).toBe(`${weekday} · ${hour}`);
            const view = buildUsageAnalyticsViewModel([{ timestamp: Date.UTC(2024, 0, 8, 8) / 1000,
                tokens: { total: 1 }, cost: { total: 0 }, reportCount: 1 }],
                { period: 'all', metric: 'tokens', costMode: 'auto', focus: null }, 0);
            expect(createUsageHourRhythmSeries(view.hourRhythm, '#ff8800')[0]!.points.find(point => point.x === 8)?.label).toBe(hour);
        } finally {
            setPreferredLanguageFromSettings(previous);
            await preloadTranslations();
        }
    });
    it('keeps a historical custom range in its own calendar with unavailable unobserved days', () => {
        const startMs = Date.UTC(2024, 3, 21, 22);
        const facts = usageHeatmapPresentation({ calendarDays: [{ date: '2024-04-22', eventCount: 7 }], mode: 'daily',
            range: { startMs, endMs: startMs + 3 * 86_400_000, granularity: 'day', timeZoneOffsetMinutes: 120 },
            accentColor: '#ff8800', emptyColor: '#ffffff' });
        expect(facts.cells.map(cell => cell.id)).toEqual(['2024-04-22', '2024-04-23', '2024-04-24']);
        expect(facts.cells.map(cell => cell.value)).toEqual([7, null, null]);
        expect(facts.cells.every(cell => !cell.emphasized)).toBe(true);
    });
    it('preserves exact measured zero, unavailable history and positive outlier tones', async () => {
        const facts = usageActivityGridPresentation([0, 1, 2, 3, 4, 5, 1_000].map((tokens, index) => ({ timestamp: index + 1, active: true, tokens, cost: 0 })), '#ff8800', '#ffffff');
        expect(new Set(facts.cells.filter(cell => cell.value !== null && cell.value > 0).map(cell => cell.color)).size).toBeGreaterThanOrEqual(3);
        const screen = await renderScreen(<Heatmap theme={projectPluginUiTheme(lightTheme)} {...facts} unknownLabel="Unavailable" testID="matrix" />);
        expect(screen.findByTestId('matrix-cell-unavailable:0')?.props.accessibilityLabel).toContain('Unavailable');
        expect(screen.findByTestId('matrix-cell-1')?.props.accessibilityLabel).toContain(': 0');
        expect(screen.findByTestId('matrix-cell-7')?.props.accessibilityLabel).toContain('1,000');
    });
});
