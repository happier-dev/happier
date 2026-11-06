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
import { usageQaAccountingFixture } from '@/dev/testkit/fixtures/usageQaAccountingFixture';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UsageWidgetBatchProvider } from './usageWidgetBatch';
import { readUsageWidgetQueryOverrides } from '../usageWidgetPageContext';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { usageSourceAgentId } from '@/sync/domains/usage/usageLabels';
import { describeUsagePageFailedSources, describeUsagePageNewerServerSources, describeUsagePagePartialSources, describeUsagePagePendingSources, readUsagePageAsOfMs, readUsageCoverageGaps, isUsageReadOutstanding, UsageCoverageLine, usageCoverageDescription, usageCoverageLineMode, usageCoverageSummary, usagePeriodPhrase, usageDimensionLabel, usageAgentTitle, usageSourceTitle, useSettledBodyHeightFloor, useUsageMeterListFirstReadReserve, useUsageAnalyticsView } from './usageBodyKit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('shared Usage identity and dependent coverage', () => {
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
        ] }).results[0]!;
        const pending = sliceFor('pending');
        expect.soft(isUsageReadOutstanding(pending, ['comparison'])).toBe(true);
        expect.soft(readUsageCoverageGaps(pending, ['comparison'])).toEqual([{ source: 'comparison', status: 'pending' }]);
        expect(isUsageReadOutstanding(sliceFor('available'), ['comparison'])).toBe(false);
        expect.soft(readUsageCoverageGaps(sliceFor('error'), ['comparison'])).toEqual([
            { source: 'comparison', status: 'error', errorCode: 'usage_query_failed' },
        ]);
        const unbounded = resolveUsagePageAggregation({ queries: [normalizeUsageQuery({ period: {} })] }).results[0]!;
        expect(isUsageReadOutstanding(unbounded, ['comparison'])).toBe(false);
    });
    it('preserves unknown model ids exactly instead of inventing names or casing', () => {
        for (const id of ['claude-haiku-6-1', 'gpt-6.1-sol', 'third-party/MODEL-snapshot']) {
            expect(usageDimensionLabel('model', id)).toBe(id);
            expect(usageDimensionLabel('model', id, id)).toBe(id);
        }
    });
    it('holds an unanswered usage read as loading, never as "No usage in this period"', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, granularity: 'day' });
        const slice = resolveUsagePageAggregation({ queries: [query] }).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: true, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const screen = await renderScreen(<UsageDailyWidget query={query} slice={slice} model={model} serverId="home" id="usage_daily" testID="daily" />);
        expect(screen.getTextContent()).not.toContain(t('usage.board.page.noUsageTitle'));
        expect(screen.findByTestId('daily.loading')).toBeTruthy();
    });
    it('holds the settled Daily chart room at every width while the first read is outstanding', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, granularity: 'day' });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'pending' }] }).results[0]!;
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
        const cold = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'pending' }] }).results[0]!;
        const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice: cold, pending: true, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const render = (slice: UsageQueryResultSlice) => <UsageRhythmWidget query={query} slice={slice} model={model}
            serverId="home" id="usage_rhythm" testID="rhythm-read" />;
        const screen = await renderScreen(render(cold));
        expect(screen.findByTestId('rhythm-read.empty')).toBeNull();
        expect(screen.findByTestId('rhythm-read.loading')).not.toBeNull();
        const empty = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            ...usageQaAccountingFixture(), activity: { calendarDays: [], weekdayHourBuckets: [] },
        } }] }).results[0]!;
        await screen.update(render(empty));
        expect(screen.findByTestId('rhythm-read.empty')).not.toBeNull();
        const known = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'pending', value: usageQaAccountingFixture() }] }).results[0]!;
        await screen.update(render(known));
        expect(screen.findByTestId('rhythm-read.rhythm')).not.toBeNull();
        expect(screen.findByTestId('rhythm-read.loading')).toBeNull();
    });
    it('says a failed read as not read, never as zero; on the Usage page the header owns the cause and its Retry', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, granularity: 'day', includeActivity: true, activityResolution: 'both' });
        const failed = resolveUsagePageAggregation({ queries: [query],
            accounting: [{ query, status: 'error', errorCode: 'usage_query_failed' }] }).results[0]!;
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
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }).results[0]!;
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
    it('draws the weekday × hour matrix at a half-width card and the 24-hour rhythm only where a phone cannot hold it', async () => {
        const query = normalizeUsageQuery({ period: { relative: '7days' }, includeActivity: true, activityResolution: 'both' });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: usageQaAccountingFixture() }] }).results[0]!;
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
    it('does not invent a Legacy Agent for scalar reports with unknown attribution', () => {
        expect(usageAgentTitle('legacy')).toBe(t('usage.board.page.unattributed'));
        expect(usageAgentTitle('unknown', 'Unknown agent')).toBe(usageAgentTitle(''));
        expect(usageDimensionLabel('agent', 'legacy', 'Legacy')).toBe(t('usage.board.page.unattributed'));
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
        }).results[0]!;
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
        expect.soft(describeUsagePageFailedSources([upgrade])).toBeNull();
        expect.soft(describeUsagePageNewerServerSources([upgrade])).toBe(newer);
        // Another component's requirement keeps the ordinary failure wording (it is not relabelled as a server update).
        const clientSlice = slice([{ source: 'how_you_work', status: 'error', errorCode: 'update_required', updateRequired: client }]);
        expect.soft(describeUsagePageNewerServerSources([clientSlice])).toBeNull();
        expect.soft(describeUsagePageFailedSources([clientSlice])).toBe(t('usage.board.page.coverageFailed', { sources: usageSourceTitle('how_you_work') }));
        // A body's own line off the Usage page: the same sentence, and no Retry, because retrying cannot help.
        const onRetry = vi.fn();
        const screen = await renderScreen(<UsageCoverageLine slice={upgrade} sources={['how_you_work']} onRetry={onRetry} testID="upgrade-coverage" />);
        expect.soft(screen.getTextContent()).toContain(newer);
        expect.soft(screen.getTextContent()).not.toContain(t('usage.board.page.coverageFailed', { sources: usageSourceTitle('how_you_work') }));
        expect(screen.getTextContent()).not.toContain(t('common.retry'));
    });
    it('names a failed page read once for the header, never a widget-own read', () => {
        const slice = (sources: readonly { source: string; status: string }[]) =>
            ({ sources }) as unknown as Parameters<typeof describeUsagePageFailedSources>[0][number];
        expect(describeUsagePageFailedSources([slice([{ source: 'work', status: 'error' }]), slice([{ source: 'work', status: 'error' }])]))
            .toBe(t('usage.board.page.coverageFailed', { sources: usageSourceTitle('work') }));
        expect(describeUsagePageFailedSources([slice([{ source: 'comparison', status: 'error' }])])).toBeNull();
        expect(describeUsagePageFailedSources([slice([{ source: 'work', status: 'pending' }])])).toBeNull();
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
        expect(describeUsagePageFailedSources(both)).toBe(t('usage.board.page.coverageFailedWitnessed', {
            sources: usageSourceTitle('work'), witnessed: usageSourceTitle('how_you_work') }));
    });
    it('keeps admitted sources quiet during background refresh while naming an unanswered sibling', () => {
        const sources: UsageQueryResultSlice['sources'] = [
            { source: 'accounting', status: 'pending', asOfMs: 100 },
            { source: 'work', status: 'pending', asOfMs: 100 },
            { source: 'how_you_work', status: 'pending', asOfMs: 100 },
            { source: 'quota', status: 'available', asOfMs: 100 },
            { source: 'quota:answered', status: 'pending', asOfMs: 100 },
        ];
        expect(describeUsagePagePendingSources([{ sources }])).toBeNull();
        expect(readUsagePageAsOfMs([{ sources }])).toBe(100);
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
            value: usageQaAccountingFixture() }], quota: { status: 'unsupported' } }).results;
        expect(settled[0]?.pending).toBe(false);
        expect(describeUsagePagePendingSources(settled)).toBeNull();
        const demanded = normalizeUsageQuery({ ...query, includeWorkEvidence: true, includeSessionEvidence: true });
        const reading = resolveUsagePageAggregation({ queries: [demanded], work: [{ query: demanded, status: 'pending' }],
            accounting: [{ query: demanded, status: 'available', value: usageQaAccountingFixture() }], quota: { status: 'unsupported' },
            sources: [{ source: 'how_you_work', status: 'pending' }] }).results;
        expect(describeUsagePagePendingSources(reading)).toBe(t('usage.board.page.coveragePending', {
            sources: [usageSourceTitle('work'), usageSourceTitle('how_you_work')].join(', '),
        }));
    });
    it('dates the page by its latest observed source without rewriting older source freshness', () => {
        const sources: UsageQueryResultSlice['sources'] = [
            { source: 'accounting', status: 'available', asOfMs: 100 },
            { source: 'historic-source', status: 'partial', asOfMs: 50 },
            { source: 'quota', status: 'available', asOfMs: 200 },
        ];
        expect(readUsagePageAsOfMs([{ sources }])).toBe(200);
        expect(sources[1]?.asOfMs).toBe(50);
        expect(readUsagePageAsOfMs([{ sources: [{ source: 'accounting', status: 'pending' }] }])).toBeNull();
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
            value: [readAt('older', 100), readAt('newer', 200)] } }).results;
        expect(readUsagePageAsOfMs(slices)).toBe(200);
        expect(slices[0]?.sources.find(source => source.source === 'quota')?.asOfMs).toBe(100);
        expect(readUsagePageAsOfMs([{ sources: [], quota: [readAt('never', 0, 'not_loaded')] }])).toBeNull();
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
        } }] }).results[0]!;
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
        expect(formatUsageObservedAt(timestamp, now, 'en')).toBe(new Intl.DateTimeFormat('en', {
            hour: 'numeric', minute: '2-digit', year: 'numeric', month: 'short', day: 'numeric',
        }).format(timestamp));
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
        } }] }).results[0]!;
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
        }] }).results[0]!;
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
        } }] }).results[0]!;
        await screen.update(<UsageCoverageLine slice={oldest} sources={['accounting']} testID="source-date" />);
        expect(screen.getTextContent()).toContain(expected(observedAt));
    });
    it('does not treat an available transport without coverage metadata as complete history', () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
        const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
            v: 1, totals: { tokens: { total: 5, input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' }, eventCount: 1 },
        } }] }).results[0]!;
        expect(readUsageCoverageGaps(slice, ['accounting'])).toEqual([{ source: 'accounting', status: 'unknown' }]);
    });
});

