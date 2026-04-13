import { describe, expect, it } from 'vitest';
import { buildUsageAnalyticsSummaryViewModel, buildUsageAnalyticsViewModel, type UsageFilterState } from './usageAnalytics';
import type { UsageDataPoint } from './apiUsage';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';

const baseState: UsageFilterState = {
    period: '7days',
    metric: 'tokens',
    focus: null,
    costMode: 'auto',
};

describe('buildUsageAnalyticsViewModel', () => {
    it('aggregates explicit totals and groups drilldowns by provider, model, session, project, and workspace', () => {
        const usage: UsageDataPoint[] = [
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
            {
                timestamp: 1_700_086_400,
                tokens: { total: 50, input: 30, output: 20 },
                cost: { total: 0.4, input: 0.25, output: 0.15 },
                reportCount: 2,
                providerId: 'anthropic',
                modelId: 'claude-3.7-sonnet',
                sessionId: 'session-b',
                projectKey: 'project-b',
                workspaceKey: 'workspace-a',
            },
            {
                timestamp: 1_700_172_800,
                tokens: { input: 10, output: 5 },
                cost: { input: 0.05, output: 0.10 },
                reportCount: 1,
                providerId: 'openai',
                modelId: 'gpt-5',
                sessionId: 'session-c',
                projectKey: 'project-a',
                workspaceKey: 'workspace-a',
            },
        ];

        const viewModel = buildUsageAnalyticsViewModel(usage, baseState);

        expect(viewModel.overview.totalTokens).toBe(165);
        expect(viewModel.overview.totalCost).toBeCloseTo(2.05);
        expect(viewModel.overview.reportCount).toBe(4);
        expect(viewModel.overview.activeDays).toBe(3);
        expect(viewModel.breakdowns.models.map((row) => row.key)).toEqual(['claude-3.7-sonnet', 'gpt-5']);
        expect(viewModel.breakdowns.models[0]).toMatchObject({
            totalTokens: 150,
            totalCost: 1.9,
            reportCount: 3,
        });
        expect(viewModel.breakdowns.providers.map((row) => row.key)).toEqual(['anthropic', 'openai']);
        expect(viewModel.breakdowns.sessions.map((row) => row.key)).toEqual(['session-a', 'session-b', 'session-c']);
        expect(viewModel.breakdowns.projects.map((row) => row.key)).toEqual(['project-a', 'project-b']);
        expect(viewModel.breakdowns.workspaces.map((row) => row.key)).toEqual(['workspace-a']);
        expect(viewModel.breakdowns.buckets.some((row) => row.key === 'input')).toBe(true);
        expect(viewModel.breakdowns.buckets.some((row) => row.key === 'output')).toBe(true);
    });

    it('filters all derived analytics to the selected drilldown focus', () => {
        const usage: UsageDataPoint[] = [
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
            {
                timestamp: 1_700_086_400,
                tokens: { total: 50, input: 30, output: 20 },
                cost: { total: 0.4, input: 0.25, output: 0.15 },
                reportCount: 2,
                providerId: 'anthropic',
                modelId: 'claude-3.7-sonnet',
                sessionId: 'session-b',
                projectKey: 'project-b',
                workspaceKey: 'workspace-a',
            },
        ];

        const viewModel = buildUsageAnalyticsViewModel(usage, {
            ...baseState,
            focus: {
                dimension: 'project',
                key: 'project-b',
                label: 'Project B',
            },
        });

        expect(viewModel.overview.totalTokens).toBe(50);
        expect(viewModel.overview.totalCost).toBeCloseTo(0.4);
        expect(viewModel.overview.reportCount).toBe(2);
        expect(viewModel.breakdowns.projects.map((row) => row.key)).toEqual(['project-b']);
        expect(viewModel.breakdowns.models.map((row) => row.key)).toEqual(['claude-3.7-sonnet']);
        expect(viewModel.trend).toHaveLength(1);
    });

    it('maps v2 analytics responses into summary, insights, activity, and leaders sections', () => {
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
                backendMode: [{ key: 'google:gemini/remote', label: 'google:gemini/remote', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
                source: [{ key: 'claude_sdk', label: 'claude_sdk', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
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
                engines: [{ key: 'google:gemini/remote', label: 'google:gemini/remote', eventCount: 3 }],
            },
            modelTimeline: [
                {
                    bucketStartMs: 1_700_000_000_000,
                    bucketEndMs: 1_700_086_400_000,
                    leaders: [
                        {
                            key: 'claude-3.7-sonnet',
                            label: 'Claude 3.7 Sonnet',
                            eventCount: 2,
                            tokens: { input: 80, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 125 },
                            cost: { reportedUsd: 11, estimatedUsd: 7, currency: 'USD' },
                        },
                    ],
                },
            ],
            engineTimeline: [
                {
                    bucketStartMs: 1_700_000_000_000,
                    bucketEndMs: 1_700_086_400_000,
                    leaders: [
                        {
                            key: 'google:gemini/remote',
                            label: 'google:gemini/remote',
                            eventCount: 3,
                            tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
                            cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' },
                        },
                    ],
                },
            ],
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

        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'cost',
            focus: null,
            costMode: 'reported',
        });

        expect(viewModel.costPresentation.mode).toBe('reported');
        expect(viewModel.insights.activeDays).toBe(2);
        expect(viewModel.insights.favoriteModel?.label).toBe('Claude 3.7 Sonnet');
        expect(viewModel.activity.calendarDays).toHaveLength(2);
        expect(viewModel.leaders.engines[0].label).toBe('Google Gemini Remote');
        expect(viewModel.breakdowns.backendModes[0]?.label).toBe('Google Gemini Remote');
        expect(viewModel.breakdowns.sources[0]?.label).toBe('Claude SDK');
        expect(viewModel.leaders.models[0].eventCount).toBe(2);
        expect(viewModel.modelTimeline[0].leaders[0].totalCost).toBe(11);
        expect(viewModel.engineTimeline[0].leaders[0].label).toBe('Google Gemini Remote');
        expect(viewModel.engineTimeline[0].leaders[0].totalCost).toBe(12);

        const estimatedViewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'cost',
            focus: null,
            costMode: 'estimated',
        });
        expect(estimatedViewModel.modelTimeline[0].leaders[0].totalCost).toBe(7);
        expect(estimatedViewModel.engineTimeline[0].leaders[0].totalCost).toBe(8);

        const summary = buildUsageAnalyticsSummaryViewModel(response);
        expect(summary.topEngine?.label).toBe('Google Gemini Remote');
        expect(summary.busiestWindowLabel).toBe('Thu · 2 PM');
    });

    it('deduplicates repeated engine label tokens when backend and provider names overlap', () => {
        const response: UsageAnalyticsQueryResponse = {
            v: 1,
            totals: {
                eventCount: 1,
                tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                cost: { reportedUsd: 4, estimatedUsd: 3, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
            },
            series: [],
            breakdowns: {
                provider: [],
                model: [],
                session: [],
                project: [],
                workspace: [],
                backendMode: [
                    {
                        key: 'codex:codex-app-server',
                        label: 'codex:codex-app-server',
                        eventCount: 1,
                        tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                        cost: { reportedUsd: 4, estimatedUsd: 3, currency: 'USD' },
                    },
                ],
                source: [],
            },
            insights: {
                activeDays: 1,
                longestStreakDays: 1,
                sessionsUsed: 1,
                messagesUsed: 1,
                modelsTried: 1,
                favoriteModel: undefined,
                favoriteModelChangeCount: 0,
                busiestMonth: undefined,
                busiestDay: undefined,
                busiestHour: undefined,
            },
            activity: {
                calendarDays: [],
                weekdayHourBuckets: [],
            },
            leaders: {
                providers: [],
                models: [],
                sessions: [],
                projects: [],
                workspaces: [],
                engines: [
                    {
                        key: 'codex:codex-app-server',
                        label: 'codex:codex-app-server',
                        eventCount: 1,
                    },
                ],
            },
            modelTimeline: [],
            engineTimeline: [
                {
                    bucketStartMs: 1_700_000_000_000,
                    bucketEndMs: 1_700_086_400_000,
                    leaders: [
                        {
                            key: 'codex:codex-app-server',
                            label: 'codex:codex-app-server',
                            eventCount: 1,
                            tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                            cost: { reportedUsd: 4, estimatedUsd: 3, currency: 'USD' },
                        },
                    ],
                },
            ],
            messageStats: {
                sessionCount: 1,
                messageCount: 1,
            },
            costPresentation: {
                mode: 'reported',
                effectiveUsd: 4,
                currency: 'USD',
                source: 'provider_reported',
            },
        };

        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        expect(viewModel.breakdowns.backendModes[0]?.label).toBe('Codex App Server');
        expect(viewModel.leaders.engines[0]?.label).toBe('Codex App Server');
        expect(viewModel.engineTimeline[0]?.leaders[0]?.label).toBe('Codex App Server');
    });

    it('falls back to derived cost presentation fields when an older server returns a partial costPresentation object', () => {
        const response: UsageAnalyticsQueryResponse = {
            v: 1,
            totals: {
                eventCount: 1,
                tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 120 },
                cost: { reportedUsd: 0, estimatedUsd: 0.19, currency: 'USD', costSource: 'none', billingContext: 'unknown' },
            },
            series: [
                {
                    bucketStartMs: 1_700_000_000_000,
                    bucketEndMs: 1_700_086_400_000,
                    eventCount: 1,
                    tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 120 },
                    cost: { reportedUsd: 0, estimatedUsd: 0.19, currency: 'USD', costSource: 'none', billingContext: 'unknown' },
                },
            ],
            breakdowns: {
                provider: [],
                model: [],
                session: [],
                project: [],
                workspace: [],
                backendMode: [],
                source: [],
            },
            insights: {
                activeDays: 1,
                longestStreakDays: 1,
                sessionsUsed: 1,
                messagesUsed: 1,
                modelsTried: 1,
                favoriteModel: undefined,
                favoriteModelChangeCount: 0,
                busiestMonth: undefined,
                busiestDay: undefined,
                busiestHour: undefined,
            },
            activity: {
                calendarDays: [{ date: '2026-04-11', eventCount: 1 }],
                weekdayHourBuckets: [],
            },
            leaders: {
                providers: [],
                models: [],
                sessions: [],
                projects: [],
                workspaces: [],
                engines: [],
            },
            modelTimeline: [],
            engineTimeline: [],
            messageStats: {
                sessionCount: 1,
                messageCount: 1,
            },
            costPresentation: {
                mode: 'auto',
                effectiveUsd: 0.19,
                source: 'none',
            } as UsageAnalyticsQueryResponse['costPresentation'],
        };

        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        expect(viewModel.costPresentation.mode).toBe('auto');
        expect(viewModel.costPresentation.currency).toBe('USD');
        expect(viewModel.costPresentation.effectiveUsd).toBeCloseTo(0.19);
    });

    it('uses the selected cost mode consistently for overview and breakdown totals', () => {
        const response: UsageAnalyticsQueryResponse = {
            v: 1,
            totals: {
                eventCount: 2,
                tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                cost: { reportedUsd: 0, estimatedUsd: 9, currency: 'USD' },
            },
            breakdowns: {
                provider: [
                    {
                        key: 'openai',
                        label: 'OpenAI',
                        eventCount: 2,
                        tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                        cost: { reportedUsd: 0, estimatedUsd: 9, currency: 'USD' },
                    },
                ],
            },
        };

        const reported = buildUsageAnalyticsViewModel(response, {
            period: '7days',
            metric: 'cost',
            focus: null,
            costMode: 'reported',
        });
        expect(reported.overview.totalCost).toBe(0);
        expect(reported.breakdowns.providers[0]?.totalCost).toBe(0);

        const estimated = buildUsageAnalyticsViewModel(response, {
            period: '7days',
            metric: 'cost',
            focus: null,
            costMode: 'estimated',
        });
        expect(estimated.overview.totalCost).toBe(9);
        expect(estimated.breakdowns.providers[0]?.totalCost).toBe(9);
    });

    it('keeps legacy fallback cost modes honest by exposing only auto when reported and estimated are synthesized from the same total', () => {
        const usage: UsageDataPoint[] = [
            {
                timestamp: 1_700_000_000,
                tokens: { total: 100, input: 80, output: 20 },
                cost: { total: 1.5, input: 1.0, output: 0.5 },
                reportCount: 1,
            },
        ];

        const viewModel = buildUsageAnalyticsViewModel(usage, baseState);

        expect(viewModel.availableCostModes).toEqual(['auto']);
        expect(viewModel.costPresentation.mode).toBe('auto');
        expect(viewModel.costPresentation.source).toBe('legacy_total_synthesized');
    });

    it('maps model and engine timelines into the premium dashboard view model', () => {
        const response: UsageAnalyticsQueryResponse = {
            v: 1,
            totals: {
                eventCount: 2,
                tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                cost: { reportedUsd: 4, estimatedUsd: 3, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
            },
            modelTimeline: [
                {
                    bucketStartMs: 1_700_000_000_000,
                    bucketEndMs: 1_700_086_400_000,
                    leaders: [
                        { key: 'gpt-5', label: 'GPT-5', eventCount: 2, tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 }, cost: { reportedUsd: 4, estimatedUsd: 3, currency: 'USD' } },
                    ],
                },
            ],
            engineTimeline: [
                {
                    bucketStartMs: 1_700_000_000_000,
                    bucketEndMs: 1_700_086_400_000,
                    leaders: [
                        { key: 'codex:app-server', label: 'Codex App Server', eventCount: 2, tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 }, cost: { reportedUsd: 4, estimatedUsd: 3, currency: 'USD' } },
                    ],
                },
            ],
        };

        const viewModel = buildUsageAnalyticsViewModel(response, baseState);

        expect(viewModel.modelTimeline).toHaveLength(1);
        expect(viewModel.modelTimeline[0]?.leaders[0]?.label).toBe('GPT-5');
        expect(viewModel.engineTimeline).toHaveLength(1);
        expect(viewModel.engineTimeline[0]?.leaders[0]?.label).toBe('Codex App Server');
    });

    it('uses only the trailing consecutive active run for the legacy summary streak', () => {
        const legacyUsage: UsageDataPoint[] = [
            {
                timestamp: 1_700_000_000,
                tokens: { total: 40 },
                cost: { total: 2 },
                reportCount: 1,
            },
            {
                timestamp: 1_700_086_400,
                tokens: { total: 0 },
                cost: { total: 0 },
                reportCount: 0,
            },
            {
                timestamp: 1_700_172_800,
                tokens: { total: 30 },
                cost: { total: 1.5 },
                reportCount: 1,
            },
            {
                timestamp: 1_700_259_200,
                tokens: { total: 20 },
                cost: { total: 1 },
                reportCount: 1,
            },
        ];

        const summary = buildUsageAnalyticsSummaryViewModel(legacyUsage);

        expect(summary.currentStreakDays).toBe(2);
    });

    it('sorts legacy usage before computing the trailing streak', () => {
        const legacyUsage: UsageDataPoint[] = [
            {
                timestamp: 1_700_172_800,
                tokens: { total: 30 },
                cost: { total: 1.5 },
                reportCount: 1,
            },
            {
                timestamp: 1_700_000_000,
                tokens: { total: 40 },
                cost: { total: 2 },
                reportCount: 1,
            },
            {
                timestamp: 1_700_259_200,
                tokens: { total: 20 },
                cost: { total: 1 },
                reportCount: 1,
            },
            {
                timestamp: 1_700_086_400,
                tokens: { total: 0 },
                cost: { total: 0 },
                reportCount: 0,
            },
        ];

        const viewModel = buildUsageAnalyticsViewModel(legacyUsage, baseState);

        expect(viewModel.insights.currentStreakDays).toBe(2);
    });

    it('preserves invoice-aware auto cost presentation from the server response', () => {
        const response: UsageAnalyticsQueryResponse = {
            v: 1,
            totals: {
                eventCount: 1,
                tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
                cost: {
                    reportedUsd: 4,
                    estimatedUsd: 3,
                    invoiceUsd: 2,
                    currency: 'USD',
                    costSource: 'provider_reported',
                    billingContext: 'api_usage',
                },
            },
            costPresentation: {
                mode: 'auto',
                effectiveUsd: 2,
                currency: 'USD',
                source: 'invoice',
            },
        };

        const viewModel = buildUsageAnalyticsViewModel(response, baseState);

        expect(viewModel.costPresentation).toEqual({
            mode: 'auto',
            effectiveUsd: 2,
            currency: 'USD',
            source: 'invoice',
        });
        expect(viewModel.overview.totalCost).toBe(2);
    });
});
