import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { composeUsageRecap } from '@happier-dev/protocol';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageRecapPrivateComposeInputSchema } from '@happier-dev/protocol/usage/usageRecap';
import { normalizeUsageQuery, usageQueryToAnalyticsRequest } from '@happier-dev/protocol/inputs/usageQuery';
import { projectUsageAnalyticsSummary } from '@happier-dev/protocol/usage/usageSummary';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { buildUsageStatCardModel } from './usageStatCardModel';
import { UsageStatCard } from './UsageStatCard';
import { USAGE_STAT_CARD_STYLES } from './usageStatCardStyles';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const tokens = { input: 900, output: 300, reasoning: 0, cacheRead: 600, cacheWrite: 100, total: 1_900_000_000 };
const query = normalizeUsageQuery({ period: { startMs: Date.UTC(2026, 6, 1), endMs: Date.UTC(2026, 8, 30) } });
const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
    totals: { eventCount: 2, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
    insights: { activeDays: 61, longestStreakDays: 1, sessionsUsed: 1, messagesUsed: 2, modelsTried: 1, favoriteModelChangeCount: 0 },
    breakdowns: { agent: [{ key: 'claude', label: 'Private Agent A', eventCount: 1, tokens: { ...tokens, total: 3 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
        { key: 'codex', label: 'Private Agent B', eventCount: 1, tokens: { ...tokens, total: 1 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }] },
    activity: { calendarDays: [{ date: '2026-09-01', eventCount: 4 }, { date: '2026-09-02', eventCount: 0 }], weekdayHourBuckets: [] },
});
const composed = composeUsageRecap({
    input: UsageRecapPrivateComposeInputSchema.parse({ query, style: 'daybreak', format: 'square', selectedFields: ['tokens', 'activeDays', 'agentMix', 'rhythm'] }),
    snapshot: resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: accounting, status: 'available' }] }).results[0]!,
});
if (composed.kind !== 'composed') throw new Error('The canonical recap producer must admit the renderer fixture');

const FORMATS = ['square', 'story', 'link-preview'] as const;

