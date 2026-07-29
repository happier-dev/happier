import { describe, expect, it } from 'vitest';

import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';

import { buildUsageRecapCardModels } from './buildUsageRecapCardModels';

const response: UsageAnalyticsQueryResponse = {
    v: 1,
    totals: {
        eventCount: 4,
        tokens: { input: 100, output: 40, reasoning: 20, cacheRead: 0, cacheWrite: 0, total: 160 },
        cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
    },
    series: [
        {
            bucketStartMs: 1_700_000_000_000,
            bucketEndMs: 1_700_086_400_000,
            eventCount: 2,
            tokens: { input: 60, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: 0, total: 90 },
            cost: { reportedUsd: 7, estimatedUsd: 5, currency: 'USD' },
        },
        {
            bucketStartMs: 1_700_086_400_000,
            bucketEndMs: 1_700_172_800_000,
            eventCount: 2,
            tokens: { input: 40, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: 0, total: 70 },
            cost: { reportedUsd: 5, estimatedUsd: 3, currency: 'USD' },
        },
    ],
    breakdowns: {
        agent: [{ key: 'openai', label: 'OpenAI', eventCount: 4, tokens: { input: 100, output: 40, reasoning: 20, cacheRead: 0, cacheWrite: 0, total: 160 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
        model: [{ key: 'gpt-5.4', label: 'GPT-5.4', eventCount: 4, tokens: { input: 100, output: 40, reasoning: 20, cacheRead: 0, cacheWrite: 0, total: 160 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
        session: [],
        project: [],
        workspace: [],
        backendMode: [{ key: 'openai:codex-app-server', label: 'openai:codex-app-server', eventCount: 4, tokens: { input: 100, output: 40, reasoning: 20, cacheRead: 0, cacheWrite: 0, total: 160 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
        source: [],
    },
    insights: {
        activeDays: 10,
        longestStreakDays: 6,
        sessionsUsed: 4,
        messagesUsed: 10,
        modelsTried: 1,
        favoriteModel: { key: 'gpt-5.4', label: 'GPT-5.4' },
        favoriteModelChangeCount: 2,
        busiestMonth: { key: '2026-04', label: 'Apr 2026' },
        busiestDay: { key: '2026-04-10', label: 'Fri' },
        busiestHour: { key: '08', label: '8 AM' },
    },
    activity: {
        calendarDays: Array.from({ length: 14 }, (_, index) => ({
            date: `2026-04-${String(index + 1).padStart(2, '0')}`,
            eventCount: index % 4 === 0 ? 4 : index % 3 === 0 ? 2 : 1,
        })),
        weekdayHourBuckets: [
            { weekday: 6, hour: 8, eventCount: 12 },
            { weekday: 6, hour: 9, eventCount: 8 },
            { weekday: 4, hour: 15, eventCount: 4 },
            { weekday: 5, hour: 12, eventCount: 3 },
        ],
    },
    leaders: {
        agents: [{ key: 'openai', label: 'OpenAI', eventCount: 4 }],
        models: [{ key: 'gpt-5.4', label: 'GPT-5.4', eventCount: 4 }],
        sessions: [],
        projects: [],
        workspaces: [],
        engines: [{ key: 'openai:codex-app-server', label: 'openai:codex-app-server', eventCount: 4 }],
    },
    modelTimeline: [],
    engineTimeline: [],
    messageStats: {
        sessionCount: 4,
        messageCount: 10,
    },
    costPresentation: {
        mode: 'reported',
        effectiveUsd: 12,
        currency: 'USD',
        source: 'provider_reported',
    },
};

describe('buildUsageRecapCardModels', () => {
    it('uses a 7x2 activity matrix for the streak recap card', () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const cards = buildUsageRecapCardModels({
            viewModel,
            filters: {
                period: '30days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
        });

        const streakCard = cards.find((card) => card.id === 'streak');

        expect(streakCard?.visual).toMatchObject({
            kind: 'activityMatrix',
            squareCount: 14,
            rowSize: 7,
        });
    });

    it('uses ranked busiest-window rows instead of unlabeled spark bars', () => {
        const viewModel = buildUsageAnalyticsViewModel(response, {
            period: '30days',
            metric: 'tokens',
            focus: null,
            costMode: 'auto',
        });

        const cards = buildUsageRecapCardModels({
            viewModel,
            filters: {
                period: '30days',
                metric: 'tokens',
                focus: null,
                costMode: 'auto',
            },
        });

        const rhythmCard = cards.find((card) => card.id === 'rhythm');

        expect(rhythmCard?.visual).toMatchObject({
            kind: 'rankBars',
        });
        expect(rhythmCard?.visual.kind === 'rankBars' ? rhythmCard.visual.rows.map((row) => row.value) : []).toEqual([12, 8, 4]);
        expect(rhythmCard?.visual.kind === 'rankBars' ? rhythmCard.visual.rows[0]?.label : '').toContain('Sat');
        expect(rhythmCard?.visual.kind === 'rankBars' ? rhythmCard.visual.rows[2]?.label : '').toContain('Thu');
    });

    it('falls back to the top agent label when the engine metadata is unknown in the model card', () => {
        const viewModel = buildUsageAnalyticsViewModel({
            ...response,
            breakdowns: {
                ...response.breakdowns,
                backendMode: [{ key: 'unknown', label: 'unknown', eventCount: 4, tokens: { input: 100, output: 40, reasoning: 20, cacheRead: 0, cacheWrite: 0, total: 160 }, cost: { reportedUsd: 12, estimatedUsd: 8, currency: 'USD' } }],
            },
            leaders: {
                ...response.leaders,
                engines: [{ key: 'unknown', label: 'unknown', eventCount: 4 }],
                agents: [{ key: 'opencode', label: 'opencode', eventCount: 4 }],
            },
        }, { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' });

        const modelCard = buildUsageRecapCardModels({
            viewModel,
            filters: { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' },
        }).find((card) => card.id === 'model');

        expect(modelCard?.subtitle).toContain('opencode');
        expect(modelCard?.subtitle).not.toContain('unknown');
    });
});
