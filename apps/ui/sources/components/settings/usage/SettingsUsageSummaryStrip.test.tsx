import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';

function getNodeTextContent(node: unknown): string {
    if (node == null) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map((child) => getNodeTextContent(child)).join('');
    if (typeof node === 'object' && 'props' in node && node.props && typeof node.props === 'object' && 'children' in node.props) {
        return getNodeTextContent((node.props as { children?: unknown }).children);
    }
    return '';
}

const textMock = createTextModuleMock({
    translate: (key: string, params?: Record<string, unknown>) => {
        if (key === 'usage.banner.days' && typeof params?.count === 'number') {
            return `${params.count} days`;
        }
        if (key === 'usage.tokens') return 'Tokens';
        return key;
    },
});

vi.mock('@/text', () => textMock);

const DAY = 86_400_000;
const NOW = Date.now();

function iso(offsetDays: number): string {
    return new Date(NOW - offsetDays * DAY).toISOString().slice(0, 10);
}

const response: UsageAnalyticsQueryResponse = {
    v: 1,
    totals: {
        eventCount: 5,
        tokens: { input: 900_000, output: 300_000, reasoning: 0, cacheRead: 50_000, cacheWrite: 0, total: 1_250_000 },
        cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
    },
    series: [
        { bucketStartMs: NOW - 40 * DAY, bucketEndMs: NOW - 40 * DAY + DAY, eventCount: 2, tokens: { input: 200_000, output: 60_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 260_000 }, cost: { reportedUsd: 4, estimatedUsd: 3, currency: 'USD' } },
        { bucketStartMs: NOW - 5 * DAY, bucketEndMs: NOW - 5 * DAY + DAY, eventCount: 3, tokens: { input: 700_000, output: 240_000, reasoning: 0, cacheRead: 50_000, cacheWrite: 0, total: 990_000 }, cost: { reportedUsd: 8, estimatedUsd: 5, currency: 'USD' } },
    ],
    breakdowns: {
        model: [{ key: 'claude-fable-5', label: 'claude-fable-5', eventCount: 3, tokens: { input: 700_000, output: 240_000, reasoning: 0, cacheRead: 50_000, cacheWrite: 0, total: 990_000 }, cost: { reportedUsd: 8, estimatedUsd: 5, currency: 'USD' } }],
    },
    insights: {
        activeDays: 4,
        longestStreakDays: 6,
        sessionsUsed: 3,
        messagesUsed: 5,
        modelsTried: 2,
        favoriteModel: { key: 'claude-fable-5', label: 'claude-fable-5' },
        favoriteModelChangeCount: 1,
        busiestMonth: { key: '2024-04', label: 'Apr 2024' },
        busiestDay: { key: '2024-04-24', label: 'Wed' },
        busiestHour: { key: '13', label: '1 PM' },
    },
    activity: {
        calendarDays: [{ date: iso(0), eventCount: 2 }, { date: iso(1), eventCount: 3 }],
        weekdayHourBuckets: [{ weekday: 3, hour: 13, eventCount: 5 }],
    },
    leaders: {
        models: [{ key: 'claude-fable-5', label: 'claude-fable-5', eventCount: 3 }],
    },
    messageStats: { sessionCount: 3, messageCount: 5 },
};

function viewModel(): ReturnType<typeof buildUsageAnalyticsViewModel> {
    return buildUsageAnalyticsViewModel(response, { period: 'year', metric: 'tokens', focus: null, costMode: 'auto' });
}

describe('SettingsUsageSummaryStrip (usage banner)', () => {
    it('returns nothing when there is no usage data to show', async () => {
        const emptyResponse: UsageAnalyticsQueryResponse = {
            ...response,
            totals: { ...response.totals, eventCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            series: [],
            activity: { calendarDays: [], weekdayHourBuckets: [] },
            leaders: { models: [] },
            insights: { ...response.insights!, sessionsUsed: 0 },
            messageStats: { sessionCount: 0, messageCount: 0 },
        };
        const empty = buildUsageAnalyticsViewModel(emptyResponse, { period: 'year', metric: 'tokens', focus: null, costMode: 'auto' });
        const { SettingsUsageSummaryStrip } = await import('./SettingsUsageSummaryStrip');
        const screen = await renderScreen(<SettingsUsageSummaryStrip viewModel={empty} />);
        expect(screen.findAllByTestId('settings-usage-summary-strip')).toHaveLength(0);
    });

    it('shows a skeleton loading state (never a spinner or empty text)', async () => {
        const { SettingsUsageSummaryStrip } = await import('./SettingsUsageSummaryStrip');
        const screen = await renderScreen(<SettingsUsageSummaryStrip viewModel={null} isLoading />);
        expect(screen.findByTestId('settings-usage-summary-loading')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('usage.noData');
    });

    it('renders the five-cell stats row, the heatmap, and the two insight lists', async () => {
        const { SettingsUsageSummaryStrip } = await import('./SettingsUsageSummaryStrip');
        const screen = await renderScreen(<SettingsUsageSummaryStrip viewModel={viewModel()} />);

        expect(screen.findByTestId('settings-usage-summary-strip')).toBeTruthy();
        for (const id of [
            'usage-banner-stat-lifetime',
            'usage-banner-stat-peak',
            'usage-banner-stat-sessions',
            'usage-banner-stat-current-streak',
            'usage-banner-stat-longest-streak',
        ]) {
            expect(screen.findByTestId(id)).toBeTruthy();
        }
        expect(screen.findByTestId('usage-banner-heatmap')).toBeTruthy();
        expect(screen.findByTestId('usage-banner-activity-insights')).toBeTruthy();
        expect(screen.findByTestId('usage-banner-most-used')).toBeTruthy();

        expect(getNodeTextContent(screen.findByTestId('usage-banner-stat-lifetime'))).toContain('1.3M');
        expect(getNodeTextContent(screen.findByTestId('usage-banner-stat-longest-streak'))).toContain('6 days');
        expect(screen.getTextContent()).toContain('claude-fable-5');
    });

    it('navigates to the usage page when the stats area is pressed', async () => {
        const onOpenUsage = vi.fn();
        const { SettingsUsageSummaryStrip } = await import('./SettingsUsageSummaryStrip');
        const screen = await renderScreen(
            <SettingsUsageSummaryStrip viewModel={viewModel()} onOpenUsage={onOpenUsage} />,
        );
        screen.pressByTestId('settings-usage-summary-open-stats');
        expect(onOpenUsage).toHaveBeenCalledWith({
            pathname: '/settings/usage',
            params: { period: 'year', metric: 'tokens' },
        });
    });

    it('switches heatmap aggregation modes without crashing', async () => {
        const { SettingsUsageSummaryStrip } = await import('./SettingsUsageSummaryStrip');
        const screen = await renderScreen(<SettingsUsageSummaryStrip viewModel={viewModel()} />);
        screen.pressByTestId('usage-banner-heatmap-mode-weekly');
        screen.pressByTestId('usage-banner-heatmap-mode-cumulative');
        expect(screen.findByTestId('usage-banner-heatmap')).toBeTruthy();
    });
});
