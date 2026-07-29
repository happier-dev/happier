import { describe, expect, it, vi } from 'vitest';
import {
    buildUsageAgentTrends,
    buildUsageAnalyticsSummaryViewModel,
    buildUsageAnalyticsViewModel,
    buildUsageComposition,
    buildUsageEfficiency,
    buildUsageHourRhythm,
    buildUsageLeaderTrend,
    buildUsageModelMix,
    buildUsagePivotView,
    buildUsagePunchCard,
    buildUsageTrendDelta,
    buildUsageWeeksBreakdown,
    resolveSessionsUsed,
    selectUsageBreakdownRows,
    USAGE_MODEL_MIX_OTHER_KEY,
    type UsageAnalyticsTimelineBucket,
    type UsageBreakdownRow,
    type UsageBreakdownSections,
    type UsageFilterState,
    type UsageLeaderTrends,
    type UsageTrendPoint,
} from './usageAnalytics';
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
        expect(viewModel.breakdowns.agents.map((row) => row.key)).toEqual(['anthropic', 'openai']);
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
                agent: [{ key: 'anthropic', label: 'Anthropic', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
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
                cacheSavingsUsd: 1.25,
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
                agents: [{ key: 'anthropic', label: 'Anthropic', eventCount: 3 }],
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
        expect(viewModel.cacheSavings).toEqual({ cachedReadTokens: 5, cacheSavingsUsd: 1.25 });
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

    it('preserves server-computed effective cost for mixed-provenance auto responses', () => {
        const mixedCost = {
            reportedUsd: 0.12,
            estimatedUsd: 0.29,
            effectiveUsd: 0.32,
            currency: 'USD',
        } as const;
        const response: UsageAnalyticsQueryResponse = {
            v: 1,
            totals: {
                eventCount: 2,
                tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                cost: mixedCost,
            },
            series: [{
                bucketStartMs: 1_700_000_000_000,
                bucketEndMs: 1_700_086_400_000,
                eventCount: 2,
                tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                cost: mixedCost,
            }],
            breakdowns: {
                agent: [{
                    key: 'mixed-provider',
                    eventCount: 2,
                    tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                    cost: mixedCost,
                }],
            },
            modelTimeline: [{
                bucketStartMs: 1_700_000_000_000,
                bucketEndMs: 1_700_086_400_000,
                leaders: [{
                    key: 'mixed-model',
                    eventCount: 2,
                    tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                    cost: mixedCost,
                }],
            }],
            costPresentation: {
                mode: 'auto',
                effectiveUsd: 0.32,
                currency: 'USD',
                source: 'provider_reported_api_equivalent',
            },
        };

        const viewModel = buildUsageAnalyticsViewModel(response, baseState);

        expect(viewModel.overview.totalCost).toBeCloseTo(0.32);
        expect(viewModel.trend[0]?.cost).toBeCloseTo(0.32);
        expect(viewModel.breakdowns.agents[0]?.totalCost).toBeCloseTo(0.32);
        expect(viewModel.modelTimeline[0]?.leaders[0]?.totalCost).toBeCloseTo(0.32);
    });

    it('does not treat sparse older 30-day buckets as current-week summary usage', () => {
        const nowMs = 1_800_000_000_000;
        const dayMs = 86_400_000;
        const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const response: UsageAnalyticsQueryResponse = {
            v: 1,
            totals: {
                eventCount: 2,
                tokens: { input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 300 },
                cost: { reportedUsd: 3, estimatedUsd: 2, currency: 'USD' },
            },
            series: [
                {
                    bucketStartMs: nowMs - (14 * dayMs),
                    bucketEndMs: nowMs - (13 * dayMs),
                    eventCount: 1,
                    tokens: { input: 120, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150 },
                    cost: { reportedUsd: 1.5, estimatedUsd: 1, currency: 'USD' },
                },
                {
                    bucketStartMs: nowMs - (13 * dayMs),
                    bucketEndMs: nowMs - (12 * dayMs),
                    eventCount: 1,
                    tokens: { input: 80, output: 70, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150 },
                    cost: { reportedUsd: 1.5, estimatedUsd: 1, currency: 'USD' },
                },
            ],
        };

        try {
            const summary = buildUsageAnalyticsSummaryViewModel(response);

            expect(summary.totalTokens).toBe(300);
            expect(summary.currentStreakDays).toBe(0);
            expect(summary.weekTokens).toBe(0);
            expect(summary.weekCost).toBe(0);

            const viewModel = buildUsageAnalyticsViewModel(response, baseState);
            expect(viewModel.insights.currentStreakDays).toBe(0);
        } finally {
            dateNowSpy.mockRestore();
        }
    });

    it('does not treat sparse older legacy usage points as current-week summary usage', () => {
        const nowMs = 1_800_000_000_000;
        const daySeconds = 86_400;
        const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const nowSeconds = Math.floor(nowMs / 1000);
        const usage: UsageDataPoint[] = [
            {
                timestamp: nowSeconds - (14 * daySeconds),
                tokens: { total: 150, input: 120, output: 30 },
                cost: { total: 1.5, input: 1, output: 0.5 },
                reportCount: 1,
            },
            {
                timestamp: nowSeconds - (13 * daySeconds),
                tokens: { total: 150, input: 80, output: 70 },
                cost: { total: 1.5, input: 1, output: 0.5 },
                reportCount: 1,
            },
        ];

        try {
            const summary = buildUsageAnalyticsSummaryViewModel(usage);

            expect(summary.totalTokens).toBe(300);
            expect(summary.currentStreakDays).toBe(0);
            expect(summary.weekTokens).toBe(0);
            expect(summary.weekCost).toBe(0);

            const viewModel = buildUsageAnalyticsViewModel(usage, baseState);
            expect(viewModel.insights.currentStreakDays).toBe(0);
        } finally {
            dateNowSpy.mockRestore();
        }
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
                agent: [],
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
                agents: [],
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
                agent: [],
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
                agents: [],
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
                agent: [
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
        expect(reported.breakdowns.agents[0]?.totalCost).toBe(0);

        const estimated = buildUsageAnalyticsViewModel(response, {
            period: '7days',
            metric: 'cost',
            focus: null,
            costMode: 'estimated',
        });
        expect(estimated.overview.totalCost).toBe(9);
        expect(estimated.breakdowns.agents[0]?.totalCost).toBe(9);
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

    it('does not treat sparse older legacy buckets as a current summary streak', () => {
        const nowMs = 1_800_000_000_000;
        const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
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

        try {
            const summary = buildUsageAnalyticsSummaryViewModel(legacyUsage);

            expect(summary.currentStreakDays).toBe(0);
        } finally {
            dateNowSpy.mockRestore();
        }
    });

    it('sorts legacy usage before computing the current streak', () => {
        const nowMs = 1_700_345_600_000;
        const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
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

        try {
            const viewModel = buildUsageAnalyticsViewModel(legacyUsage, baseState);

            expect(viewModel.insights.currentStreakDays).toBe(2);
        } finally {
            dateNowSpy.mockRestore();
        }
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

describe('usage view-model L6 extensions (T2)', () => {
    function buildExtensionResponse(overrides?: {
        cacheRead?: number;
        cacheWrite?: number;
        cacheSavingsUsd?: number;
        context?: { usedTokens?: number | null; windowTokens?: number | null };
    }): UsageAnalyticsQueryResponse {
        return {
            v: 1,
            totals: {
                eventCount: 3,
                tokens: {
                    input: 90,
                    output: 30,
                    reasoning: 10,
                    cacheRead: overrides?.cacheRead ?? 25,
                    cacheWrite: overrides?.cacheWrite ?? 4,
                    total: 159,
                },
                cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
                ...(overrides?.context ? { context: overrides.context } : {}),
            },
            series: [
                {
                    bucketStartMs: 1_700_000_000_000,
                    bucketEndMs: 1_700_086_400_000,
                    eventCount: 3,
                    tokens: { input: 90, output: 30, reasoning: 10, cacheRead: overrides?.cacheRead ?? 25, cacheWrite: overrides?.cacheWrite ?? 4, total: 159 },
                    cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
                },
            ],
            insights: {
                activeDays: 2,
                longestStreakDays: 5,
                sessionsUsed: 7,
                messagesUsed: 20,
                modelsTried: 2,
                favoriteModel: { key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
                favoriteModelChangeCount: 1,
                busiestMonth: { key: '2024-04', label: 'Apr 2024' },
                busiestDay: { key: '2024-04-25', label: 'Thu' },
                busiestHour: { key: '13', label: '1 PM' },
                ...(overrides?.cacheSavingsUsd !== undefined ? { cacheSavingsUsd: overrides.cacheSavingsUsd } : {}),
            },
            activity: { calendarDays: [], weekdayHourBuckets: [] },
            leaders: { agents: [], models: [], sessions: [], projects: [], workspaces: [], engines: [] },
            messageStats: { sessionCount: 7, messageCount: 20 },
            costPresentation: { mode: 'auto', effectiveUsd: 11.5, currency: 'USD', source: 'provider_reported' },
        };
    }

    it('surfaces the server cache-savings USD on the view model when the server provides it', () => {
        // Proves the UI path end-to-end (F-CAP-1): when the server insights carry
        // cacheSavingsUsd (populated once events carry cost.breakdown savings), the
        // view model exposes the dollar figure — the InsightsSection then renders
        // USD instead of the token count. A missing figure is a server/producer
        // data gap, not a UI wiring bug.
        const viewModel = buildUsageAnalyticsViewModel(buildExtensionResponse({ cacheRead: 25, cacheSavingsUsd: 3.42 }), baseState);
        expect(viewModel.cacheSavings).toEqual({ cachedReadTokens: 25, cacheSavingsUsd: 3.42 });
    });

    it('composes the hero stat row from existing totals/insights without a second source of truth', () => {
        const viewModel = buildUsageAnalyticsViewModel(buildExtensionResponse(), baseState);

        expect(viewModel.hero).toEqual({
            totalTokens: 159,
            effectiveUsd: 11.5,
            currency: 'USD',
            sessions: 7,
            events: 3,
            messages: 20,
            longestStreakDays: 5,
        });
    });

    it('reports truthful cache-read tokens when caching occurred and null when it did not', () => {
        const withCache = buildUsageAnalyticsViewModel(buildExtensionResponse({ cacheRead: 25 }), baseState);
        expect(withCache.cacheSavings).toEqual({ cachedReadTokens: 25, cacheSavingsUsd: null });

        const withoutCache = buildUsageAnalyticsViewModel(buildExtensionResponse({ cacheRead: 0 }), baseState);
        expect(withoutCache.cacheSavings).toBeNull();
    });

    it('builds the context view model from the server latest-context snapshot and the token mix', () => {
        const viewModel = buildUsageAnalyticsViewModel(
            buildExtensionResponse({ context: { usedTokens: 40_000, windowTokens: 200_000 } }),
            baseState,
        );

        expect(viewModel.context).not.toBeNull();
        expect(viewModel.context?.usedTokens).toBe(40_000);
        expect(viewModel.context?.windowTokens).toBe(200_000);
        expect(viewModel.context?.usedPct).toBe(20);
        expect(viewModel.context?.tokenMix).toEqual({
            input: 90,
            output: 30,
            reasoning: 10,
            cacheRead: 25,
            cacheWrite: 4,
        });
    });

    it('leaves context usedPct null when the window is unknown but still exposes the token mix', () => {
        const viewModel = buildUsageAnalyticsViewModel(
            buildExtensionResponse({ context: { usedTokens: 40_000, windowTokens: null } }),
            baseState,
        );

        expect(viewModel.context?.usedTokens).toBe(40_000);
        expect(viewModel.context?.windowTokens).toBeNull();
        expect(viewModel.context?.usedPct).toBeNull();
        expect(viewModel.context?.tokenMix.input).toBe(90);
    });

    it('returns a null context and null cache savings for an empty legacy account', () => {
        const viewModel = buildUsageAnalyticsViewModel([], baseState);

        expect(viewModel.context).toBeNull();
        expect(viewModel.cacheSavings).toBeNull();
        expect(viewModel.hero.totalTokens).toBe(0);
        expect(viewModel.hero.sessions).toBe(0);
    });
});

describe('usage dashboard derivations', () => {
    const point = (tokens: number): UsageTrendPoint => ({ timestamp: 0, tokens, cost: 0, reportCount: 1 });

    describe('buildUsageTrendDelta', () => {
        it('compares the second half against the first equal-length half', () => {
            // first half = [10, 10] = 20; second half = [15, 15] = 30 → +50%
            const delta = buildUsageTrendDelta([point(10), point(10), point(15), point(15)]);
            expect(delta.deltaPct).toBeCloseTo(50);
            expect(delta.direction).toBe('up');
        });

        it('reports a downward direction when the recent half falls', () => {
            const delta = buildUsageTrendDelta([point(40), point(40), point(10), point(10)]);
            expect(delta.deltaPct).toBeCloseTo(-75);
            expect(delta.direction).toBe('down');
        });

        it('drops the middle bucket when the series length is odd so halves stay equal', () => {
            // halves are [10,10] and [30,30]; the middle 999 is excluded
            const delta = buildUsageTrendDelta([point(10), point(10), point(999), point(30), point(30)]);
            expect(delta.deltaPct).toBeCloseTo(200);
        });

        it('returns a null delta when the prior half has no volume', () => {
            const delta = buildUsageTrendDelta([point(0), point(0), point(5), point(5)]);
            expect(delta.deltaPct).toBeNull();
            expect(delta.direction).toBe('up');
        });

        it('returns a flat null delta for a series too short to split', () => {
            expect(buildUsageTrendDelta([point(5)])).toEqual({ deltaPct: null, direction: 'flat' });
            expect(buildUsageTrendDelta([])).toEqual({ deltaPct: null, direction: 'flat' });
        });
    });

    describe('buildUsageHourRhythm', () => {
        it('sums event counts across weekdays into 24 hour-of-day buckets', () => {
            const rhythm = buildUsageHourRhythm({
                calendarDays: [],
                weekdayHourBuckets: [
                    { weekday: 1, hour: 14, eventCount: 3 },
                    { weekday: 3, hour: 14, eventCount: 5 },
                    { weekday: 2, hour: 9, eventCount: 2 },
                ],
            });
            expect(rhythm.hours).toHaveLength(24);
            expect(rhythm.hours[14]).toEqual({ hour: 14, eventCount: 8 });
            expect(rhythm.hours[9]).toEqual({ hour: 9, eventCount: 2 });
            expect(rhythm.hours[0]).toEqual({ hour: 0, eventCount: 0 });
            expect(rhythm.busiestHour).toBe(14);
            expect(rhythm.peakCount).toBe(8);
            expect(rhythm.total).toBe(10);
        });

        it('has no busiest hour when there is no activity', () => {
            const rhythm = buildUsageHourRhythm({ calendarDays: [], weekdayHourBuckets: [] });
            expect(rhythm.busiestHour).toBeNull();
            expect(rhythm.total).toBe(0);
            expect(rhythm.hours).toHaveLength(24);
        });
    });

    describe('buildUsageComposition', () => {
        it('orders segments input→output→cacheRead→cacheWrite→reasoning with shares of the total', () => {
            const viewModel = buildUsageAnalyticsViewModel([{
                timestamp: 1_700_000_000,
                tokens: { total: 200, input: 100, output: 50, reasoning: 10, cacheRead: 30, cacheWrite: 10 },
                cost: { total: 1 },
                reportCount: 1,
                providerId: 'anthropic',
                modelId: 'claude',
            }], baseState);
            const composition = buildUsageComposition(viewModel.overview);
            expect(composition.segments.map((s) => s.key)).toEqual(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']);
            expect(composition.total).toBe(200);
            expect(composition.segments[0]).toMatchObject({ key: 'input', tokens: 100, pct: 50 });
            expect(composition.segments[2]).toMatchObject({ key: 'cacheRead', tokens: 30, pct: 15 });
        });

        it('returns zero shares without dividing by zero when there is no volume', () => {
            const composition = buildUsageComposition({
                totalTokens: 0,
                totalCost: 0,
                tokenBreakdown: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                costBreakdown: { total: 0 },
                reportCount: 0,
                eventCount: 0,
                activeDays: 0,
                tokensByModel: {},
                costByModel: {},
                costSource: 'legacy',
            });
            expect(composition.total).toBe(0);
            expect(composition.segments.every((s) => s.pct === 0)).toBe(true);
        });
    });

    describe('buildUsageLeaderTrend', () => {
        it('projects a per-bucket token series for one leader, zero-filling absent buckets', () => {
            const timeline = [
                { bucketStartMs: 0, bucketEndMs: 1, leaders: [{ key: 'a', label: 'A', eventCount: 1, totalTokens: 100, totalCost: 1 }] },
                { bucketStartMs: 1, bucketEndMs: 2, leaders: [{ key: 'b', label: 'B', eventCount: 1, totalTokens: 5, totalCost: 1 }] },
                { bucketStartMs: 2, bucketEndMs: 3, leaders: [{ key: 'a', label: 'A', eventCount: 1, totalTokens: 250, totalCost: 1 }] },
            ];
            expect(buildUsageLeaderTrend(timeline, 'a')).toEqual([100, 0, 250]);
            expect(buildUsageLeaderTrend(timeline, 'b')).toEqual([0, 5, 0]);
            expect(buildUsageLeaderTrend(timeline, 'missing')).toEqual([0, 0, 0]);
        });
    });

    describe('buildUsageModelMix (B-1 stacked share over time)', () => {
        const bucket = (startMs: number, leaders: Array<{ key: string; totalTokens: number }>): UsageAnalyticsTimelineBucket => ({
            bucketStartMs: startMs,
            bucketEndMs: startMs + 1,
            leaders: leaders.map((l) => ({ key: l.key, label: l.key.toUpperCase(), eventCount: 1, totalTokens: l.totalTokens, totalCost: 0 })),
        });

        it('ranks series by total tokens (largest first) and normalizes per-bucket shares to 1', () => {
            const mix = buildUsageModelMix([
                bucket(0, [{ key: 'a', totalTokens: 60 }, { key: 'b', totalTokens: 40 }]),
                bucket(1, [{ key: 'a', totalTokens: 20 }, { key: 'b', totalTokens: 20 }]),
            ]);
            expect(mix.keys.map((k) => k.key)).toEqual(['a', 'b']);
            expect(mix.hasData).toBe(true);
            expect(mix.total).toBe(140);
            expect(mix.buckets[0]!.shares).toEqual([0.6, 0.4]);
            expect(mix.buckets[1]!.shares).toEqual([0.5, 0.5]);
            // Shares in a non-empty bucket sum to 1.
            expect(mix.buckets[0]!.shares.reduce((s, v) => s + v, 0)).toBeCloseTo(1);
        });

        it('folds the tail beyond maxSeries into a single "other" series', () => {
            const mix = buildUsageModelMix([
                bucket(0, [
                    { key: 'a', totalTokens: 50 },
                    { key: 'b', totalTokens: 30 },
                    { key: 'c', totalTokens: 20 },
                ]),
            ], 2);
            expect(mix.keys.map((k) => k.key)).toEqual(['a', 'b', USAGE_MODEL_MIX_OTHER_KEY]);
            // "other" = c's 20 of 100.
            expect(mix.buckets[0]!.shares).toEqual([0.5, 0.3, 0.2]);
            // Fewer than 2 buckets → not enough to draw an area.
            expect(mix.hasData).toBe(false);
        });

        it('emits all-zero shares for an empty bucket (a gap, never a fabricated band)', () => {
            const mix = buildUsageModelMix([
                bucket(0, [{ key: 'a', totalTokens: 10 }]),
                bucket(1, []),
            ]);
            expect(mix.buckets[1]!.total).toBe(0);
            expect(mix.buckets[1]!.shares).toEqual([0]);
        });
    });

    describe('buildUsageWeeksBreakdown (B-3 weeks lens)', () => {
        const DAY = 24 * 60 * 60;
        const point = (isoDate: string, tokens: number, cost: number, events: number): UsageTrendPoint => ({
            timestamp: Math.floor(new Date(`${isoDate}T00:00:00.000Z`).getTime() / 1000),
            tokens,
            cost,
            reportCount: events,
        });

        it('groups trend points into UTC Sunday-anchored weeks, sums metrics, newest first', () => {
            // 2026-07-12 is a Sunday; 07-13 Mon, 07-14 Tue in the same week.
            // 2026-07-05 is the prior Sunday.
            const rows = buildUsageWeeksBreakdown([
                point('2026-07-05', 100, 1, 5),
                point('2026-07-13', 40, 0.4, 2),
                point('2026-07-14', 60, 0.6, 3),
            ]);
            expect(rows).toHaveLength(2);
            // Newest week (starting 07-12) first.
            expect(rows[0]!.key).toBe('2026-07-12');
            expect(rows[0]!.totalTokens).toBe(100);
            expect(rows[0]!.totalCost).toBeCloseTo(1);
            expect(rows[0]!.reportCount).toBe(5);
            expect(rows[1]!.key).toBe('2026-07-05');
            expect(rows[1]!.totalTokens).toBe(100);
            expect(rows.every((r) => r.dimension === 'week')).toBe(true);
            void DAY;
        });

        it('drives the week pivot in chronological (not token-ranked) order, accenting the busiest week', () => {
            const weeks = buildUsageWeeksBreakdown([
                point('2026-07-05', 100, 1, 5),
                point('2026-07-13', 300, 3, 9),
            ]);
            const breakdowns: UsageBreakdownSections = {
                agents: [], models: [], sessions: [], projects: [], workspaces: [], backendModes: [], sources: [], buckets: [], weeks,
            };
            const view = buildUsagePivotView(breakdowns, { models: {}, engines: {}, agents: {} }, 'week');
            // Order preserved (newest first), NOT re-sorted by tokens.
            expect(view.rows.map((r) => r.row.key)).toEqual(['2026-07-12', '2026-07-05']);
            // The busiest week (300 tokens) carries the accent even though it is first anyway here.
            expect(view.rows.find((r) => r.row.key === '2026-07-12')!.isLeader).toBe(true);
            expect(view.rows.find((r) => r.row.key === '2026-07-05')!.isLeader).toBe(false);
        });
    });

    describe('buildUsagePivotView (E-1 dimension pivot)', () => {
        const row = (dimension: string, key: string, totalTokens: number): UsageBreakdownRow => ({
            dimension: dimension as UsageBreakdownRow['dimension'],
            key,
            label: key,
            totalTokens,
            totalCost: 0,
            reportCount: 1,
            firstSeenAt: 0,
            lastSeenAt: 0,
            contextWindowTokens: null,
            contextUsedTokens: null,
        });
        const emptyBreakdowns: UsageBreakdownSections = {
            agents: [], models: [], sessions: [], projects: [], workspaces: [], backendModes: [], sources: [], buckets: [], weeks: [],
        };
        const trends: UsageLeaderTrends = { models: { m1: [1, 2, 3] }, engines: {}, agents: {} };

        it('ranks rows by total tokens, shares against the full dimension total, and marks the single leader', () => {
            const breakdowns: UsageBreakdownSections = {
                ...emptyBreakdowns,
                models: [row('model', 'm2', 20), row('model', 'm1', 80)],
            };
            const view = buildUsagePivotView(breakdowns, trends, 'model');
            expect(view.rows.map((r) => r.row.key)).toEqual(['m1', 'm2']);
            expect(view.total).toBe(100);
            expect(view.rows[0]!.sharePct).toBeCloseTo(80);
            expect(view.rows[0]!.isLeader).toBe(true);
            expect(view.rows[1]!.isLeader).toBe(false);
            expect(view.rows[0]!.trend).toEqual([1, 2, 3]);
            expect(view.hasTrend).toBe(true);
        });

        it('omits the trend column cleanly for dimensions without a timeline', () => {
            const breakdowns: UsageBreakdownSections = {
                ...emptyBreakdowns,
                sessions: [row('session', 's1', 10)],
            };
            const view = buildUsagePivotView(breakdowns, trends, 'session');
            expect(view.hasTrend).toBe(false);
            expect(view.rows[0]!.trend).toEqual([]);
        });

        it('selects the right breakdown list per dimension', () => {
            const breakdowns: UsageBreakdownSections = {
                ...emptyBreakdowns,
                projects: [row('project', 'p1', 5)],
                sources: [row('source', 'src1', 7)],
            };
            expect(selectUsageBreakdownRows(breakdowns, 'project').map((r) => r.key)).toEqual(['p1']);
            expect(selectUsageBreakdownRows(breakdowns, 'source').map((r) => r.key)).toEqual(['src1']);
        });
    });

    describe('buildUsagePunchCard (E-2 punch card)', () => {
        it('fills a 7×24 grid, sums duplicate cells, and annotates the busiest cell', () => {
            const card = buildUsagePunchCard({
                calendarDays: [],
                weekdayHourBuckets: [
                    { weekday: 4, hour: 14, eventCount: 3 },
                    { weekday: 4, hour: 14, eventCount: 2 },
                    { weekday: 1, hour: 9, eventCount: 4 },
                ],
            });
            expect(card.cells).toHaveLength(7);
            expect(card.cells[4]).toHaveLength(24);
            expect(card.cells[4]![14]).toBe(5);
            expect(card.cells[1]![9]).toBe(4);
            expect(card.peak).toBe(5);
            expect(card.busiest).toEqual({ weekday: 4, hour: 14, eventCount: 5 });
            expect(card.total).toBe(9);
        });

        it('has no busiest cell without activity', () => {
            const card = buildUsagePunchCard({ calendarDays: [], weekdayHourBuckets: [] });
            expect(card.busiest).toBeNull();
            expect(card.total).toBe(0);
            expect(card.peak).toBe(0);
        });
    });

    describe('buildUsageEfficiency (E-3 headlines)', () => {
        const overview = (input: number, cacheRead: number, total: number) => ({
            totalTokens: total,
            totalCost: 0,
            tokenBreakdown: { input, output: 0, reasoning: 0, cacheRead, cacheWrite: 0, total },
            costBreakdown: { total: 0 },
            reportCount: 0,
            eventCount: 0,
            activeDays: 0,
            tokensByModel: {},
            costByModel: {},
            costSource: 'legacy' as const,
        });

        it('computes cache-hit rate as cacheRead / (input + cacheRead) and $/Mtok as effectiveUsd / total × 1e6', () => {
            const efficiency = buildUsageEfficiency(overview(300, 100, 500), {
                mode: 'auto', effectiveUsd: 5, currency: 'USD', source: 'provider_reported',
            });
            expect(efficiency.cacheHitRatePct).toBeCloseTo(25);
            // 5 / 500 × 1e6 = 10,000
            expect(efficiency.costPerMtokUsd).toBeCloseTo(10_000);
            expect(efficiency.currency).toBe('USD');
        });

        it('returns null (never 0 or NaN) when the basis is missing', () => {
            const efficiency = buildUsageEfficiency(overview(0, 0, 0), {
                mode: 'auto', effectiveUsd: 0, currency: 'USD', source: 'estimated',
            });
            expect(efficiency.cacheHitRatePct).toBeNull();
            expect(efficiency.costPerMtokUsd).toBeNull();
        });
    });

    it('exposes derivations on the response view model', () => {
        const viewModel = buildUsageAnalyticsViewModel(buildResponseWithSeries(), baseState);
        expect(viewModel.heroTrend.sparkline).toEqual([10, 10, 30, 30]);
        expect(viewModel.heroTrend.delta.direction).toBe('up');
        expect(viewModel.hourRhythm.busiestHour).toBe(14);
        expect(viewModel.composition.segments).toHaveLength(5);
        expect(Object.keys(viewModel.leaderTrends.models)).toContain('claude');
        expect(viewModel.efficiency.costPerMtokUsd).not.toBeNull();
    });

    function buildResponseWithSeries(): UsageAnalyticsQueryResponse {
        const cost = { reportedUsd: 1, estimatedUsd: 1, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' } as const;
        const tokensOf = (tokens: number) => ({ input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: tokens });
        const response: UsageAnalyticsQueryResponse = {
            v: 1,
            totals: {
                eventCount: 4,
                tokens: tokensOf(80),
                cost: { reportedUsd: 4, estimatedUsd: 4, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
            },
            series: [
                { bucketStartMs: 0, bucketEndMs: 1, eventCount: 1, tokens: tokensOf(10), cost },
                { bucketStartMs: 1, bucketEndMs: 2, eventCount: 1, tokens: tokensOf(10), cost },
                { bucketStartMs: 2, bucketEndMs: 3, eventCount: 1, tokens: tokensOf(30), cost },
                { bucketStartMs: 3, bucketEndMs: 4, eventCount: 1, tokens: tokensOf(30), cost },
            ],
            insights: {
                activeDays: 2,
                longestStreakDays: 2,
                sessionsUsed: 3,
                messagesUsed: 4,
                modelsTried: 1,
                favoriteModel: { key: 'claude', label: 'Claude' },
                favoriteModelChangeCount: 0,
                busiestMonth: undefined,
                busiestDay: undefined,
                busiestHour: { key: '14', label: '2 PM' },
            },
            activity: { calendarDays: [], weekdayHourBuckets: [{ weekday: 1, hour: 14, eventCount: 4 }] },
            leaders: { agents: [], models: [], sessions: [], projects: [], workspaces: [], engines: [] },
            modelTimeline: [
                { bucketStartMs: 0, bucketEndMs: 1, leaders: [{ key: 'claude', eventCount: 2, tokens: tokensOf(40), cost }] },
                { bucketStartMs: 2, bucketEndMs: 3, leaders: [{ key: 'claude', eventCount: 2, tokens: tokensOf(40), cost }] },
            ],
            messageStats: { sessionCount: 3, messageCount: 4 },
            costPresentation: { mode: 'auto', effectiveUsd: 4, currency: 'USD', source: 'provider_reported' },
        };
        return response;
    }
});

describe('resolveSessionsUsed (D-R2-6 — canonical session count)', () => {
    it('prefers the larger of message-session and usage-session counts (no undercount, no cap regression)', () => {
        // Usage-only sessions (breakdown) exceed message sessions → use the usage count.
        expect(resolveSessionsUsed({
            messageStats: { sessionCount: 1, messageCount: 14 },
            breakdowns: { session: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] },
        } as never)).toBe(3);
        // True distinct count (message stats) exceeds a top-limit-capped breakdown → use it.
        expect(resolveSessionsUsed({
            messageStats: { sessionCount: 42, messageCount: 100 },
            breakdowns: { session: [{ key: 'a' }, { key: 'b' }] },
        } as never)).toBe(42);
        expect(resolveSessionsUsed({} as never)).toBe(0);
    });

    it('keeps the hero and the settings-home banner reading one session count', () => {
        const response = makeSessionCountResponse();
        const hero = buildUsageAnalyticsViewModel(response, baseState).hero;
        // Both surfaces derive sessions from insights.sessionsUsed → resolveSessionsUsed.
        expect(hero.sessions).toBe(resolveSessionsUsed(response));
        expect(hero.sessions).toBe(3);
    });
});

describe('buildUsageAgentTrends (D-R2-8 — agent leader sparklines)', () => {
    const bucket = (leaders: Array<{ key: string; totalTokens: number }>): UsageAnalyticsTimelineBucket => ({
        bucketStartMs: 0,
        bucketEndMs: 1,
        leaders: leaders.map((l) => ({ key: l.key, label: l.key, eventCount: 1, totalTokens: l.totalTokens, totalCost: 0 })),
    });

    it('re-keys the engine timeline to the agent grain so agent rows match their trend', () => {
        const engineTimeline: UsageAnalyticsTimelineBucket[] = [
            bucket([{ key: 'claude:local', totalTokens: 10 }, { key: 'codex', totalTokens: 5 }]),
            bucket([{ key: 'claude:remote', totalTokens: 20 }, { key: 'codex', totalTokens: 7 }]),
        ];
        const trends = buildUsageAgentTrends(engineTimeline);
        // 'claude' aggregates local+remote per bucket; keyed by bare agentId (matches breakdowns.agents).
        expect(trends.claude).toEqual([10, 20]);
        expect(trends.codex).toEqual([5, 7]);
    });

    it('returns an empty map for an empty timeline', () => {
        expect(buildUsageAgentTrends([])).toEqual({});
    });
});

function makeSessionCountResponse(): UsageAnalyticsQueryResponse {
    return {
        v: 1,
        totals: {
            tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 100 },
            cost: { reportedUsd: 1, estimatedUsd: 1, currency: 'USD' },
            eventCount: 14,
        },
        series: [],
        breakdowns: {
            session: ['a', 'b', 'c'].map((key) => ({
                key,
                label: key,
                eventCount: 4,
                tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
            })),
        },
        messageStats: { sessionCount: 1, messageCount: 14 },
    } as never;
}
