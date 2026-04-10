import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { UsageAnalyticsDashboard } from './UsageAnalyticsDashboard';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import type { UsageDataPoint } from '@/sync/api/account/apiUsage';

const response: UsageAnalyticsQueryResponse = {
    v: 1,
    totals: {
        eventCount: 3,
        tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
        cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
    },
    series: [
        {
            bucketStartMs: 1_700_000_000_000,
            bucketEndMs: 1_700_086_400_000,
            eventCount: 1,
            tokens: { input: 50, output: 10, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 65 },
            cost: { reportedUsd: 6, estimatedUsd: 4, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
        },
        {
            bucketStartMs: 1_700_086_400_000,
            bucketEndMs: 1_700_172_800_000,
            eventCount: 2,
            tokens: { input: 40, output: 20, reasoning: 5, cacheRead: 5, cacheWrite: 0, total: 70 },
            cost: { reportedUsd: 6, estimatedUsd: 4, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
        },
    ],
    breakdowns: {
        provider: [{ key: 'anthropic', label: 'Anthropic', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
        model: [{ key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', eventCount: 2, tokens: { input: 80, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 125 }, cost: { reportedUsd: 11, estimatedUsd: 7, currency: 'USD' } }],
        session: [{ key: 'session-a', label: 'Session A', eventCount: 2, tokens: { input: 40, output: 20, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 65 }, cost: { reportedUsd: 6, estimatedUsd: 4, currency: 'USD' } }],
        project: [{ key: 'project-a', label: 'Project A', eventCount: 2, tokens: { input: 40, output: 20, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 65 }, cost: { reportedUsd: 6, estimatedUsd: 4, currency: 'USD' } }],
        workspace: [{ key: 'workspace-a', label: 'Workspace A', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
        backendMode: [{ key: 'claude:remote', label: 'Claude Remote', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
        source: [{ key: 'claude_sdk', label: 'Claude SDK', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
    },
    insights: {
        activeDays: 2,
        longestStreakDays: 2,
        sessionsUsed: 2,
        messagesUsed: 12,
        modelsTried: 2,
        favoriteModel: { key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
        favoriteModelChangeCount: 3,
        busiestMonth: { key: '2024-04', label: 'Apr 2024' },
        busiestDay: { key: '2024-04-25', label: 'Thu' },
        busiestHour: { key: '13', label: '1 PM' },
    },
    activity: {
        calendarDays: [
            { date: '2024-04-24', eventCount: 1 },
            { date: '2024-04-25', eventCount: 2 },
        ],
        weekdayHourBuckets: [
            { weekday: 4, hour: 13, eventCount: 2 },
            { weekday: 5, hour: 14, eventCount: 1 },
        ],
    },
    leaders: {
        providers: [{ key: 'anthropic', label: 'Anthropic', eventCount: 3 }],
        models: [{ key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', eventCount: 2 }],
        sessions: [{ key: 'session-a', label: 'Session A', eventCount: 2 }],
        projects: [{ key: 'project-a', label: 'Project A', eventCount: 2 }],
        workspaces: [{ key: 'workspace-a', label: 'Workspace A', eventCount: 3 }],
        engines: [{ key: 'claude:remote', label: 'Claude Remote', eventCount: 3 }],
    },
    messageStats: {
        sessionCount: 2,
        messageCount: 12,
    },
    costPresentation: {
        mode: 'reported',
        effectiveUsd: 12,
        currency: 'USD',
        source: 'provider_reported',
    },
};

describe('UsageAnalyticsDashboard', () => {
    it('renders usage analytics controls and drilldown rows', async () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '7days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });
        const onPeriodChange = vi.fn();
        const onMetricChange = vi.fn();
        const onFocusChange = vi.fn();
        const onCostModeChange = vi.fn();

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            filters: {
                period: '7days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange,
            onMetricChange,
            onFocusChange,
            onCostModeChange,
        }));

        expect(screen.getTextContent()).toContain('Total Tokens');
        expect(screen.getTextContent()).toContain('Total Cost');
        expect(screen.findByTestId('usage-costmode-auto')).toBeTruthy();
        expect(screen.findByTestId('usage-insights-section')).toBeTruthy();
        expect(screen.findByTestId('usage-activity-section')).toBeTruthy();
        expect(screen.findByTestId('usage-leaders-section')).toBeTruthy();
        expect(screen.findByTestId('usage-period-7days')).toBeTruthy();
        expect(screen.findByTestId('usage-metric-cost')).toBeTruthy();
        expect(screen.findByTestId('usage-costmode-reported')).toBeTruthy();
        expect(screen.findByTestId('usage-breakdown-row-provider-anthropic')).toBeTruthy();
        expect(screen.findByTestId('usage-breakdown-row-model-claude-3.7-sonnet')).toBeTruthy();

        screen.pressByTestId('usage-period-today');
        screen.pressByTestId('usage-metric-cost');
        screen.pressByTestId('usage-costmode-reported');
        screen.pressByTestId('usage-breakdown-row-model-claude-3.7-sonnet');

        expect(onPeriodChange).toHaveBeenCalledWith('today');
        expect(onMetricChange).toHaveBeenCalledWith('cost');
        expect(onCostModeChange).toHaveBeenCalledWith('reported');
        expect(onFocusChange).toHaveBeenCalledWith(expect.objectContaining({
            dimension: 'model',
            key: 'claude-3.7-sonnet',
        }));
    });

    it('does not render legacy bucket fallback rows when only compatibility bucket data is present', async () => {
        const legacyUsage: UsageDataPoint[] = [
            {
                timestamp: 1_700_000_000,
                tokens: { total: 100, input: 80, output: 20 },
                cost: { total: 1.5, input: 1.0, output: 0.5 },
                reportCount: 1,
                providerId: 'anthropic',
                modelId: 'claude-3.7-sonnet',
                sessionId: 'session-a',
                projectKey: 'project-a',
                workspaceKey: 'workspace-a',
            },
        ];
        const viewModel = buildUsageAnalyticsViewModel(legacyUsage, {
            period: '7days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });
        const bucketOnlyViewModel = {
            ...viewModel,
            breakdowns: {
                providers: [],
                models: [],
                sessions: [],
                projects: [],
                workspaces: [],
                backendModes: [],
                sources: [],
                buckets: viewModel.breakdowns.buckets,
            },
        };

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel: bucketOnlyViewModel,
            filters: {
                period: '7days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        expect(screen.findAllByTestId('usage-breakdown-row-bucket-input')).toHaveLength(0);
        expect(screen.findAllByTestId('usage-breakdown-row-bucket-output')).toHaveLength(0);
    });

    it('formats overview cost using the response currency', async () => {
        const eurResponse: UsageAnalyticsQueryResponse = {
            ...response,
            totals: {
                ...response.totals,
                cost: {
                    ...response.totals.cost,
                    currency: 'EUR',
                },
            },
            series: response.series?.map((bucket) => ({
                ...bucket,
                cost: {
                    ...bucket.cost,
                    currency: 'EUR',
                },
            })),
            breakdowns: {
                ...response.breakdowns,
                provider: response.breakdowns?.provider?.map((entry) => ({
                    ...entry,
                    cost: {
                        ...entry.cost,
                        currency: 'EUR',
                    },
                })),
            },
            costPresentation: {
                mode: response.costPresentation?.mode ?? 'reported',
                effectiveUsd: response.costPresentation?.effectiveUsd ?? 12,
                currency: 'EUR',
                source: response.costPresentation?.source ?? 'provider_reported',
            },
        };
        const viewModel = buildUsageAnalyticsViewModel(eurResponse, {
            period: '7days',
            metric: 'cost',
            focus: null,
            costMode: 'reported',
        });

        const screen = await renderScreen(React.createElement(UsageAnalyticsDashboard, {
            viewModel,
            filters: {
                period: '7days',
                metric: 'cost',
                focus: null,
                costMode: 'reported',
            },
            onPeriodChange: vi.fn(),
            onMetricChange: vi.fn(),
            onFocusChange: vi.fn(),
            onCostModeChange: vi.fn(),
        }));

        expect(screen.getTextContent()).toContain('€');
    });
});
