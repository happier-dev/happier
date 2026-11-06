import { describe, expect, it } from 'vitest';

import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';

import { buildUsageRecapCardModels } from './buildUsageRecapCardModels';
import { t } from '@/text';
import { usageAgentTitle, usageDimensionLabel } from '../usageLabels';

const response = UsageAnalyticsQueryResponseSchema.parse({
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
});

describe('buildUsageRecapCardModels', () => {
    it('uses observed All calendar days and keeps an empty All recap empty', () => {
        const filters = { period: 'all', metric: 'tokens', focus: null, costMode: 'auto' } as const;
        const query = normalizeUsageQuery({ period: { relative: 'all' }, timeZoneOffsetMinutes: 0 });
        const viewModel = buildUsageAnalyticsViewModel(UsageAnalyticsQueryResponseSchema.parse({ ...response, insights: undefined,
            activity: { calendarDays: [
                { date: '2026-11-01', eventCount: 2 },
                { date: '2026-11-02', eventCount: 0 },
                { date: '2026-11-03', eventCount: 2 },
            ] } }), filters, 0);
        const cards = buildUsageRecapCardModels({ viewModel, filters, query });
        expect(cards.find(card => card.id === 'usage')).toMatchObject({
            label: t('usage.allTime'), visual: { kind: 'progress', ratio: 2 / 3 },
        });
        const empty = buildUsageAnalyticsViewModel(UsageAnalyticsQueryResponseSchema.parse({ v: 1,
            totals: { eventCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, activity: { calendarDays: [] } }), filters, 0);
        expect(buildUsageRecapCardModels({ viewModel: empty, filters, query })).toEqual([]);
    });
    it('keeps an unavailable day summary out of numeric streak copy', () => {
        const filters = { period: '7days', metric: 'tokens', focus: null, costMode: 'auto' } as const;
        const viewModel = buildUsageAnalyticsViewModel({ ...response, activity: undefined, insights: undefined }, filters);
        const cards = buildUsageRecapCardModels({ viewModel, filters });
        const card = cards.find(value => value.id === 'streak');
        expect(card).toMatchObject({ value: '—', subtitle: t('common.unavailable') });
        expect(cards.find(value => value.id === 'usage')?.visual).toBeNull();
    });

    it('uses the witnessed favorite model even when unattributed usage leads the ranking', () => {
        const filters = { period: '7days', metric: 'tokens', focus: null, costMode: 'auto' } as const;
        const unknown = { key: 'unknown', label: 'unknown', eventCount: 4007 };
        const viewModel = buildUsageAnalyticsViewModel({ ...response,
            insights: { ...response.insights!, favoriteModel: { key: 'claude-haiku-4-5', label: 'claude-haiku-4-5' } },
            leaders: { ...response.leaders!, models: [unknown, { key: 'claude-haiku-4-5', eventCount: 1561 }] },
        }, filters);
        const model = buildUsageRecapCardModels({ viewModel, filters }).find(card => card.id === 'model');
        expect(model?.value).toBe(usageDimensionLabel('model', 'claude-haiku-4-5'));
        const missing = buildUsageAnalyticsViewModel({ ...response,
            insights: { ...response.insights!, favoriteModel: undefined },
            leaders: { ...response.leaders!, models: [unknown] },
            breakdowns: { ...response.breakdowns!, model: [] },
        }, filters);
        expect(buildUsageRecapCardModels({ viewModel: missing, filters }).find(card => card.id === 'model')?.value)
            .toBe(t('usage.board.page.unattributed'));
    });

    it('uses canonical leaders when the query omits model breakdowns and keeps missing money unavailable', () => {
        const filters = { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' } as const;
        const viewModel = buildUsageAnalyticsViewModel({
            ...response,
            totals: { ...response.totals, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' } },
            breakdowns: { ...response.breakdowns, model: [] },
            costPresentation: undefined,
        }, filters);
        const cards = buildUsageRecapCardModels({ viewModel, filters });
        expect(cards.find(card => card.id === 'model')?.value).toBe(usageDimensionLabel('model', 'gpt-5.4', 'GPT-5.4'));
        expect(cards.find(card => card.id === 'model')?.subtitle).not.toContain(t('usage.noData.title'));
        expect(cards.find(card => card.id === 'usage')?.subtitle).toBe(t('common.unavailable'));
        const costCard = buildUsageRecapCardModels({ viewModel, filters: { ...filters, metric: 'cost' } }).find(card => card.id === 'usage');
        expect(costCard?.value).toBe(t('common.unavailable'));
    });

    it('keeps a witnessed zero cost distinct from unavailable and names its actual basis', () => {
        const filters = { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' } as const;
        const viewModel = buildUsageAnalyticsViewModel({ ...response,
            totals: { ...response.totals, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' } },
            costPresentation: undefined,
        }, filters);
        expect(buildUsageRecapCardModels({ viewModel, filters }).find(card => card.id === 'usage')?.subtitle)
            .toBe(`$0.00 · ${t('usage.board.page.kindReported')}`);
    });

    it('shows busiest-window evidence rather than repeating its hour label', () => {
        const filters = { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' } as const;
        const viewModel = buildUsageAnalyticsViewModel(response, filters);
        expect(buildUsageRecapCardModels({ viewModel, filters }).find(card => card.id === 'rhythm')?.subtitle)
            .toBe(`12 ${t('usage.events')}`);
    });

    it('labels a custom historical query with its exact offset calendar rather than the legacy preset', () => {
        const filters = { period: '7days', metric: 'tokens', focus: null, costMode: 'auto' } as const;
        const viewModel = buildUsageAnalyticsViewModel({ ...response, activity: { ...response.activity,
            calendarDays: Array.from({ length: 10 }, (_, index) => ({
                date: new Date(Date.UTC(2024, 3, 22 + index)).toISOString().slice(0, 10), eventCount: 1,
            })) } }, filters, 120);
        const query = normalizeUsageQuery({
            period: { startMs: Date.parse('2024-04-21T22:00:00Z'), endMs: Date.parse('2024-05-01T22:00:00Z') },
            granularity: 'day' as const, timeZoneOffsetMinutes: 120, metric: 'tokens' as const, costBasis: 'auto' as const,
        });
        const date = (day: string) => new Intl.DateTimeFormat(undefined, {
            timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
        }).format(Date.parse(day));
        const label = `${date('2024-04-22')} – ${date('2024-05-01')}`;
        const cards = buildUsageRecapCardModels({ viewModel, filters, query });
        expect(cards.find(card => card.id === 'usage')?.label).toBe(label);
        expect(cards.find(card => card.id === 'streak')?.subtitle).toContain(label);
        expect(cards.find(card => card.id === 'usage')?.visual).toEqual({ kind: 'progress', ratio: 1 });
    });
    it('retains the shown query calendar offset when recap callers omit an override', () => {
        const filters = { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' } as const;
        const viewModel = buildUsageAnalyticsViewModel({
            ...response,
            activity: { ...response.activity, calendarDays: [{ date: '2026-10-09', eventCount: 7 }] },
        }, filters, -240);
        const visual = buildUsageRecapCardModels({ viewModel, filters }).find(card => card.id === 'streak')?.visual;
        expect(visual?.kind).toBe('activityMatrix');
        if (visual?.kind !== 'activityMatrix') throw new Error('Missing streak activity');
        expect(visual.activity[0]?.timestamp).toBe(Date.parse('2026-10-09T04:00:00Z'));
        expect(new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(visual.activity[0]!.timestamp))).toBe('10/09/2026');

        const overridden = buildUsageRecapCardModels({ viewModel, filters, timeZoneOffsetMinutes: 0 })
            .find(card => card.id === 'streak')?.visual;
        expect(overridden?.kind === 'activityMatrix' ? overridden.activity[0]?.timestamp : null)
            .toBe(Date.parse('2026-10-09T00:00:00Z'));

        const legacyViewModel = buildUsageAnalyticsViewModel([{
            timestamp: Date.parse('2026-10-09T05:00:00Z') / 1000,
            tokens: { total: 10 }, cost: { total: 1 }, reportCount: 1,
        }], filters, -240);
        const legacyVisual = buildUsageRecapCardModels({ viewModel: legacyViewModel, filters })
            .find(card => card.id === 'streak')?.visual;
        expect(legacyVisual?.kind === 'activityMatrix' ? legacyVisual.activity[0]?.timestamp : null)
            .toBe(Date.parse('2026-10-09T04:00:00Z'));
    });

    it('keeps unselected names and dollars out of shared card values and subtitles', () => {
        const filters = { period: '30days', metric: 'cost', focus: null, costMode: 'auto' } as const;
        const viewModel = buildUsageAnalyticsViewModel(response, filters);
        const cards = buildUsageRecapCardModels({ viewModel, filters, shareFields: { names: false, dollars: false } });
        const serialized = JSON.stringify(cards);
        expect(serialized).not.toContain('GPT-5.4');
        expect(serialized).not.toContain('OpenAI');
        expect(serialized).not.toContain('$');
        expect(cards.find(card => card.id === 'usage')?.value).toBe('160');
    });

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
        expect(rhythmCard?.visual?.kind === 'rankBars' ? rhythmCard.visual.rows.map((row) => row.value) : []).toEqual([12, 8, 4]);
        expect(rhythmCard?.visual?.kind === 'rankBars' ? rhythmCard.visual.rows[0]?.label : '').toContain('Sat');
        expect(rhythmCard?.visual?.kind === 'rankBars' ? rhythmCard.visual.rows[2]?.label : '').toContain('Thu');
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

        expect(modelCard?.subtitle).toContain(usageAgentTitle('opencode'));
        expect(modelCard?.subtitle).not.toContain('unknown');
    });
});
