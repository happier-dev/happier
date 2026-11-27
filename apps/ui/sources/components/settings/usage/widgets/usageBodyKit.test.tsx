import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectUsageAnalyticsSummary } from '@happier-dev/protocol/usage/usageCost';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ProviderAccountUsageSnapshotV1Schema, buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { projectProviderAccountUsageQuotaReadV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { resolveUsageComparisonQuery, resolveUsagePageAggregation, type UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { renderHook, renderScreen } from '@/dev/testkit';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { resolveUsageShownCalendarRange, formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { Heatmap, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { UsageDailyWidget } from './UsageDailyWidget';
import { UsageFlowWidget } from './UsageFlowWidget';
import { UsageRhythmWidget } from './UsageRhythmWidget';
import { WidgetFrameBodyCaptionContext, WidgetFrameBodyIdentityContext } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { usageQaAccountingFixture } from '@/dev/testkit/fixtures/usageQaAccountingFixture';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UsageWidgetBatchProvider } from './usageWidgetBatch';
import { readUsageWidgetQueryOverrides } from '../usageWidgetPageContext';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { usageSourceAgentId } from '@/sync/domains/usage/usageLabels';
import { clearProjectedAgentUiBehaviorDescriptors, publishProjectedAgentUiBehaviorDescriptors } from '@/agents/registry/agentUiBehaviorProjection';
import { isUsageObservationFromEarlierDay } from '@/sync/domains/usage/usageCalendarPresentation';
import { describeUsagePageNewerServerSources, describeUsagePagePartialSources, describeUsagePagePendingSources, readUsagePageFailure, readUsagePageFreshness, readUsagePageWorkOffline,readUsageCoverageGaps, isUsageReadOutstanding, UsageCoverageLine, usageCoverageDescription, usageCoverageLineMode, usageCoverageSummary, usagePeriodPhrase, usageDimensionLabel, usageAgentTitle, usageSourceTitle, useUsageAnalyticsView } from './usageBodyKit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('the page failure fact', () => {
  it('says a Work-only failure quietly and leaves other failures as failures', () => {
    const work = [{ sources: [{ source: 'work', status: 'error', errorCode: 'work_evidence_failed' }] }] as never;
    expect(readUsagePageFailure(work)).toMatchObject({ quiet: true, reason: t('usage.board.page.workNotRead') });
    const accounting = [{ sources: [{ source: 'accounting', status: 'error' }, { source: 'work', status: 'error' }] }] as never;
    expect(readUsagePageFailure(accounting)?.quiet).toBe(false);
  });
  it('keeps a Work failure beside partially read activity quiet: every figure still stands (R135 item 12)', () => {
    const both = [{ sources: [{ source: 'work', status: 'error' }, { source: 'how_you_work', status: 'partial' }] }] as never;
    expect(readUsagePageFailure(both)?.quiet).toBe(true);
  });
  it('states a quota ownership refusal once and offers the page Retry for it (an explicit reread)', () => {
    const refusal = { source: 'quota:work', status: 'error', errorCode: 'ownership_unproven' } as const;
    const reason = t('connectedServices.errors.quotaOwnershipUnproven', {});
    // What it holds back is said and the one Retry is offered (acceptance 11-22 #20).
    expect(readUsagePageFailure([{ sources: [refusal] }, { sources: [refusal] }])).toMatchObject({ reason, retryable: true });
    const quota = { source: 'quota:other', status: 'stale', errorCode: 'provider_account_usage_read_failed', asOfMs: 100 } as const;
    const failure = readUsagePageFailure([{ sources: [quota, refusal] }]);
    expect(failure).toMatchObject({ retryable: true, retainedQuotaAsOfMs: 100 });
    expect(failure?.reason).toContain(reason);
    expect(failure?.reason).toContain(t('usage.board.page.coverageFailed', { sources: usageSourceTitle('quota') }));
  });
});

describe('shared Usage identity and dependent coverage', () => {
    it('names dynamic accounting coverage from its declaration while native sources stay unopened', () => {
        const fetch = vi.spyOn(globalThis, 'fetch');
        publishProjectedAgentUiBehaviorDescriptors({ machineId: 'research-machine', descriptorsByAgentId: {
            'third.party/research': { kind: 'plugin.ui.v1', pluginId: 'third.party', agentId: 'third.party/research',
                behavior: { accountingSourcePresentation: [{ sourceId: 'research-observed-v1', title: 'Research observations' }] } },
        } });
        try {
            const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 } });
            const slice = resolveUsagePageAggregation({ queries: [query] }, bundledUsageModelPriceCatalog).results[0]!;
            const observed = { ...slice, sources: [{ source: 'research-observed-v1', status: 'error' as const }] };
            expect(usageCoverageDescription(observed, ['research-observed-v1'])).toContain('Research observations');
            expect(usageSourceAgentId('research-observed-v1')).toBe('third.party/research');
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            clearProjectedAgentUiBehaviorDescriptors();
            fetch.mockRestore();
        }
    });
    it('keeps unused analytics sections deferred through the body view cache', async () => {
        const admitted = usageQaAccountingFixture();
        let timelineReads = 0;
        const accounting = { ...admitted,
            get modelTimeline() {
                timelineReads += 1;
                return admitted.modelTimeline;
            },
        };
        const query = normalizeUsageQuery({ period: { relative: '7days' } });
        const slice = { accounting } as UsageQueryResultSlice;
        const hook = await renderHook(() => useUsageAnalyticsView(slice, query));
        expect(timelineReads).toBe(0);
        expect(hook.getCurrent()?.metric).toBe(query.metric);
        expect(hook.getCurrent()?.trend).toBeDefined();
        expect(timelineReads).toBe(0);
        expect(hook.getCurrent()?.modelMix).toBe(hook.getCurrent()?.modelMix);
        expect(timelineReads).toBe(1);
        expect(hook.getCurrent()?.pageCost).toBeDefined();
        await hook.unmount();
    });

    it('projects the declared comparison source through pending, answered and failed reads', () => {
        const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 } });
        const comparison = resolveUsageComparisonQuery(query)!;
        const accounting = { v: 1 as const, totals: usageQaAccountingFixture().totals };
        const sliceFor = (status: 'pending' | 'available' | 'error') => resolveUsagePageAggregation({ queries: [query], accounting: [
            { query, status: 'available', value: accounting },
            { query: comparison, status, ...(status === 'available' ? { value: accounting } : {}),
                ...(status === 'error' ? { errorCode: 'usage_query_failed' } : {}) },
        ] }, bundledUsageModelPriceCatalog).results[0]!;
        const pending = sliceFor('pending');
        expect.soft(isUsageReadOutstanding(pending, ['comparison'])).toBe(true);
        expect.soft(readUsageCoverageGaps(pending, ['comparison'])).toEqual([{ source: 'comparison', status: 'pending' }]);
        expect(isUsageReadOutstanding(sliceFor('available'), ['comparison'])).toBe(false);
        expect.soft(readUsageCoverageGaps(sliceFor('error'), ['comparison'])).toEqual([
            { source: 'comparison', status: 'error', errorCode: 'usage_query_failed' },
        ]);
        const unbounded = resolveUsagePageAggregation({ queries: [normalizeUsageQuery({ period: {} })] }, bundledUsageModelPriceCatalog).results[0]!;
        expect(isUsageReadOutstanding(unbounded, ['comparison'])).toBe(false);
    });
    it('labels unattributed models as not reported and preserves unfamiliar model ids', () => {
        expect(usageDimensionLabel('model', 'unknown', 'unknown')).toBe(t('usage.board.plans.cellUnknown'));
        expect(usageDimensionLabel('model', '<synthetic>')).toBe(t('usage.board.page.unattributed'));
        for (const id of ['claude-haiku-6-1', 'gpt-6.1-sol', 'third-party/MODEL-snapshot']) {
            expect(usageDimensionLabel('model', id)).toBe(id);
            expect(usageDimensionLabel('model', id, id)).toBe(id);
        }
    });
    it('holds an unanswered usage read as loading, never as "No usage in this period"', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, granularity: 'day' });
        const slice = resolveUsagePageAggregation({ queries: [query] }, bundledUsageModelPriceCatalog).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: true, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const screen = await renderScreen(<UsageDailyWidget query={query} slice={slice} model={model} serverId="home" id="usage_daily" testID="daily" />);
        expect(screen.getTextContent()).not.toContain(t('usage.board.page.noUsageTitle'));
        expect(screen.findByTestId('daily.loading')).toBeTruthy();
    });
    it('holds the settled Daily chart room at every width while the first read is outstanding', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, granularity: 'day' });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'pending' }] }, bundledUsageModelPriceCatalog).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: true, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const heldRoom = async (width: number, height = 260) => {
            const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'medium',
                footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width, height } }}>
                <UsageDailyWidget query={query} slice={slice} model={model} serverId="home" id="usage_daily" testID="daily" />
            </WidgetPresentationProvider>);
            const style = ([] as unknown[]).concat(screen.findHostByTestId('daily.loading')?.props.style ?? []).flat(2);
            return style.reduce<number>((held, entry) => (entry && typeof entry === 'object' && 'minHeight' in entry ? Number(entry.minHeight) : held), 0);
        };
        // The plot, its axis and legend: a narrow frame wraps its legend and note, so it keeps more chrome room.
        expect(await heldRoom(326)).toBe(Math.max(88, 260 - 136) + 136);
        expect(await heldRoom(640)).toBe(260 - 84 + 84);
        // A Board's Medium card (232 px of body): the plot gives way to the peak figure, so the held chart never outgrows it
        // and the coverage note stays inside the card.
        expect(await heldRoom(326, 232)).toBe(232);
    });
    it('keeps Rhythm reading until activity answers and retains known activity during refresh', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, includeActivity: true, activityResolution: 'both' });
        const cold = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'pending' }] }, bundledUsageModelPriceCatalog).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice: cold, pending: true, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const render = (slice: UsageQueryResultSlice) => <WidgetPresentationProvider value={{ size: 'medium',
            footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 320, height: 260 } }}>
            <UsageRhythmWidget query={query} slice={slice} model={model}
                serverId="home" id="usage_rhythm" testID="rhythm-read" />
        </WidgetPresentationProvider>;
        const screen = await renderScreen(render(cold));
        expect(screen.findByTestId('rhythm-read.empty')).toBeNull();
        expect(screen.findByTestId('rhythm-read.loading')).not.toBeNull();
        // Cold-read room belongs to UsageWidgetBody's usageBodyHeightMemory owner, not the Rhythm child.
        let held = 0;
        for (let node = screen.findHostByTestId('rhythm-read.loading')?.parent; node; node = node.parent) {
            for (const entry of ([] as unknown[]).concat(node.props.style ?? []).flat(2)) {
                if (entry && typeof entry === 'object' && 'minHeight' in entry && typeof entry.minHeight === 'number') held = Math.max(held, entry.minHeight);
            }
        }
        expect(held).toBe(0);
        const empty = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            ...usageQaAccountingFixture(), activity: { calendarDays: [], weekdayHourBuckets: [] },
        } }] }, bundledUsageModelPriceCatalog).results[0]!;
        await screen.update(render(empty));
        expect(screen.findByTestId('rhythm-read.empty')).not.toBeNull();
        const known = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'pending', value: usageQaAccountingFixture() }] }, bundledUsageModelPriceCatalog).results[0]!;
        await screen.update(render(known));
        expect(screen.findByTestId('rhythm-read.rhythm')).not.toBeNull();
        expect(screen.findByTestId('rhythm-read.loading')).toBeNull();
    });
    it('says a failed read as not read, never as zero; on the Usage page the header owns the cause and its Retry', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, granularity: 'day', includeActivity: true, activityResolution: 'both' });
        const failed = resolveUsagePageAggregation({ queries: [query],
            accounting: [{ query, status: 'error', errorCode: 'usage_query_failed' }] }, bundledUsageModelPriceCatalog).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice: failed, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const bodies = <>
            <UsageDailyWidget query={query} slice={failed} model={model} serverId="home" id="usage_daily" testID="daily" />
            <UsageRhythmWidget query={query} slice={failed} model={model} serverId="home" id="usage_rhythm" testID="rhythm" />
        </>;
        // Home or a Project: each widget is its own read, so it says the cause with its Retry.
        const own = await renderScreen(bodies);
        expect.soft(own.findByTestId('rhythm.empty')).toBeNull();
        expect.soft(own.findByTestId('rhythm.unavailable')).not.toBeNull();
        expect.soft(own.findByTestId('daily.unavailable')).not.toBeNull();
        await own.unmount();
        // The Usage page says the failed read once in its header; its bodies only say they were not read.
        const page = await renderScreen(<InjectedAuthProvider credentials={null}>
            <UsageWidgetBatchProvider clauses={readUsageWidgetQueryOverrides(query)}>{bodies}</UsageWidgetBatchProvider>
        </InjectedAuthProvider>);
        const text = page.getTextContent();
        expect.soft(text).not.toContain(t('usage.board.howYouWork.rhythmEmptyTitle'));
        expect.soft(text).not.toContain(t('usage.board.page.readFailedTitle'));
        expect.soft(text).not.toContain(t('common.retry'));
        expect.soft(page.findByTestId('rhythm.notRead')).not.toBeNull();
        expect(page.findByTestId('daily.notRead')).not.toBeNull();
    });
    it.each([false, true])('keeps the real open-ended QA calendar and gaps visible (relative: %s)', async relative => {
        const accounting = usageQaAccountingFixture();
        const query = normalizeUsageQuery({ period: relative ? { relative: '7days' } : { startMs: 1791064800000 },
            granularity: 'day', timeZoneOffsetMinutes: 120, includeActivity: true, activityResolution: 'both' });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }, bundledUsageModelPriceCatalog).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const props = { query, slice, model, serverId: 'home' };
        const screen = await renderScreen(<><UsageDailyWidget {...props} id="usage_daily" testID="qa-daily" />
            <UsageRhythmWidget {...props} id="usage_rhythm" testID="qa-rhythm" /></>);
        const calendar = screen.findByType(Heatmap).props.cells as { id: string; value: number | null }[];
        expect(calendar.filter(cell => cell.value !== null && cell.value > 0).map(cell => [cell.id, cell.value]))
            .toEqual(accounting.activity!.calendarDays!.map(day => [day.date, day.eventCount]));
        expect(calendar).toHaveLength(relative ? 7 : 8);
        const points = screen.findByType(StackedSeriesChart).props.series[0].points as { y: number | null }[];
        expect(points).toHaveLength(relative ? 7 : 8);
        expect(points.slice(0, relative ? 4 : 5).every(point => point.y === null)).toBe(true);
        expect(accounting.insights!.activeDays).toBe(calendar.filter(cell => (cell.value ?? 0) > 0).length);
    });
    it('leaves the period\'s unread end off the flow, but keeps a read zero day (USAGE-ACCEPT #18)', async () => {
        const { trimUsageFlowUnreadTail } = await import('./usageChartModels');
        const at = (...ys: (number | null)[]) => ({ points: ys.map(y => ({ y })) });
        const trimmed = trimUsageFlowUnreadTail([at(5, 3, 0), at(2, 4, null)]);
        expect(trimmed.map(entry => entry.points.map(point => point.y))).toEqual([[5, 3], [2, 4]]);
        const zero = trimUsageFlowUnreadTail([at(5, 3, 0), at(2, 4, 0)]);
        expect(zero.map(entry => entry.points.length)).toEqual([3, 3]);
        const partial = trimUsageFlowUnreadTail([at(5, 3, 1), at(2, 4, null)]);
        expect(partial.map(entry => entry.points.length)).toEqual([3, 3]);
        // Weeks before anything was recorded (a Year whose history starts in October) are left off the front too;
        // a recorded zero is a reading and stays.
        const head = trimUsageFlowUnreadTail([at(null, null, 0, 5, 3), at(null, null, null, 2, 4)]);
        expect(head.map(entry => entry.points.map(point => point.y))).toEqual([[0, 5, 3], [null, 2, 4]]);
    });
    it('names the Session in both whole-life and narrowed Usage captions', () => {
        const whole = normalizeUsageQuery({ period: { relative: 'all' }, session: 's1' });
        expect(usagePeriodPhrase(whole)).toBe(t('usage.board.page.thisSession'));
        expect(usagePeriodPhrase(normalizeUsageQuery({ period: { relative: 'all' } }))).not.toBe(t('usage.board.page.thisSession'));
        const week = normalizeUsageQuery({ period: { relative: '7days' } });
        const sessionWeek = normalizeUsageQuery({ ...week, session: 's1' });
        expect(usagePeriodPhrase(sessionWeek)).toBe(`${t('usage.board.page.thisSession')} · ${usagePeriodPhrase(week)}`);
        const range = normalizeUsageQuery({ period: { startMs: Date.UTC(2026, 10, 10), endMs: Date.UTC(2026, 10, 12) } });
        expect(usagePeriodPhrase(normalizeUsageQuery({ ...range, session: 's1' }))).toBe(
            `${t('usage.board.page.thisSession')} · ${usagePeriodPhrase(range)}`,
        );
    });
    it('says a flow needs more history when only two adjacent days of a month were recorded, never one stray diagonal (USAGE-ACCEPT 1118 #13)', async () => {
        const day = 86_400_000;
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 30 * day }, metric: 'tokens' });
        const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
        const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
        const timelineAt = (days: readonly number[]) => days.map(index => ({ bucketStartMs: index * day, bucketEndMs: (index + 1) * day,
            leaders: [{ key: 'opencode:local', label: 'OpenCode', eventCount: 1, tokens, cost,
                sources: [{ source: 'runtime', path: 'runtime' as const, execution: 'happier' as const, eventCount: 1, tokens, cost }] }] }));
        const sliceFor = (days: readonly number[]) => resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { eventCount: days.length, tokens: { ...tokens, total: 10 * days.length, input: 10 * days.length }, cost },
            engineTimeline: timelineAt(days),
        } }] }, bundledUsageModelPriceCatalog).results[0]!;
        const modelFor = (slice: UsageWidgetBodyModel['slice']): UsageWidgetBodyModel => ({ requestedQuery: null, shownQuery: null, slice, pending: false,
            error: null, freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} });
        const sparse = sliceFor([26, 27]);
        const screen = await renderScreen(<UsageFlowWidget query={query} slice={sparse} model={modelFor(sparse)} serverId="home" id="usage_flow" testID="flow-sparse" />);
        expect(screen.findAllByType(StackedSeriesChart)).toHaveLength(0);
        expect(screen.getTextContent()).toContain(t('usage.board.page.flowEmptyTitle'));
        // The same two days at the period's start decide the same way: the rule reads the period, not the trimmed drawing (review E-05).
        const early = sliceFor([0, 1]);
        await screen.update(<UsageFlowWidget query={query} slice={early} model={modelFor(early)} serverId="home" id="usage_flow" testID="flow-sparse" />);
        expect(screen.findAllByType(StackedSeriesChart)).toHaveLength(0);
        const run = sliceFor([24, 25, 26, 27]);
        await screen.update(<UsageFlowWidget query={query} slice={run} model={modelFor(run)} serverId="home" id="usage_flow" testID="flow-sparse" />);
        expect(screen.findAllByType(StackedSeriesChart)).toHaveLength(1);
    });
    it('keeps a body-replacing insufficient state to one line at a full-width footprint (USAGE-ACCEPT #5)', async () => {
        const { UsageBodyInsufficient } = await import('./usageBodyKit');
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'large',
            footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'regular' }, geometry: { width: 1060, height: 300 } }}>
            <UsageBodyInsufficient testID="loop.empty" title="No steering recorded in this period" reason="Steers appear here." />
        </WidgetPresentationProvider>);
        const card = screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'loop.empty')!;
        expect(card.props.size).toBe('line');
        expect(card.props.replacesContent).toBe(true);
    });
    it('names a Rhythm card by its Style and keeps only the measure in its caption (USAGE-ACCEPT #11)', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, includeActivity: true, activityResolution: 'both' });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: usageQaAccountingFixture() }] }, bundledUsageModelPriceCatalog).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const identity = vi.fn();
        const caption = vi.fn();
        await renderScreen(<WidgetFrameBodyIdentityContext.Provider value={identity}>
            <WidgetFrameBodyCaptionContext.Provider value={caption}>
                <UsageRhythmWidget query={query} slice={slice} model={model} serverId="home" id="usage_rhythm" testID="tide"
                    presentation={{ style: 'weekTide' }} />
            </WidgetFrameBodyCaptionContext.Provider>
        </WidgetFrameBodyIdentityContext.Provider>);
        expect(identity).toHaveBeenLastCalledWith({ title: t('usage.board.charts.inputWeekTide') });
        expect(caption.mock.lastCall?.[0]).not.toContain(t('usage.board.charts.inputWeekTide'));
    });
    it('draws the weekday × hour matrix at a half-width card and the 24-hour rhythm only where a phone cannot hold it', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, includeActivity: true, activityResolution: 'both' });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: usageQaAccountingFixture() }] }, bundledUsageModelPriceCatalog).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const at = (width: number) => renderScreen(<WidgetPresentationProvider value={{ size: 'medium',
            footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width, height: 260 } }}>
            <UsageRhythmWidget query={query} slice={slice} model={model} serverId="home" id="usage_rhythm" testID="rhythm" />
        </WidgetPresentationProvider>);
        const half = await at(430);
        expect(half.findByTestId('rhythm.punchcard')).not.toBeNull();
        expect(half.findByTestId('rhythm.hours')).toBeNull();
        const phone = await at(320);
        expect(phone.findByTestId('rhythm.punchcard')).toBeNull();
        expect(phone.findByTestId('rhythm.hours')).not.toBeNull();
        const unmeasured = await renderScreen(<UsageRhythmWidget query={query} slice={slice} model={model}
            serverId="home" id="usage_rhythm" testID="rhythm" />);
        expect(unmeasured.findByTestId('rhythm.punchcard')).not.toBeNull();
        act(() => unmeasured.findHostByTestId('rhythm.rhythm')!.props.onLayout({
            nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 200 } },
        }));
        expect(unmeasured.findByTestId('rhythm.punchcard')).toBeNull();
        expect(unmeasured.findByTestId('rhythm.hours')).not.toBeNull();
    });
    // USAGE-ACCEPT 1122 #37: "Unknown" read as an Agent's name; it says what is missing, as Models says "not reported".
    it('does not invent a Legacy Agent for scalar reports with unknown attribution', () => {
        expect(usageAgentTitle('legacy')).toBe(t('usage.board.page.agentNotReported'));
        expect(usageAgentTitle('unknown', 'Unknown agent')).toBe(usageAgentTitle(''));
        expect(usageDimensionLabel('agent', 'legacy', 'Legacy')).toBe(t('usage.board.page.agentNotReported'));
        expect(usageAgentTitle('custom-acp')).toBe('Custom ACP Agent');
    });
    it('projects known accounting producers as usage, not technical ingestion names', () => {
        for (const source of ['legacy', 'legacy_usage_report']) {
            expect(usageSourceTitle(source)).toBe(t('usage.board.page.sourceAccounting'));
        }
        expect(usageSourceTitle('legacy', 'Legacy')).toBe(t('usage.board.page.sourceAccounting'));
        expect(usageSourceTitle('claude-assistant-usage')).toBe(t('usage.board.page.sourceClaudeResponses'));
        expect(usageSourceTitle('claude-sdk-result')).toBe(t('usage.board.page.sourceClaudeSessionSummaries'));
        expect(usageSourceTitle('claude-assistant-usage')).not.toBe(usageSourceTitle('claude-sdk-result'));
        expect(usageSourceAgentId('claude-assistant-usage')).toBe('claude');
        expect(usageSourceAgentId('claude-sdk-result')).toBe('claude');
        for (const source of ['codex-native-accounting', 'codex-app-server-token-usage']) {
            expect(usageSourceTitle(source)).toBe(`${t('usage.board.page.sourceAccounting')} · ${usageAgentTitle('codex')}`);
        }
        // These ids are emitted by the native accounting codecs too.
        for (const agent of ['pi', 'opencode']) {
            const source = `${agent}-native-accounting`;
            expect(usageSourceAgentId(source)).toBe(agent);
            expect(usageSourceTitle(source)).toBe(`${t('usage.board.page.sourceAccounting')} · ${usageAgentTitle(agent)}`);
        }
        expect(usageSourceTitle('claude-sdk-result', 'Research capture')).toBe('Research capture');
        expect(usageSourceTitle('claude-sdk-result', 'Claude SDK Result')).toBe(t('usage.board.page.sourceClaudeSessionSummaries'));
    });
    it('says coverage once per page: passive gaps live in Sources, only reading and failure stay beside a body', () => {
        const gap = (status: 'partial' | 'stale' | 'pending' | 'not_loaded' | 'error' | 'unsupported') => ({ source: 'how_you_work', status });
        // On the Usage page the Sources chooser carries the one quiet coverage dot and its detail.
        expect(usageCoverageLineMode([gap('partial'), gap('stale'), gap('unsupported')], true)).toBe('hidden');
        // A source still being read is one cause: the page header says it once, the bodies hold their room.
        expect(usageCoverageLineMode([gap('pending'), gap('not_loaded')], true)).toBe('hidden');
        // A failed page read is one cause too: the header says it once and the bodies inherit it quietly.
        expect(usageCoverageLineMode([gap('partial'), gap('error')], true)).toBe('hidden');
        // A widget's own read (a comparison, a pool selection) is not in the header, so its body says it.
        expect(usageCoverageLineMode([{ source: 'comparison', status: 'error' }], true)).toBe('failed');
        // Off the page (Home, Project, Session hosts) nothing else says it, so the detail stays.
        expect(usageCoverageLineMode([gap('partial')], false)).toBe('detail');
        expect(usageCoverageLineMode([], false)).toBe('hidden');
    });

    it('a body\'s own line says an incomplete read in one quiet clause; the full wording stays for the Sources chooser', () => {
        const slice = (status: 'partial' | 'pending' | 'error') => ({ sources: [
            { source: 'claude-assistant-usage', status }, { source: 'claude-sdk-result', status }, { source: 'quota', status },
        ] }) as unknown as UsageQueryResultSlice;
        const partial = slice('partial');
        expect(usageCoverageSummary(partial, ['quota', 'claude-assistant-usage', 'claude-sdk-result'])).toBe('Partial history');
        expect(usageCoverageDescription(partial, ['quota', 'claude-assistant-usage', 'claude-sdk-result'])).toContain(usageSourceTitle('quota'));
        // A read still going, or failed, keeps naming what it is waiting on or what failed.
        expect(usageCoverageSummary(slice('pending'), ['quota'])).toBe(t('usage.board.page.coveragePending', { sources: usageSourceTitle('quota') }));
        expect(usageCoverageSummary(slice('error'), ['quota'])).toContain(usageSourceTitle('quota'));
        expect(usageCoverageSummary({ sources: [] } as unknown as UsageQueryResultSlice, ['quota'])).toBe('');
    });

    it('keeps settled incomplete allowance coverage visible through refresh and removes it only when history completes', async () => {
        const recordKey = { providerId: 'codex', accountSubjectId: 'work', subjectKind: 'account', quotaScope: 'account' } as const;
        const current = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey),
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'work' }, observedAtMs: 100, fetchedAtMs: 100,
            staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
        const source = QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account',
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } });
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 200 } });
        const sliceFor = (complete: boolean) => resolveUsagePageAggregation({ queries: [query],
            quota: { status: 'available', asOfMs: 100, value: [projectProviderAccountUsageQuotaReadV1({ input: { source },
                current, nowMs: 200, history: { entries: [], nextCursor: complete ? null : { id: 'next', observedAtMs: 50 } } })] },
        }, bundledUsageModelPriceCatalog).results[0]!;
        const settled = sliceFor(false);
        const screen = await renderScreen(<UsageCoverageLine slice={settled} sources={['quota']} testID="settled-coverage" />);
        expect.soft(usageCoverageSummary(settled, ['quota'])).toBe('Partial history');
        expect.soft(screen.findHostByTestId('settled-coverage') !== null).toBe(true);
        const before = screen.getTextContent();
        await screen.update(<UsageCoverageLine slice={{ ...settled, pending: true }} sources={['quota']} testID="settled-coverage" />);
        expect(screen.getTextContent()).toBe(before);
        await screen.update(<UsageCoverageLine slice={sliceFor(true)} sources={['quota']} testID="settled-coverage" />);
        expect(screen.findHostByTestId('settled-coverage') === null).toBe(true);
    });

    it('reports completeness for demanded daily facts independently of unrequested exact ended history', () => {
        const source = QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account',
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'daily' } });
        const read = { ...projectProviderAccountUsageQuotaReadV1({ input: { source }, current: null,
            history: { entries: [], nextCursor: null }, daySummaries: [], nowMs: 200 }),
            unusedCapacity: { historyStatus: 'not_loaded' as const, windows: [] } };
        const dailyQuery = normalizeUsageQuery({ period: { relative: 'year' }, includeQuotaExactHistory: false });
        const slice = (query = dailyQuery, partial = false) => resolveUsagePageAggregation({ queries: [query],
            quota: { status: 'available', value: [{ ...read, pageFacts: { ...read.pageFacts!, historyStatus: partial ? 'partial' : 'complete' } }] },
        }, bundledUsageModelPriceCatalog).results[0]!;
        expect.soft(readUsageCoverageGaps(slice(), ['quota'])).toEqual([]);
        const legacyExact = slice();
        expect.soft(readUsageCoverageGaps({ ...legacyExact,
            quota: legacyExact.quota?.map(({ pageFacts: _pageFacts, ...value }) => value) }, ['quota']))
            .toContainEqual(expect.objectContaining({ source: 'quota', status: 'partial' }));
        expect(readUsageCoverageGaps(slice(dailyQuery, true), ['quota']))
            .toContainEqual(expect.objectContaining({ source: 'quota', status: 'partial' }));
    });

    it('names every source still being read once for the page header', () => {
        const slice = (sources: readonly Readonly<{ source: string; status: 'pending' | 'not_loaded' | 'available' | 'partial' }>[]) =>
            ({ sources }) as unknown as Parameters<typeof describeUsagePagePendingSources>[0][number];
        expect(describeUsagePagePendingSources([slice([{ source: 'quota', status: 'pending' }]),
            slice([{ source: 'quota', status: 'not_loaded' }, { source: 'accounting', status: 'available' }])]))
            .toBe(t('usage.board.page.coveragePending', { sources: usageSourceTitle('quota') }));
        expect(describeUsagePagePendingSources([slice([{ source: 'accounting', status: 'partial' }])])).toBeNull();
        // A widget's own read (a pool selection) is said by that widget, not listed in the page header.
        expect(describeUsagePagePendingSources([slice([{ source: 'selection:openai-codex-pool', status: 'pending' }])])).toBeNull();
    });
    it('says a read the server is too old for as "needs a newer server", not as a failure to retry', async () => {
        const server = { kind: 'update_required', operation: 'session.detail', component: 'server', reason: 'session_read_batch_unsupported' } as const;
        const client = { ...server, component: 'client', reason: 'access_projection_version_unsupported' } as const;
        const slice = (sources: readonly { source: string; status: string; errorCode?: string; updateRequired?: unknown }[]) =>
            ({ sources }) as unknown as UsageQueryResultSlice;
        const upgrade = slice([{ source: 'accounting', status: 'available' },
            { source: 'how_you_work', status: 'error', errorCode: 'update_required', updateRequired: server }]);
        const newer = t('usage.board.page.coverageNeedsNewerServer', { sources: usageSourceTitle('how_you_work') });
        // The page header: the unsupported detail is named once as needing a newer server, never as a failed read.
        expect.soft(readUsagePageFailure([upgrade])).toBeNull();
        expect.soft(describeUsagePageNewerServerSources([upgrade])).toBe(newer);
        // Another component's requirement keeps the ordinary failure wording (it is not relabelled as a server update).
        const workUpgrade = slice([{ source: 'work', status: 'unsupported', errorCode: 'update_required', updateRequired: server }]);
        expect.soft(readUsagePageFailure([workUpgrade])).toBeNull();
        expect.soft(describeUsagePageNewerServerSources([workUpgrade]))
            .toBe(t('usage.board.page.coverageNeedsNewerServer', { sources: usageSourceTitle('work') }));
        const clientSlice = slice([{ source: 'how_you_work', status: 'error', errorCode: 'update_required', updateRequired: client }]);
        expect.soft(describeUsagePageNewerServerSources([clientSlice])).toBeNull();
        expect.soft(readUsagePageFailure([clientSlice])?.reason).toBe(t('usage.board.page.coverageFailed', { sources: usageSourceTitle('how_you_work') }));
        // A body's own line off the Usage page: the same sentence, and no Retry, because retrying cannot help.
        const onRetry = vi.fn();
        const screen = await renderScreen(<UsageCoverageLine slice={upgrade} sources={['how_you_work']} onRetry={onRetry} testID="upgrade-coverage" />);
        expect.soft(screen.getTextContent()).toContain(newer);
        expect.soft(screen.getTextContent()).not.toContain(t('usage.board.page.coverageFailed', { sources: usageSourceTitle('how_you_work') }));
        expect(screen.getTextContent()).not.toContain(t('common.retry'));
    });
    it('discloses confirmed offline Work without Retry and keeps failed reads actionable', async () => {
        const query = normalizeUsageQuery({ includeWorkEvidence: true });
        const slice = resolveUsagePageAggregation({ queries: [query] }, bundledUsageModelPriceCatalog).results[0]!;
        const workSource = slice.sources.find(source => source.source === 'work')!;
        const onRetry = vi.fn();
        const render = (source: UsageQueryResultSlice['sources'][number]) =>
            <UsageCoverageLine slice={{ ...slice, sources: [source] }} sources={['work']} onRetry={onRetry} testID="work-coverage" />;
        const offline = { ...workSource, status: 'unknown' as const,
            errorCode: 'machine_offline', unreadSessions: { machine_unavailable: 2 } };
        const screen = await renderScreen(render(offline));
        const failed = t('usage.board.page.coverageFailed', { sources: usageSourceTitle('work') });
        expect.soft(screen.getTextContent()).toContain(t('usage.board.page.workMachinesOffline'));
        expect.soft(screen.getTextContent()).not.toContain(failed);
        expect.soft(screen.getTextContent()).not.toContain(t('common.retry'));

        await screen.update(render({ ...offline, status: 'partial' }));
        expect.soft(screen.getTextContent()).toContain(t('usage.board.page.workMachinesOffline'));
        expect.soft(screen.getTextContent()).not.toContain(t('common.retry'));

        await screen.update(render({ ...workSource, status: 'unknown', unreadSessions: { machine_unavailable: 2 } }));
        expect.soft(screen.getTextContent()).not.toContain(t('usage.board.page.workMachinesOffline'));
        expect.soft(screen.getTextContent()).not.toContain(t('common.retry'));

        await screen.update(render({ ...workSource, status: 'pending' }));
        expect.soft(screen.getTextContent()).toContain(t('usage.board.page.coveragePending', { sources: usageSourceTitle('work') }));
        expect.soft(screen.getTextContent()).not.toContain(t('common.retry'));

        for (const status of ['error', 'stale', 'partial'] as const) {
            await screen.update(render({ ...workSource, status, errorCode: 'work_evidence_failed', unreadSessions: { failed: 1 } }));
            expect.soft(screen.getTextContent()).toContain(failed);
            expect.soft(screen.getTextContent()).toContain(t('common.retry'));
        }
    });
    it('names a failed page read once for the header, never a widget-own read', () => {
        const slice = (sources: readonly { source: string; status: string }[]) =>
            ({ sources }) as unknown as Parameters<typeof readUsagePageFailure>[0][number];
        expect(readUsagePageFailure([slice([{ source: 'work', status: 'error' }]), slice([{ source: 'work', status: 'error' }])])?.reason)
            .toBe(t('usage.board.page.workNotRead'));
        expect(readUsagePageFailure([slice([{ source: 'comparison', status: 'error' }])])).toBeNull();
        expect(readUsagePageFailure([slice([{ source: 'work', status: 'pending' }])])).toBeNull();
    });
    it('describes Work that settled with evidence even when Retry cannot help (G1)', () => {
        const slice = (work: Readonly<Record<string, unknown>>) =>
            ({ sources: [{ source: 'work', ...work }] }) as unknown as Parameters<typeof readUsagePageFailure>[0][number];
        const header = (work: Readonly<Record<string, unknown>>) => {
            const failure = readUsagePageFailure([slice(work)]);
            return { reason: failure?.reason ?? null, retry: failure?.retryable ?? false, offline: readUsagePageWorkOffline([slice(work)]),
                refused: failure?.scopeRefusal != null };
        };
        const failedWork = t('usage.board.page.coverageFailed', { sources: usageSourceTitle('work') });
        const offline = { status: 'partial', errorCode: 'machine_offline', unreadSessions: { machine_unavailable: 1229 } };
        expect.soft(header(offline)).toEqual({ reason: null, retry: false, offline: false, refused: false });
        expect.soft(describeUsagePagePartialSources([slice(offline)]))
            .toBe(t('usage.board.page.coverageWitnessed', { sources: usageSourceTitle('work') }));
        // Some Sessions failed retryably inside the settled answer: a quiet true line in the page's partial-coverage
        // pattern, with the page's one Retry; never the outage line (ruling 11-25 00:15Z).
        expect.soft(header({ status: 'partial', errorCode: 'work_evidence_failed', unreadSessions: { machine_unavailable: 1229, failed: 2 } }))
            .toEqual({ reason: t('usage.board.page.coverageWitnessed', { sources: usageSourceTitle('work') }), retry: true, offline: false, refused: false });
        expect.soft(header({ status: 'available' })).toEqual({ reason: null, retry: false, offline: false, refused: false });
        // A quiet reread of a settled answer says nothing either.
        expect.soft(header({ status: 'pending', asOfMs: 100 })).toEqual({ reason: null, retry: false, offline: false, refused: false });
        // Nothing read: the outage line and its Retry; Machines offline with nothing read keeps the offline line.
        expect.soft(header({ status: 'error', errorCode: 'work_evidence_failed' }))
            .toEqual({ reason: t('usage.board.page.workNotRead'), retry: true, offline: false, refused: false });
        expect.soft(header({ status: 'unknown', errorCode: 'machine_offline' })).toEqual({ reason: null, retry: false, offline: true, refused: false });
        // A failed reread over retained links: what is listed is what arrived, and a Retry can replace it.
        expect.soft(header({ status: 'stale', errorCode: 'work_evidence_failed', asOfMs: 100 }))
            .toEqual({ reason: failedWork, retry: true, offline: false, refused: false });
        expect.soft(header({ status: 'stale', errorCode: 'database_transaction_timeout', asOfMs: 100, unreadSessions: { failed: 1 } }))
            .toMatchObject({ reason: failedWork, retry: true });
        expect.soft(header({ status: 'error', errorCode: 'forbidden', unreadSessions: { not_entitled: 1, failed: 1 } }))
            .toMatchObject({ retry: true, refused: true });
        // A typed refusal keeps its own line, never a Retry.
        expect.soft(header({ status: 'error', errorCode: 'forbidden' })).toEqual({ reason: '', retry: false, offline: false, refused: true });
    });
    it('folds every batch entry into the one header Retry for a settled Work gap, beside a complete ledger read and other failures (J-B46)', () => {
        const slice = (...sources: readonly Readonly<Record<string, unknown>>[]) =>
            ({ sources }) as unknown as Parameters<typeof readUsagePageFailure>[0][number];
        const gap = { source: 'work', status: 'partial', errorCode: 'work_evidence_failed', unreadSessions: { failed: 1 } };
        const witnessed = t('usage.board.page.coverageWitnessed', { sources: usageSourceTitle('work') });
        // A saved view: a ledger pinned to a period whose Work read is complete, and Outcomes following a partial one.
        expect.soft(readUsagePageFailure([slice({ source: 'work', status: 'available' }), slice(gap)])).toMatchObject({ reason: witnessed, retryable: true, quiet: true });
        // Two bodies following the same partial scope: still one line and one Retry.
        expect.soft(readUsagePageFailure([slice(gap), slice(gap)])).toMatchObject({ reason: witnessed, retryable: true });
        // Another page read failed too: one line names both, one Retry rereads both.
        expect.soft(readUsagePageFailure([slice(gap, { source: 'accounting', status: 'error' })])).toMatchObject({ retryable: true,
            reason: t('usage.board.page.coverageFailedWitnessed', { sources: usageSourceTitle('accounting'), witnessed: usageSourceTitle('work') }) });
        // The outage line is said only when nothing of Work arrived.
        expect.soft(readUsagePageFailure([slice(gap)])?.reason).not.toBe(t('usage.board.page.workNotRead'));
    });
    it('says a settled partial activity read once for the header, never while it is still reading', () => {
        const slice = (sources: readonly { source: string; status: string }[]) =>
            ({ sources }) as unknown as Parameters<typeof describeUsagePagePartialSources>[0][number];
        expect(describeUsagePagePartialSources([slice([{ source: 'how_you_work', status: 'partial' }, { source: 'how_you_work:sessions', status: 'partial' }]),
            slice([{ source: 'how_you_work', status: 'partial' }])]))
            .toBe(t('usage.board.page.coverageWitnessed', { sources: usageSourceTitle('how_you_work') }));
        // Still reading is the pending fact's line; a failure is the failed fact's line.
        expect(describeUsagePagePartialSources([slice([{ source: 'how_you_work', status: 'pending' }])])).toBeNull();
        expect(describeUsagePagePartialSources([slice([{ source: 'how_you_work', status: 'error' }])])).toBeNull();
        // Partial usage history is the Sources chooser's coverage detail, not a page read that missed Sessions.
        expect(describeUsagePagePartialSources([slice([{ source: 'accounting', status: 'partial' }])])).toBeNull();
        // A quiet reread keeps the last settled partial fact; a first read never claims one from its detail.
        const reread = (asOfMs?: number) => ({ sources: [{ source: 'how_you_work', status: 'pending', ...(asOfMs === undefined ? {} : { asOfMs }) }],
            howYouWork: { detailStatus: 'partial' } }) as unknown as Parameters<typeof describeUsagePagePartialSources>[0][number];
        expect(describeUsagePagePartialSources([reread(100)])).toBe(t('usage.board.page.coverageWitnessed', { sources: usageSourceTitle('how_you_work') }));
        expect(describeUsagePagePartialSources([reread()])).toBeNull();
        // Beside a failed read, the one "Couldn't read" fact names both and says "Showing what arrived" once.
        const both = [slice([{ source: 'work', status: 'error' }, { source: 'how_you_work', status: 'partial' }])];
        expect(describeUsagePagePartialSources(both)).toBeNull();
        expect(readUsagePageFailure(both)?.reason).toBe(t('usage.board.page.coverageFailedWitnessed', {
            sources: usageSourceTitle('work'), witnessed: usageSourceTitle('how_you_work') }));
    });
    it('keeps admitted sources quiet during background refresh while naming an unanswered sibling', () => {
        const query = normalizeUsageQuery({ period: { startMs: 1, endMs: 100 } });
        const [accounting] = resolveUsagePageAggregation({ queries: [query], accounting: [
            { query, status: 'pending', value: usageQaAccountingFixture(), asOfMs: 90, readAtMs: 100 },
        ] }, bundledUsageModelPriceCatalog).results;
        const sources: UsageQueryResultSlice['sources'] = [
            { source: 'accounting', status: 'pending', asOfMs: 90 },
            { source: 'work', status: 'pending', asOfMs: 100 },
            { source: 'how_you_work', status: 'pending', asOfMs: 100 },
            { source: 'quota', status: 'available', asOfMs: 100 },
            { source: 'quota:answered', status: 'pending', asOfMs: 100 },
        ];
        expect(describeUsagePagePendingSources([{ sources }])).toBeNull();
        expect(readUsagePageFreshness([{ ...accounting!, sources }]).asOfMs).toBe(100);
        expect(describeUsagePagePendingSources([{ sources: [...sources, { source: 'quota:unanswered', status: 'pending' }] }]))
            .toBe(t('usage.board.page.coveragePending', { sources: usageSourceTitle('quota') }));
    });
    it('discloses a held account read after sibling allowances have arrived', () => {
        // The aggregate Resource publishes each qualified account independently of its siblings.
        const source = QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account',
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'held' } });
        const held = `quota:${JSON.stringify(source)}`;
        const sources = [{ source: 'quota', status: 'available' }, { source: held, status: 'pending' }] satisfies UsageQueryResultSlice['sources'];
        expect(describeUsagePagePendingSources([{ sources }])).toBe(
            t('usage.board.page.coveragePending', { sources: usageSourceTitle('quota') }));
        expect(describeUsagePagePendingSources([{ sources: sources.map(source => ({ ...source, status: 'available' })) }])).toBeNull();
    });
    it('does not call undemanded work and activity reads pending after accounting-only slices settle', () => {
        const query = normalizeUsageQuery({ period: { startMs: 100 }, includeWorkEvidence: false, includeSessionEvidence: false });
        const settled = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available',
            value: usageQaAccountingFixture() }], quota: { status: 'unsupported' } }, bundledUsageModelPriceCatalog).results;
        expect(settled[0]?.pending).toBe(false);
        expect(describeUsagePagePendingSources(settled)).toBeNull();
        const demanded = normalizeUsageQuery({ ...query, includeWorkEvidence: true, includeSessionEvidence: true });
        const reading = resolveUsagePageAggregation({ queries: [demanded], work: [{ query: demanded, status: 'pending' }],
            accounting: [{ query: demanded, status: 'available', value: usageQaAccountingFixture() }], quota: { status: 'unsupported' },
            sources: [{ source: 'how_you_work', status: 'pending' }] }, bundledUsageModelPriceCatalog).results;
        expect(describeUsagePagePendingSources(reading)).toBe(t('usage.board.page.coveragePending', {
            sources: [usageSourceTitle('work'), usageSourceTitle('how_you_work')].join(', '),
        }));
    });
    it('dates the header by a fresh accounting read beside a retained older scope and newer quota', () => {
        const olderRead = new Date(2026, 10, 19, 9).getTime();
        const currentRead = new Date(2026, 10, 19, 12).getTime();
        const oldObservation = Date.UTC(2026, 9, 10, 2, 6);
        const earlier = normalizeUsageQuery({ period: { startMs: Date.UTC(2026, 10, 12) } });
        const current = normalizeUsageQuery({ period: { startMs: Date.UTC(2026, 10, 13) } });
        const value = usageQaAccountingFixture();
        const previous = resolveUsagePageAggregation({ queries: [earlier], accounting: [
            { query: earlier, value, status: 'available', asOfMs: oldObservation, readAtMs: olderRead },
        ] }, bundledUsageModelPriceCatalog);
        const { results } = resolveUsagePageAggregation({ queries: [earlier, current], previous, accounting: [
            { query: earlier, status: 'error', errorCode: 'usage_query_failed' },
            { query: current, value, status: 'available', asOfMs: currentRead - 1, readAtMs: currentRead },
        ], quota: { status: 'available', asOfMs: currentRead + 100 },
        sources: [{ source: 'how_you_work', status: 'available', asOfMs: currentRead + 200 }] },
        bundledUsageModelPriceCatalog);
        expect(readUsagePageFreshness(results)).toMatchObject({ asOfMs: currentRead, retainedAccountingReadAtMs: olderRead });
        expect(readUsagePageFreshness([previous.results[0]!, results[1]!])).toMatchObject({
            asOfMs: currentRead, retainedAccountingReadAtMs: null,
        });
        expect(readUsagePageFreshness([results[0]!]).asOfMs).toBe(olderRead);
        expect(results[0]?.sources.find(source => source.source === 'accounting')?.asOfMs).toBe(oldObservation);
        expect(readUsagePageFreshness([{ sources: [
            { source: 'accounting', status: 'pending' },
            { source: 'quota', status: 'available', asOfMs: currentRead },
        ] }]).asOfMs).toBeNull();
        expect(readUsagePageFreshness([{ accounting: value, sources: [
            { source: 'accounting', status: 'available', asOfMs: oldObservation },
            { source: 'quota', status: 'available', asOfMs: currentRead },
        ] }]).asOfMs).toBeNull();
        const today = new Date(2026, 10, 18, 16).getTime();
        expect(isUsageObservationFromEarlierDay(new Date(2026, 10, 13, 6).getTime(), today)).toBe(true);
        expect(isUsageObservationFromEarlierDay(new Date(2026, 10, 18, 6).getTime(), today)).toBe(false);
        expect(isUsageObservationFromEarlierDay(new Date(2026, 10, 19, 6).getTime(), today)).toBe(false);
    });
    it('includes retained allowance observations while a refresh has only its conservative aggregate source date', () => {
        const readAt = (accountId: string, atMs: number, state: 'loaded_empty' | 'not_loaded' = 'loaded_empty') => {
            const recordKey = { providerId: 'codex', accountSubjectId: accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
            const current = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey),
                providerId: 'codex', accountSubject: { kind: 'providerSubject', id: accountId }, observedAtMs: atMs, fetchedAtMs: atMs,
                staleAfterMs: 100, source: 'providerHttp', confidence: 'confirmed', state, meters: [] });
            return projectProviderAccountUsageQuotaReadV1({ input: { source: { bindingKind: 'account',
                ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId } } }, current, nowMs: 200 });
        };
        const query = normalizeUsageQuery({ period: { startMs: 100 } });
        const slices = resolveUsagePageAggregation({ queries: [query], quota: { status: 'partial', asOfMs: 100,
            value: [readAt('older', 100), readAt('newer', 200)] } }, bundledUsageModelPriceCatalog).results;
        expect(readUsagePageFreshness(slices).asOfMs).toBe(200);
        expect(slices[0]?.sources.find(source => source.source === 'quota')?.asOfMs).toBe(100);
        expect(readUsagePageFreshness([{ sources: [], quota: [readAt('never', 0, 'not_loaded')] }]).asOfMs).toBeNull();
    });
    it('humanizes unknown qualified producer identities without replacing a supplied display title', () => {
        const producer = 'third.party/research:remote';
        expect(usageAgentTitle(producer, producer)).toBe('Third Party Research Remote');
        expect(usageAgentTitle(producer, 'Research lab Agent')).toBe('Research lab Agent');
        expect(usageSourceTitle(`native:${producer}`)).not.toContain(producer);
        expect(usageSourceTitle(`native:${producer}`)).not.toMatch(/[/:]/);
    });
    it('uses catalog model names in Flow for both source partitions and the unpartitioned mix', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 2 * 86_400_000 }, metric: 'tokens', breakdown: ['model'] });
        const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
        const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
        const sliceFor = (partitioned: boolean) => resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { eventCount: 2, tokens: { ...tokens, total: 20, input: 20 }, cost }, modelTimeline: [0, 86_400_000].map(bucketStartMs => ({ bucketStartMs, bucketEndMs: bucketStartMs + 86_400_000,
                leaders: [{ key: 'claude-fable-5', label: 'claude-fable-5', eventCount: 1, tokens, cost,
                    ...(partitioned ? { sources: [{ source: 'runtime', path: 'runtime' as const, execution: 'happier' as const, eventCount: 1, tokens, cost }] } : {}) }] })),
        } }] }, bundledUsageModelPriceCatalog).results[0]!;
        const slice = sliceFor(true);
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const screen = await renderScreen(<UsageFlowWidget query={query} slice={slice} model={model} serverId="home" id="usage_flow" testID="flow-model" />);
        expect(screen.findByType(StackedSeriesChart).props.series[0].label).toBe('Fable 5');
        await screen.update(<UsageFlowWidget query={query} slice={sliceFor(false)} model={model} serverId="home" id="usage_flow" testID="flow-model" />);
        expect(screen.findByType(StackedSeriesChart).props.series[0].label).toBe('Fable 5');
    });
    it('projects catalog model names and canonical machine names instead of raw identities', () => {
        expect(usageDimensionLabel('model', 'claude-haiku-4-5-20251001')).toBe(usageDimensionLabel('model', 'claude-haiku-4-5'));
        expect(usageDimensionLabel('model', 'claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
        expect(usageDimensionLabel('model', 'claude-fable-5', undefined, new Map())).toBe('Fable 5');
        expect(usageDimensionLabel('machine', 'machine-uuid', 'machine-uuid', new Map([['machine-uuid', 'Build Mac']]))).toBe('Build Mac');
        expect(usageDimensionLabel('machine', 'missing-uuid', undefined, new Map())).toBe(t('machine.unlistedMachine'));
    });
    it('preserves genuine contributed model and source titles and raw unknown model ids', () => {
        expect(usageDimensionLabel('model', 'third-party/model-snapshot', 'Research-Lab Model / Preview')).toBe('Research-Lab Model / Preview');
        expect(usageDimensionLabel('model', 'third-party/model-snapshot', 'third-party/model-snapshot')).toBe('third-party/model-snapshot');
        expect(usageSourceTitle('native:third.party/research:remote', 'Research-Lab Capture / Preview')).toBe('Research-Lab Capture / Preview');
    });
    it('keeps the date of historical coverage instead of presenting an old observation as today', () => {
        const timestamp = new Date(2024, 3, 22, 9, 15).getTime();
        const now = new Date(2024, 3, 23, 9, 15).getTime();
        // The current year goes unsaid; another year's date carries it (acceptance 11-22 #27).
        expect(formatUsageObservedAt(timestamp, now, 'en')).toBe(new Intl.DateTimeFormat('en', {
            hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric',
        }).format(timestamp));
        const lastYear = new Date(2023, 11, 30, 9, 15).getTime();
        expect(formatUsageObservedAt(lastYear, now, 'en')).toBe(new Intl.DateTimeFormat('en', {
            hour: 'numeric', minute: '2-digit', year: 'numeric', month: 'short', day: 'numeric',
        }).format(lastYear));
        expect(formatUsageObservedAt(now, now, 'en')).toBe(new Intl.DateTimeFormat('en', {
            hour: 'numeric', minute: '2-digit',
        }).format(now));
    });
    it('keeps Agent identity and execution source partitions in mounted Daily and Flow charts', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, metric: 'tokens' });
        const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
        const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' };
        const totalCost = { ...cost, reportedUsd: 3 };
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { eventCount: 3, tokens: { ...tokens, total: 30, input: 30 }, cost: totalCost },
            engineTimeline: [{ bucketStartMs: 0, bucketEndMs: 86_400_000, leaders: [{ key: 'codex:local', eventCount: 3,
                tokens: { ...tokens, total: 30, input: 30 }, cost: totalCost, sources: [
                    { source: 'runtime', path: 'runtime', execution: 'happier', eventCount: 1, tokens, cost },
                    { source: 'native', path: 'native', execution: 'outside', eventCount: 1, tokens, cost },
                    { source: 'older', path: 'unknown', execution: 'unknown', eventCount: 1, tokens, cost },
                ] }] }],
        } }] }, bundledUsageModelPriceCatalog).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const props = { query, slice, model, serverId: 'home' };
        const screen = await renderScreen(<><UsageDailyWidget {...props} id="usage_daily" testID="daily" />
            <UsageFlowWidget {...props} id="usage_flow" testID="flow" /></>);
        const charts = screen.findAllByType(StackedSeriesChart);
        for (const chart of charts) {
            expect(chart.props.series).toHaveLength(1);
            expect(chart.props.series.map((entry: { points: { y: number }[] }) => entry.points[0]!.y)).toEqual([30]);
            expect(new Set(chart.props.series.map((entry: { color: string }) => entry.color)).size).toBe(1);
            expect(chart.props.series[0].sourceDetails['0'].map((part: { value: number }) => part.value)).toEqual([10, 10, 10]);
            expect(chart.props.series.every((entry: { label: string }) => entry.label.includes('Codex'))).toBe(true);
            expect(Object.values(chart.props.leads as Record<string, React.ReactElement<{ agentId: string }>>)
                .every(mark => mark.props.agentId === 'codex')).toBe(true);
        }
        // Without a producer-selected common monetary basis, source costs must not be stacked.
        const costScreen = await renderScreen(<UsageDailyWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'cost' })}
            id="usage_daily" testID="cost" />);
        expect(costScreen.findAllByType(StackedSeriesChart).flatMap(chart => chart.props.series)
            .some((entry: { fillPattern?: string }) => entry.fillPattern === 'hatch')).toBe(false);
        const pricedScreen = await renderScreen(<UsageDailyWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'cost' })}
            slice={{ ...slice, accounting: { ...slice.accounting!, costPresentation: { mode: 'auto', effectiveUsd: 3, currency: 'USD', source: 'provider_reported' } } }}
            id="usage_daily" testID="priced" />);
        expect(pricedScreen.findByType(StackedSeriesChart).props.series.map((entry: { points: { y: number }[] }) => entry.points[0]!.y)).toEqual([3]);
    });
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
        } }] }, bundledUsageModelPriceCatalog).results[0]!;
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
    it('uses the producer admitted calendar bounds for All, including an empty period', () => {
        const fixture = usageQaAccountingFixture();
        const endMs = Date.parse('2026-11-04T15:00:00Z');
        const startMs = Date.parse('2026-11-02T22:00:00Z');
        const query = normalizeUsageQuery({ period: { relative: 'all' }, timeZoneOffsetMinutes: 120 });
        const populated = projectUsageAnalyticsSummary({ ...fixture, contributions: [{ ...fixture.contributions![0]!,
            observedAtMs: Date.parse('2026-11-03T13:00:00Z') }] }, UsageAnalyticsQueryRequestSchema.parse({
            dateRange: { startMs, endMs }, granularity: 'day', timeZoneOffsetMinutes: 120, includeActivity: true,
        }));
        expect(resolveUsageShownCalendarRange(query, populated.coverage, populated)).toEqual({
            startMs, endMs, granularity: 'day', timeZoneOffsetMinutes: 120,
        });
        // A rich response with retained series/activity is not an empty Account.
        const empty = projectUsageAnalyticsSummary({ v: 1, contributions: [], series: [],
            totals: { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' }, eventCount: 0 },
            activity: { calendarDays: [], weekdayHourBuckets: [] } }, UsageAnalyticsQueryRequestSchema.parse({
            dateRange: { startMs: endMs, endMs }, granularity: 'day', timeZoneOffsetMinutes: 120, includeActivity: true,
        }));
        expect(empty.summary?.accountingCalendar?.value.days).toEqual([]);
        expect(resolveUsageShownCalendarRange(query, empty.coverage, empty)).toEqual({
            startMs: endMs, endMs, granularity: 'day', timeZoneOffsetMinutes: 120,
        });
    });
    it('bounds older all-time and activity-only responses by their witnessed dates without using source freshness', () => {
        const accounting = usageQaAccountingFixture();
        const all = normalizeUsageQuery({ period: { relative: 'all' }, timeZoneOffsetMinutes: 120 });
        expect(resolveUsageShownCalendarRange(all, accounting.coverage, accounting)).toMatchObject({
            startMs: Date.parse('2026-10-08T22:00:00Z'),
            endMs: accounting.contributions!.reduce((latest, row) => Math.max(latest, row.observedAtMs), 0) + 1,
        });
        const older = { ...accounting, contributions: undefined, series: [] };
        expect(resolveUsageShownCalendarRange(normalizeUsageQuery({ period: { relative: '7days' }, timeZoneOffsetMinutes: 120 }),
            older.coverage, older)).toMatchObject({
            startMs: Date.parse('2026-10-04T22:00:00Z'), endMs: Date.parse('2026-10-11T22:00:00Z'),
        });
        expect(resolveUsageShownCalendarRange(all)).toBeNull();
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
    it('keeps empty accounting coverage unknown without claiming missing history or missing-source events', () => {
        const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 } });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { tokens: { total: null, input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
                cost: { reportedUsd: null, estimatedUsd: null, currency: 'USD' }, eventCount: 0 },
            coverage: { status: 'unknown', reasons: [], sources: [], missingDimensions: [],
                range: { startMs: 1000, endMs: 2000, complete: false }, ranked: [] },
        } }] }, bundledUsageModelPriceCatalog).results[0]!;
        expect(readUsageCoverageGaps(slice, ['accounting'])).toEqual([{ source: 'accounting', status: 'unknown' }]);
        expect(usageCoverageDescription(slice, ['accounting'])).toBe(t('usage.board.sources.coverageUnknown'));
        expect(usageCoverageSummary(slice, ['accounting'])).toBe(t('usage.board.sources.coverageUnknown'));
        for (const status of ['pending', 'not_loaded'] as const) {
            const mixed = { ...slice, comparison: { query: resolveUsageComparisonQuery(query)!, source: { source: 'comparison', status } } };
            expect(readUsageCoverageGaps(mixed, ['accounting', 'comparison']).map(gap => gap.status)).toEqual(['unknown', status]);
            expect(usageCoverageDescription(mixed, ['accounting', 'comparison'])).toBe(t('usage.board.sources.coverageUnknown'));
            expect(usageCoverageSummary(mixed, ['accounting', 'comparison'])).toBe(t('usage.board.sources.coverageUnknown'));
        }
    });
    it('exposes incomplete native history and unsupported sources even with available accounting transport', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { tokens: { total: 5, input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' }, eventCount: 1 },
            coverage: { status: 'partial', reasons: ['incomplete_history', 'unknown_token_categories'], sources: [
                { source: 'native:claude', path: 'native', status: 'partial', eventCount: 1, historyComplete: false },
                { source: 'native:gemini', path: 'native', status: 'unsupported', eventCount: 0 },
            ], missingDimensions: [], range: { startMs: 0, endMs: 1000, complete: false }, ranked: [] },
        } }] }, bundledUsageModelPriceCatalog).results[0]!;
        expect(readUsageCoverageGaps(slice, ['accounting']).map(gap => gap.source)).toEqual(['accounting', 'native:claude', 'native:gemini']);
        const screen = await renderScreen(<UsageCoverageLine slice={slice} sources={['accounting']} testID="coverage" />);
        expect(screen.getTextContent()).not.toContain('native:claude');
        expect(screen.getTextContent()).not.toContain('native:gemini');
        // A host without the Usage page's Sources detail keeps one quiet clause; the full wording lives in Sources.
        expect(screen.getTextContent()).toContain('Partial history');
        expect(screen.getTextContent()).not.toContain(t('usage.board.page.coverageReason_unknown_token_categories'));
        const detail = usageCoverageDescription(slice, ['accounting']);
        expect(detail).toContain(t('usage.board.page.coverageReason_unknown_token_categories'));
        expect(detail).toContain(t('usage.board.page.coverageReason_incomplete_history'));
        expect(detail).toContain(t('usage.board.sources.unsupported'));
    });
    it('dates incomplete source observations explicitly and advances only when that source changes', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 0 } });
        const observedAt = Date.UTC(2026, 9, 9, 15, 55);
        const later = Date.UTC(2026, 9, 18, 12);
        const sliceFor = (sourceAt: number) => resolveUsagePageAggregation({ queries: [query], accounting: [{
            query, status: 'available', value: { ...usageQaAccountingFixture(), coverage: {
                status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], ranked: [], range: { complete: false },
                sources: [
                    { source: 'native:claude', path: 'native', status: 'partial', eventCount: 1, asOfMs: sourceAt },
                    { source: 'runtime:codex', path: 'runtime', status: 'available', eventCount: 1, asOfMs: later },
                ],
            } },
        }] }, bundledUsageModelPriceCatalog).results[0]!;
        const render = (sourceAt: number) => <UsageCoverageLine slice={sliceFor(sourceAt)} sources={['accounting']} testID="source-date" />;
        const screen = await renderScreen(render(observedAt));
        const expected = (at: number) => `Oldest source update ${formatUsageObservedAt(at)}`;
        expect(screen.getTextContent()).toContain(expected(observedAt));
        // A successful reread of identical producer evidence cannot invent a newer observation.
        await screen.update(render(observedAt));
        expect(screen.getTextContent()).toContain(expected(observedAt));
        await screen.update(render(later));
        expect(screen.getTextContent()).toContain(expected(later));
        expect(screen.getTextContent()).not.toContain(formatUsageObservedAt(observedAt));
        // An available source can be older than the incomplete source. The aggregate
        // accounting observation remains the oldest source update in that case too.
        const olderAvailable = sliceFor(later);
        const accounting = olderAvailable.accounting!;
        const oldest = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            ...accounting, coverage: { ...accounting.coverage!, sources: accounting.coverage!.sources.map(source =>
                source.status === 'available' ? { ...source, asOfMs: observedAt } : source) },
        } }] }, bundledUsageModelPriceCatalog).results[0]!;
        await screen.update(<UsageCoverageLine slice={oldest} sources={['accounting']} testID="source-date" />);
        expect(screen.getTextContent()).toContain(expected(observedAt));
    });
    it('does not treat an available transport without coverage metadata as complete history', () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { tokens: { total: 5, input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' }, eventCount: 1 },
        } }] }, bundledUsageModelPriceCatalog).results[0]!;
        expect(readUsageCoverageGaps(slice, ['accounting'])).toEqual([{ source: 'accounting', status: 'unknown' }]);
        expect(usageCoverageDescription(slice, ['accounting'])).toBe(t('usage.board.sources.coverageUnknown'));
        expect(usageCoverageSummary(slice, ['accounting'])).toBe(t('usage.board.sources.coverageUnknown'));
    });
});
