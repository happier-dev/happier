import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { renderScreen } from '@/dev/testkit';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { Heatmap, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { UsageDailyWidget } from './UsageDailyWidget';
import { UsageRhythmWidget } from './UsageRhythmWidget';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { readUsageCoverageGaps, UsageCoverageLine, usagePeriodPhrase } from './usageBodyKit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('shared Usage identity and dependent coverage', () => {
    it('keeps partial historical range gaps unavailable in the mounted Daily and Rhythm bodies', async () => {
        const start = Date.parse('2024-04-21T22:00:00Z');
        const end = start + 3 * 86_400_000;
        const query = normalizeUsageQuery({ period: { startMs: start, endMs: end }, timeZoneOffsetMinutes: 120, granularity: 'day', includeActivity: true });
        const tokens = { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 5 };
        const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { tokens, cost, eventCount: 1 },
            series: [{ bucketStartMs: start, bucketEndMs: start + 86_400_000, eventCount: 1, tokens, cost }],
            activity: { calendarDays: [{ date: '2024-04-22', eventCount: 1 }], weekdayHourBuckets: [] },
            coverage: { status: 'partial', reasons: ['incomplete_history'], sources: [], missingDimensions: [], ranked: [], range: { startMs: start, endMs: end, complete: false } },
        } }] }).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const props = { query, slice, model, serverId: 'home' };
        const screen = await renderScreen(<>
            <UsageDailyWidget {...props} id="usage_daily" testID="daily" />
            <UsageRhythmWidget {...props} id="usage_rhythm" testID="rhythm" />
        </>);
        expect(screen.findByType(StackedSeriesChart).props.series[0].points.map((point: { y: number | null }) => point.y)).toEqual([5, null, null]);
        const calendar = screen.findByType(Heatmap).props.cells;
        expect(calendar.map((cell: { id: string; value: number | null }) => [cell.id, cell.value])).toEqual([
            ['2024-04-22', 1], ['2024-04-23', null], ['2024-04-24', null],
        ]);
        // Language is presentation, not a new accounting response or query identity.
        const previous = getPreferredLanguage();
        try {
            setPreferredLanguageFromSettings('fr');
            await preloadTranslations();
            await act(async () => screen.update(<>
                <UsageDailyWidget {...props} id="usage_daily" testID="daily" />
                <UsageRhythmWidget {...props} id="usage_rhythm" testID="rhythm" />
            </>));
            expect(screen.findByType(StackedSeriesChart).props.series[0].points[0].label).toBe(new Intl.DateTimeFormat('fr', {
                month: 'short', day: 'numeric', timeZone: 'UTC',
            }).format(Date.parse('2024-04-22')));
            expect(screen.findByType(Heatmap).props.cells[0].label).toBe(new Intl.DateTimeFormat('fr', {
                month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
            }).format(Date.parse('2024-04-22')));
        } finally {
            setPreferredLanguageFromSettings(previous);
            await preloadTranslations();
        }
    });
    it('preserves an explicit epoch start instead of converting it to an unbounded all-time query', () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, timeZoneOffsetMinutes: 0 });
        expect(resolveUsageShownCalendarRange(query)?.startMs).toBe(0);
        expect(usagePeriodPhrase(query)).toBe(new Intl.DateTimeFormat(getPreferredLanguage(), {
            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        }).format(0));
    });
    it('labels an end-only historical query through its exclusive endpoint in the admitted offset', () => {
        const query = normalizeUsageQuery({ period: { endMs: Date.parse('2024-04-22T22:00:00Z') }, timeZoneOffsetMinutes: 120 });
        const end = new Intl.DateTimeFormat(getPreferredLanguage(), {
            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        }).format(Date.parse('2024-04-22'));
        expect(usagePeriodPhrase(query)).toBe(`${t('usage.allTime')} – ${end}`);
        expect(usagePeriodPhrase(normalizeUsageQuery({ period: {} }))).toBe(t('usage.allTime'));
    });
    it('uses the selected French app locale and admitted offset, not the host locale', async () => {
        const previous = getPreferredLanguage();
        try {
            setPreferredLanguageFromSettings('fr');
            await preloadTranslations();
            const query = normalizeUsageQuery({ period: { startMs: Date.parse('2024-04-21T22:00:00Z'), endMs: Date.parse('2024-04-22T22:00:00Z') }, timeZoneOffsetMinutes: 120 });
            expect(usagePeriodPhrase(query)).toBe(new Intl.DateTimeFormat('fr', {
                month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
            }).format(Date.parse('2024-04-22')));
        } finally {
            setPreferredLanguageFromSettings(previous);
            await preloadTranslations();
        }
    });
    it('labels a historical custom range by exact dates instead of a rolling nearest preset', () => {
        const query = normalizeUsageQuery({ period: { startMs: Date.UTC(2024, 3, 21, 22), endMs: Date.UTC(2024, 4, 2, 22) }, timeZoneOffsetMinutes: 120 });
        const label = usagePeriodPhrase(query);
        const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        expect(label).toBe(`${date.format(new Date(Date.UTC(2024, 3, 22)))} – ${date.format(new Date(Date.UTC(2024, 4, 2)))}`);
    });
    it('exposes incomplete native history and unsupported sources even with available accounting transport', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { tokens: { total: 5, input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' }, eventCount: 1 },
            coverage: { status: 'partial', reasons: ['incomplete_history', 'unknown_token_categories'], sources: [
                { source: 'native:claude', path: 'native', status: 'partial', eventCount: 1, historyComplete: false },
                { source: 'native:gemini', path: 'native', status: 'unsupported', eventCount: 0 },
            ], missingDimensions: [], range: { startMs: 0, endMs: 1000, complete: false }, ranked: [] },
        } }] }).results[0]!;
        expect(readUsageCoverageGaps(slice, ['accounting']).map(gap => gap.source)).toEqual(['accounting', 'native:claude', 'native:gemini']);
        const screen = await renderScreen(<UsageCoverageLine slice={slice} sources={['accounting']} testID="coverage" />);
        expect(screen.getTextContent()).toContain('native:claude');
        expect(screen.getTextContent()).toContain('native:gemini');
        expect(screen.getTextContent()).toContain(t('usage.board.page.coverageReason_unknown_token_categories'));
        expect(screen.getTextContent()).toContain(t('usage.board.page.coverageReason_incomplete_history'));
        expect(screen.getTextContent()).toContain(t('usage.board.sources.unsupported'));
    });
    it('does not treat an available transport without coverage metadata as complete history', () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { tokens: { total: 5, input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' }, eventCount: 1 },
        } }] }).results[0]!;
        expect(readUsageCoverageGaps(slice, ['accounting'])).toEqual([{ source: 'accounting', status: 'unknown' }]);
    });
});