describe('private stat card renderer', () => {
    it('renders observed All days while retaining the admitted private artifact period', async () => {
        const endMs = Date.UTC(2026, 8, 4);
        const firstMs = Date.UTC(2026, 8, 1, 12);
        const selected = normalizeUsageQuery({ period: { endMs }, timeZoneOffsetMinutes: 0,
            includeActivity: true, includeInsights: true });
        const rich = UsageAnalyticsQueryResponseSchema.parse({ ...accounting,
            insights: { ...accounting.insights, activeDays: 2, longestStreakDays: 1 },
            activity: { calendarDays: [{ date: '2026-09-01', eventCount: 2 },
                { date: '2026-09-02', eventCount: 0 }, { date: '2026-09-03', eventCount: 2 }], weekdayHourBuckets: [] },
            coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [], sources: [],
                range: { startMs: 0, endMs, complete: true } },
            contributions: [firstMs, Date.UTC(2026, 8, 3, 12)].map((observedAtMs, index) => ({
                id: `observed-all-${index}`, observedAtMs, eventCount: 2, sessionId: null, turnId: null,
                agentId: 'codex', modelId: null, machineId: null, projectKey: null, workspaceId: null,
                source: 'runtime', tokens, cost: accounting.totals.cost,
            })),
        });
        const value = projectUsageAnalyticsSummary(rich, usageQueryToAnalyticsRequest(selected, endMs));
        const snapshot = resolveUsagePageAggregation({ queries: [selected],
            accounting: [{ query: selected, value, status: 'available', asOfMs: endMs }],
            howYouWork: [{ query: selected, detail: { status: 'partial', facts: [{
                workId: 'observed-private', machineId: null, agentId: 'codex', evidenceId: 'busy', kind: 'busy',
                startMs: firstMs, endMs: firstMs + 3000,
            }] } }],
        }).results[0]!;
        const result = composeUsageRecap({ input: UsageRecapPrivateComposeInputSchema.parse({
            query: selected, selectedFields: ['activeDays', 'streak', 'rhythm', 'parallel'],
        }), snapshot });
        expect(result).toMatchObject({ kind: 'composed', period: { startMs: 0, endMs } });
        if (result.kind !== 'composed') throw new Error('Expected admitted All recap');
        const model = buildUsageStatCardModel(result);
        expect(model.days).toEqual([2, 0, 2]);
        expect(model.stats).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'activeDays', value: '2' }),
            expect.objectContaining({ id: 'streak', value: t('usage.board.recap.daysValue', { count: 1 }) }),
        ]));
        const screen = await renderScreen(<UsageStatCard model={model} tone="dark" testID="all-observed" />);
        try {
            const label = screen.findByTestId('all-observed')!.props.accessibilityLabel;
            expect(label).toContain(`2 ${t('usage.board.recap.statActiveDays')}`);
            expect(label).toContain(`${t('usage.board.recap.daysValue', { count: 1 })} ${t('usage.board.recap.statStreak')}`);
        } finally { standardCleanup(); }
    });
    it('names the public Agent with Names off and exposes formatted amounts rather than share fractions', async () => {
        const agent = { ...accounting.breakdowns!.agent![0]!, key: 'claude', label: 'Claude' };
        const result = composeUsageRecap({ input: UsageRecapPrivateComposeInputSchema.parse({ query, selectedFields: ['agentMix'] }),
            snapshot: { ...resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: accounting, status: 'available' }] }).results[0]!,
                accounting: { ...accounting, breakdowns: { agent: [agent, { ...agent, key: 'codex', label: 'Codex', tokens: { ...tokens, total: 1 } }] } } } });
        if (result.kind !== 'composed') throw new Error('Expected composed Agent mix');
        const model = buildUsageStatCardModel(result);
        expect(model.mixGroups[0]?.rows[0]).toMatchObject({ agentId: 'claude', label: t('agentInput.agent.claude') });
        const screen = await renderScreen(<UsageStatCard model={model} tone="dark" testID="agent-identity" />);
        try {
            const labels = screen.tree.root.findAll(node => node.props.accessibilityRole === 'listitem' || node.props.role === 'listitem')
                .map(node => node.props.accessibilityLabel).filter(Boolean).join(' ');
            expect(screen.getTextContent()).toContain(t('agentInput.agent.claude'));
            expect(labels).not.toContain('0.75');
            expect(labels).toContain('75%');
        } finally { standardCleanup(); }
    });
    it.each(FORMATS)('draws one scoped reported total and distinct comparison populations in %s', async format => {
        const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        const cost = { reportedUsd: 0, estimatedUsd: 26.23, apiEquivalentUsd: 24.87,
            currency: 'USD', costSource: 'pricing_estimate' as const, reportedTotalId: 'final' };
        const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
            totals: { eventCount: 3, tokens: { ...zero, input: 7_600_000, total: 7_600_000 }, cost },
            contributions: [
                { id: 'inference', observedAtMs: Date.UTC(2026, 6, 1) + 1, sessionId: 'private', turnId: null,
                    agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
                    tokens: { ...zero, total: 1_100_000 }, cost },
                { id: 'other', observedAtMs: Date.UTC(2026, 6, 1) + 2, sessionId: 'private', turnId: null,
                    agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
                    tokens: { ...zero, total: 6_500_000 }, cost: { ...cost, estimatedUsd: 0, apiEquivalentUsd: 0 } },
                { id: 'final', observedAtMs: Date.UTC(2026, 6, 1) + 3, sessionId: 'private', turnId: null,
                    agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'final',
                    tokens: zero, cost: { reportedUsd: 35.61, estimatedUsd: 0, apiEquivalentUsd: 0, currency: 'USD',
                        costSource: 'provider_reported', reportedTotalContributionIds: ['inference', 'other'] } },
            ],
            costFacts: [
                ...[0.88, 34.73].map((amountUsd, index) => ({ kind: 'reported', amountUsd, currency: 'USD',
                    source: `private-report-${index}`, tokens: zero, eventCount: 1, asOfMs: 100, complete: true })),
                { kind: 'estimated', amountUsd: 26.23, currency: 'USD', source: 'private-estimate', tokens: zero,
                    eventCount: 1, asOfMs: 100, complete: true },
                ...[24.87, 0].map((amountUsd, index) => ({ kind: 'api_equivalent', amountUsd, currency: 'USD',
                    source: `private-price-${index}`, tokens: zero, eventCount: 1, asOfMs: 100, complete: true })),
                ...[1_100_000, 6_500_000].map((total, index) => ({ kind: 'unpriced', amountUsd: null, currency: 'USD',
                    source: `private-unpriced-${index}`, tokens: { ...zero, total }, eventCount: 1, asOfMs: 100, complete: false })),
            ],
        });
        // Use the transported accounting slice: pricing and source reconciliation have already run.
        const result = composeUsageRecap({ input: UsageRecapPrivateComposeInputSchema.parse({ query, format, selectedFields: ['dollars'] }),
            snapshot: { ...resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }] }).results[0]!, accounting: value } });
        if (result.kind !== 'composed') throw new Error('Expected admitted money facts');
        const model = buildUsageStatCardModel(result);
        const screen = await renderScreen(<UsageStatCard model={model} tone="dark" testID="money" />);
        try {
            expect(model.stats).toHaveLength(4);
            const text = screen.getTextContent();
            for (const value of ['$35.61', '$26.23', '$24.87', '7.6M']) expect(text).toContain(value);
            for (const duplicate of ['$0.88', '$34.73', '$0.00', '1.1M', '6.5M']) expect(text).not.toContain(duplicate);
            expect(model.stats.map(stat => stat.label)).toEqual([
                'usage.board.recap.money_reported · USD', 'usage.board.recap.money_estimated · USD',
                'usage.board.recap.money_api_equivalent · USD', 'usage.board.recap.money_unpriced · USD',
            ]);
            for (const stat of model.stats) expect(text).toContain(stat.label);
            expect(model.stats.map(stat => stat.tier)).toEqual(['lead', 'comparison', 'comparison', 'comparison']);
            // Reads in that order: the selected total, then the comparisons.
            expect(text.indexOf('$35.61')).toBeLessThan(text.indexOf('$26.23'));
            expect(text.indexOf('$35.61')).toBeLessThan(text.indexOf('$24.87'));
            expect(text).not.toContain('private-');
        } finally { standardCleanup(); }
    });
    it.each(['cache', 'highlights'] as const)('draws selected %s facts as visible text through compose → model → card', async field => {
        const value = { ...accounting, series: [{ bucketStartMs: Date.UTC(2026, 6, 1), bucketEndMs: Date.UTC(2026, 8, 30),
            eventCount: 2, tokens: { ...tokens, total: 12345 }, cost: accounting.totals.cost }] };
        const snapshot = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }] }).results[0]!;
        const result = composeUsageRecap({ input: UsageRecapPrivateComposeInputSchema.parse({ query, selectedFields: [field] }), snapshot });
        if (result.kind !== 'composed') throw new Error('Expected admitted selected facts');
        const screen = await renderScreen(<UsageStatCard model={buildUsageStatCardModel(result)} tone="dark" testID="selected" />);
        try {
            const text = screen.getTextContent();
            if (field === 'cache') {
                expect(text).toContain('600');
                expect(text).toContain('100');
            } else expect(text).toContain('12.3K');
            expect(text).not.toContain('Private Agent');
        } finally { standardCleanup(); }
    });
    it.each(USAGE_STAT_CARD_STYLES)('retains every selected mix share beyond the palette in %s', async style => {
        const model = buildUsageStatCardModel({ ...composed, style });
        const rows = Array.from({ length: 9 }, (_, index) => ({ id: `agent-${index}`, label: `Agent ${index}`, share: (index + 1) / 45 }));
        const screen = await renderScreen(<UsageStatCard model={{ ...model, mixGroups: [{ kind: 'agentMix', rows, totalTokens: 45 }] }} tone="dark" testID="card" />);
        expect(screen.getTextContent()).toContain('Agent 8');
        expect(screen.findByTestId('card')!.props.accessibilityLabel).toContain('Agent 8 20%');
        const last = screen.tree.root.findAll(node => node.props.accessibilityLabel?.includes('Agent 8'));
        expect(last.some(node => node.props.accessibilityLabel.includes('20%'))).toBe(true);
        standardCleanup();
    });
    it('folds a long mix tail into one "+N more" share only on the short link-preview canvas, keeping every share readable to assistive technology', async () => {
        const rows = Array.from({ length: 9 }, (_, index) => ({ id: `agent-${index}`, label: `Agent ${index}`, share: (9 - index) / 45 }));
        const draw = async (format: 'square' | 'link-preview') => renderScreen(<UsageStatCard testID="card" tone="dark"
            model={{ ...buildUsageStatCardModel({ ...composed, format }), mixGroups: [{ kind: 'agentMix', rows, totalTokens: 45 }] }} />);
        const preview = await draw('link-preview');
        expect(preview.getTextContent()).toContain('usage.board.recap.mixMore');
        expect(preview.getTextContent()).toContain('Agent 0');
        expect(preview.getTextContent()).not.toContain('Agent 8');
        expect(preview.findByTestId('card')!.props.accessibilityLabel).toContain('Agent 8 2%');
        standardCleanup();
        const square = await draw('square');
        expect(square.getTextContent()).not.toContain('usage.board.recap.mixMore');
        expect(square.getTextContent()).toContain('Agent 8');
        standardCleanup();
    });
    it.each(FORMATS)('draws the Agent and Model mixes each with its own caption and denominator in %s', async format => {
        const model = buildUsageStatCardModel({ ...composed, format });
        const agentRows = [{ id: 'agentMix-0', label: 'Claude', share: 0.75 }, { id: 'agentMix-1', label: 'Codex', share: 0.25 }];
        const modelRows = [{ id: 'modelMix-0', label: 'Sonnet', share: 0.6 }, { id: 'modelMix-1', label: 'Opus', share: 0.4 }];
        const screen = await renderScreen(<UsageStatCard model={{ ...model, mixGroups: [
            { kind: 'agentMix', rows: agentRows, totalTokens: 1_900_000_000 },
            { kind: 'modelMix', rows: modelRows, totalTokens: 1_200_000_000 },
        ] }} tone="dark" testID="card" />);
        const text = screen.getTextContent();
        expect(text).toContain('usage.board.recap.field_agentMix · 1.9B');
        expect(text).toContain('usage.board.recap.field_modelMix · 1.2B');
        for (const label of ['Claude', 'Codex', 'Sonnet', 'Opus']) expect(text).toContain(label);
        for (const share of ['75%', '25%', '60%', '40%']) expect(text).toContain(share);
        standardCleanup();
    });
    it.each(USAGE_STAT_CARD_STYLES.flatMap(style => FORMATS.map(format => [style, format] as const)))(
        'draws all %s · %s stats in full, past the old format limits', async (style, format) => {
            const base = buildUsageStatCardModel({ ...composed, style, format });
            const stats = Array.from({ length: 12 }, (_, index) => ({ id: 'dollars' as const, value: `$${1000 + index},000.50`, label: `Stat label ${index}` }));
            const screen = await renderScreen(<UsageStatCard model={{ ...base, stats }} tone="dark" testID="card" />);
            const text = screen.getTextContent();
            for (const stat of stats) {
                expect(text).toContain(stat.value);
                expect(text).toContain(stat.label);
            }
            const valueNodes = screen.tree.root.findAll(node => typeof node.props.children === 'string' && node.props.children.startsWith('$'));
            expect(valueNodes.length).toBeGreaterThan(0);
            expect(valueNodes.every(node => node.props.numberOfLines === undefined)).toBe(true);
            standardCleanup();
        });
    it.each(USAGE_STAT_CARD_STYLES.flatMap(style => (['square', 'story', 'link-preview'] as const).map(format => [style, format] as const)))(
        'draws %s · %s from the one model with exact readable facts', async (style, format) => {
            const model = buildUsageStatCardModel({ ...composed, style, format });
            const screen = await renderScreen(<UsageStatCard model={model} tone="dark" testID="card" />);
            const card = screen.findByTestId('card')!;
            expect(card.props.accessibilityLabel).toContain('1.9B');
            expect(card.props.accessibilityLabel).toContain('61');
            expect(card.props.accessibilityLabel).not.toContain('Private Agent');
            standardCleanup();
        });
});