describe('the allowance list holds its first-read room once', () => {
    const query = normalizeUsageQuery({});
    const pendingSlice = () => resolveUsagePageAggregation({ queries: [query], sources: [0, 1, 2].map(index => ({
        source: `quota:${JSON.stringify(QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account',
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: `acct-${index}` } }))}`,
        status: 'pending' as const })) }).results[0]!;
    it('reserves through the first reads, lets go when every account has answered, and never reserves for a re-read', async () => {
        const slice = pendingSlice();
        const hook = await renderHook(({ answered }: { answered: boolean }) => useUsageMeterListFirstReadReserve(slice, 3, answered, false),
            { initialProps: { answered: false } });
        expect(hook.getCurrent()?.minHeight).toBeGreaterThan(0);
        await hook.rerender({ answered: true });
        expect(hook.getCurrent()).toBeUndefined();
        // A later re-read puts accounts back to pending: the retained rows keep their height, no blank room is added.
        await hook.rerender({ answered: false });
        expect(hook.getCurrent()).toBeUndefined();
    });
});

describe('a settled list body keeps the tallest height it has drawn', () => {
    const layout = (height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height } } }) as never;
    it('holds the floor through shorter re-reads, ignores layouts before the settle, and starts over when the list changes shape', async () => {
        const hook = await renderHook(({ settled, shapeKey }: { settled: boolean; shapeKey: string }) => useSettledBodyHeightFloor(settled, shapeKey),
            { initialProps: { settled: false, shapeKey: 'wide' } });
        // The first-read reserve owns the room before the settle.
        await act(async () => { hook.getCurrent()!.onLayout(layout(500)); });
        expect(hook.getCurrent()!.minHeight).toBeUndefined();
        await hook.rerender({ settled: true, shapeKey: 'wide' });
        await act(async () => { hook.getCurrent()!.onLayout(layout(457)); });
        await act(async () => { hook.getCurrent()!.onLayout(layout(491)); });
        // A re-read puts accounts back to pending: the floor holds.
        await hook.rerender({ settled: false, shapeKey: 'wide' });
        expect(hook.getCurrent()!.minHeight).toBe(491);
        await hook.rerender({ settled: true, shapeKey: 'wide' });
        // The re-read drops the pace alert: the body is shorter, the floor is not.
        await act(async () => { hook.getCurrent()!.onLayout(layout(457)); });
        expect(hook.getCurrent()!.minHeight).toBe(491);
        // Show all / a resize is a deliberate new shape, not a re-read.
        await hook.rerender({ settled: true, shapeKey: 'narrow' });
        expect(hook.getCurrent()!.minHeight).toBeUndefined();
        await act(async () => { hook.getCurrent()!.onLayout(layout(300)); });
        expect(hook.getCurrent()!.minHeight).toBe(300);
    });

    it('lets the first settle after a cold read follow the drawn height down once, then keeps the ratchet for re-reads (R5)', async () => {
        const hook = await renderHook(({ settled }: { settled: boolean }) => useSettledBodyHeightFloor(settled, 'phone'),
            { initialProps: { settled: false } });
        // Cold read: the evidence settles with three findings (403), then the stored dismissals arrive and one is left (213).
        await hook.rerender({ settled: true });
        await act(async () => { hook.getCurrent()!.onLayout(layout(403)); });
        await act(async () => { hook.getCurrent()!.onLayout(layout(213)); });
        expect(hook.getCurrent()!.minHeight).toBe(213);
        // A re-read begins: from here the body only keeps its tallest height, so nothing below it moves.
        await hook.rerender({ settled: false });
        await hook.rerender({ settled: true });
        await act(async () => { hook.getCurrent()!.onLayout(layout(260)); });
        await act(async () => { hook.getCurrent()!.onLayout(layout(180)); });
        expect(hook.getCurrent()!.minHeight).toBe(260);
    });
});
