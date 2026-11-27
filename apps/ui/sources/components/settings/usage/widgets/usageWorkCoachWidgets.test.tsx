import { USAGE_ANALYTICS_COST_MODES } from '@happier-dev/protocol/usage/usageVocabularyV1';
import { projectUsagePageCost } from '@happier-dev/protocol/usage/usageCostFacts';
import { formatUsageCost } from '@/utils/format/usageNumbers';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import * as React from 'react';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook as renderBareHook, renderScreen as renderBareScreen, standardCleanup } from '@/dev/testkit';
import { createCommittedFiberRenderCounter, readTestRendererRoot } from '@/dev/testkit/performance/committedFiberCounts';
import { createMountedCurrentUiContextWrapper } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { executeCurrentUiContextAction } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useUsageWork } from './useUsageWork';
import { resolveUsagePageInitialFilters } from '../usageRouteParams';
import { resolveUsageWidgetPageInitialQuery } from '../usageWidgetPageContext';
import { UsageAgentMark, usagePeriodPhrase } from './usageBodyKit';
import { usageCostKindPhrase } from '../usageCostPresentation';
import { router } from 'expo-router';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { ChartDatum, HappierDataTable, HappierDataMetric, HappierDataRows, HappierProgress, IntervalTimeline, OutcomeFunnel, OutcomeScatter, RankedRows } from '@happier-dev/plugin-ui/presentation';
import { DEFAULT_USAGE_COACH_PREFERENCES_V1 } from '@happier-dev/protocol/account/settings/usageCoachPreferencesV1';
import {
  getUsageQueryKey,
  normalizeUsageQuery,
  usageQueryToAnalyticsRequest,
} from '@happier-dev/protocol/inputs/usageQuery';
import {
  allocateUsageOutcomes,
  projectUsageWorkSummary,
  summarizeUsageMergedOutcomes,
  UsageWorkProjectionSchema,
  type UsageWorkContribution,
  type UsageWorkEvidence,
} from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import {
  applyUsageCoachPreferences,
  evaluateUsageCoach,
} from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import type { UsageQueryBatchResult, UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { collectUsageWorkSources } from '@happier-dev/protocol/usage/usageWorkSources';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { UsageAnalyticsQueryResponseSchema, type UsageAnalyticsTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { UsageProjectLedgerWidget } from './UsageProjectLedgerWidget';
import { UsageWorkProviderMark, resolveUsageWorkProviderDisplay, usageWorkProviderDisplay } from './UsageWorkProviderMark';
import { formatUsageDimensionLabel } from '@/sync/api/account/formatUsageDimensionLabel';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildCacheKey, EMPTY_PROJECTION_SUMMARIES, PROJECTION_CACHE } from '@/agents/backendCatalog/daemonMergedProjectionCache';
import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getMachineContributionRegistryProjectionRevision } from '@/sync/ops/machineContributionRegistryProjection';
import { UsageWorkMarks, UsageWorkSectionTitle, usageWorkLinksNotice } from './UsageWorkParts';
import { usageAgentTitle, usageSourceTitle } from '@/sync/domains/usage/usageLabels';
import { UsageSessionValueWidget } from './UsageSessionValueWidget';
import { UsageSessionPageHost, useUsageSessionRows } from './usageBodyKit';
import { UsageWorkAutopsy } from './UsageWorkAutopsy';
import { UsageHumanLoopWidget } from './UsageHumanLoopWidget';
import { UsageParallelWidget } from './UsageParallelWidget';
import { UsageOutcomesWidget } from './UsageOutcomesWidget';
import { UsageChartInteractions } from '../usageChartInteractions';
import { UsageEfficiencyWidget } from './UsageEfficiencyWidget';
import { UsagePeriodSummaryWidget } from './UsagePeriodSummaryWidget';
import { UsageCoachWidget } from './UsageCoachWidget';
import { storage } from '@/sync/domains/state/storage';
import { formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { UsagePlanFitWidget } from './UsagePlanFitWidget';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { resolveUsageHowYouWork } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { projectProviderAccountUsageQuotaReadV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { createProjectAccountRowsSync } from '@/sync/engine/projects/projectAccountRowsSync';
import { WidgetFrameBodyCaptionContext } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

let actionHome: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let CommandWrapper: React.ComponentType<React.PropsWithChildren>;
beforeEach(async () => {
  actionHome = await serveActionHomes({ homes: [{ key: 'work', serverUrl: 'https://usage-work-controls.test', accountId: 'work-account' }],
    route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
      : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
  const server = actionHome.homes.work!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  const sync = (await import('@/sync/runtime/getSyncSingleton')).getSyncSingleton();
  await sync.awaitBootstrapForegroundAcquisition();
  await sync.refreshProjectAccountRows();
  CommandWrapper = await createMountedCurrentUiContextWrapper();
});
afterEach(async () => { standardCleanup(); await actionHome?.dispose(); actionHome = undefined; });
const renderScreen: typeof renderBareScreen = (element, options) => renderBareScreen(element,
  { ...options, wrapper: options?.wrapper ?? CommandWrapper });
const renderHook: typeof renderBareHook = (useValue, options) => renderBareHook(useValue,
  { ...options, wrapper: options?.wrapper ?? CommandWrapper });

const query = normalizeUsageQuery({
  period: { startMs: 0, endMs: 1000 },
  granularity: 'day',
  metric: 'cost',
  costBasis: 'reported',
});
const key = getUsageQueryKey(query);
const tokens = {
  input: 10,
  output: 4,
  reasoning: 1,
  cacheRead: 2,
  cacheWrite: 0,
  total: 14,
};
const contribution = (
  id: string,
  sessionId: string,
  turnId: string | null,
): UsageWorkContribution => ({
  id,
  sessionId,
  turnId,
  observedAtMs: 1,
  agentId: 'claude',
  modelId: 'model',
  machineId: 'machine',
  projectKey: 'p1',
  workspaceId: null,
  source: 'runtime',
  tokens,
  cost: { reportedUsd: 3, estimatedUsd: 4, currency: 'USD' },
});
const evidence = (
  sessionId: string,
  turnId: string,
  number: number,
): UsageWorkEvidence => ({
  sessionId,
  turnId,
  repositoryKey: 'repo',
  checkpointRef: `checkpoint/${sessionId}/${turnId}`,
  checkpointCommitSha: 'a'.repeat(40),
  commitSha: 'b'.repeat(40),
  attributionScope: 'no_happier_checkpoint_overlap_observed',
  pullRequest: {
    provider: {
      id: 'forge',
      kind: 'github',
      displayName: 'Forge',
      baseUrl: 'https://github.com',
      nameWithOwner: 'owner/repo',
      urlSafety: { allowedSchemes: ['https:'] },
    },
    number,
    title: 'Retry relay handshake',
    url: `https://github.com/owner/repo/pull/${number}`,
    baseBranch: 'main',
    headBranch: 'relay-retry',
    state: 'merged',
  },
});
const contributions = [
  contribution('a', 's1', 't1'),
  contribution('b', 's2', 't2'),
  contribution('c', 's1', null),
];
const fixtureRows = new WeakMap<ReturnType<typeof allocateUsageOutcomes>, Parameters<typeof allocateUsageOutcomes>[0]['contributions']>();
function allocateFixtureWork(input: Parameters<typeof allocateUsageOutcomes>[0]) {
  const projection = UsageWorkProjectionSchema.parse(allocateUsageOutcomes(input));
  fixtureRows.set(projection, input.contributions);
  return projection;
}
function fixtureContributions(work: ReturnType<typeof allocateUsageOutcomes>) {
  const rows = fixtureRows.get(work);
  if (!rows) throw new Error('Expected the Work fixture accounting');
  return rows;
}
function withFixtureWorkAccounting<T extends Pick<UsageQueryResultSlice, 'work' | 'accounting'>>(value: T): T {
  const rows = value.work && fixtureRows.get(value.work);
  return !rows || !value.accounting ? value : { ...value, accounting: { ...value.accounting, contributions: [...rows] } };
}
const work = allocateFixtureWork({
  contributions,
  evidence: [evidence('s1', 't1', 2493)],
});
const compactions = [
  { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't', immediateRefillToLimit: true },
  { evidenceId: 'c2', observedAtMs: 20, sessionId: 's', turnId: 't', immediateRefillToLimit: true },
  { evidenceId: 'c3', observedAtMs: 30, sessionId: 's', turnId: 't', immediateRefillToLimit: true },
];
const coach = evaluateUsageCoach({
  queryKey: key,
  period: { startMs: 0, endMs: 1000 },
  asOfMs: 1000,
  currentness: 'current',
  detail: { coverage: 'partial', compactions },
}, bundledUsageModelPriceCatalog);
const slice: UsageQueryResultSlice = {
  key,
  requestedQuery: query,
  shownQuery: query,
  work,
  workSummary: projectUsageWorkSummary(work.outcomes, true, { work: work, contributions: fixtureContributions(work) }),
  coach,
  pending: false,
  accounting: {
    v: 1,
    totals: {
      eventCount: 3,
      tokens: { ...tokens, total: 42 },
      cost: { reportedUsd: 9, estimatedUsd: 12, currency: 'USD' },
    },
    contributions,
    breakdowns: { project: [{ key: 'p1', label: 'Workspace', eventCount: 3,
      tokens: { ...tokens, total: 42 }, cost: { reportedUsd: 9, estimatedUsd: 12, currency: 'USD' } }] },
  },
  sources: [
    { source: 'accounting', status: 'available' },
    { source: 'work', status: 'available' },
    { source: 'how_you_work', status: 'available' },
  ],
};
const model: UsageWidgetBodyModel = {
  requestedQuery: null,
  shownQuery: null,
  slice,
  pending: false,
  error: null,
  freshness: 'fresh',
  updatingPreviousPeriod: false,
  refreshing: false,
  refresh: async () => {},
};
const props = { model, slice, query, serverId: 'home' };

describe('Work and Coach widget bodies', () => {
  it('updates Work amounts when accounting corrects a contribution without changing the link', async () => {
    const corrected = { ...slice, accounting: { ...slice.accounting!, contributions: [
      { ...contributions[0]!, cost: { ...contributions[0]!.cost, reportedUsd: 6 } },
      ...contributions.slice(1),
    ] } };
    const hook = await renderHook(() => ({
      before: useUsageWork(slice, query, 'home').summary?.total,
      after: useUsageWork(corrected, query, 'home').summary?.total,
    }));
    expect(hook.getCurrent()).toEqual({ before: 9, after: 12 });
  });

  it('opens a Work Session through its mounted command and withdraws its address on unmount', async () => {
    const hook = await renderHook(() => ({ work: useUsageWork(slice, query, 'home'), reader: useOptionalCurrentUiContextReader() }));
    const command = hook.getCurrent().reader!.readCurrentUiContext()!.commands.find(row => row.title === `${t('common.open')}: ${hook.getCurrent().work.sessionLabel('s1')}`);
    expect(command).toBeDefined();
    await act(async () => {
      expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: command!.id },
        context: { surface: 'agent' } })).toMatchObject({ ok: true });
    });
    const href = new URL(String(vi.mocked(router.push).mock.calls.at(-1)?.[0]), 'https://usage-work-controls.test');
    expect(href.pathname).toBe('/session/s1/usage');
    const openedQuery = resolveUsageWidgetPageInitialQuery({
      initialFilters: resolveUsagePageInitialFilters(Object.fromEntries(href.searchParams)),
      sessionId: 's1', nowMs: 1000, timeZoneOffsetMinutes: 0,
    });
    const directQuery = resolveUsageWidgetPageInitialQuery({
      initialFilters: resolveUsagePageInitialFilters({ metric: 'cost', costMode: 'reported' }),
      sessionId: 's1', nowMs: 1000, timeZoneOffsetMinutes: 0,
    });
    const openedRead = usageQueryToAnalyticsRequest(openedQuery, 1000);
    expect(openedRead).toEqual(usageQueryToAnalyticsRequest(directQuery, 1000));
    expect(openedRead.dateRange).toEqual({ endMs: 1000 });
    expect(openedRead.filters?.sessionIds).toEqual(['s1']);
    expect(usagePeriodPhrase(openedQuery)).toBe(t('usage.board.page.thisSession'));
    const reader = hook.getCurrent().reader!;
    await hook.unmount();
    expect(reader.resolveCurrentUiCommand(command!.id)).toBeNull();
  });
  it.each(USAGE_ANALYTICS_COST_MODES)('keeps the %s cost and amount from each Work Session link', async (costBasis) => {
    const workQuery = normalizeUsageQuery({ ...query, costBasis });
    // The Session occurred entirely inside the Work period. Each explicit basis has a different amount.
    const row = contribution('a', 's1', 't1');
    const measured = { ...row, cost: { ...row.cost, apiEquivalentUsd: 7 } };
    const linked = allocateFixtureWork({ contributions: [measured], evidence: [evidence('s1', 't1', 2493)] });
    const accounting = {
      ...slice.accounting!,
      totals: { eventCount: 1, tokens: measured.tokens, cost: measured.cost },
      contributions: [measured],
      breakdowns: { project: [{ key: 'p1', label: 'Workspace', eventCount: 1,
        tokens: measured.tokens, cost: measured.cost }] },
    };
    const costSlice = withFixtureWorkAccounting({ ...slice, work: linked, workSummary: projectUsageWorkSummary(linked.outcomes, true, { work: linked, contributions: fixtureContributions(linked) }),
      accounting, requestedQuery: workQuery, shownQuery: workQuery });
    const screen = await renderScreen(<>
      <UsageProjectLedgerWidget {...props} query={workQuery} slice={costSlice} id="usage_project_ledger" testID="ledger" />
      <UsageSessionValueWidget {...props} query={workQuery} slice={costSlice} id="usage_session_value" testID="value" />
      <UsageOutcomesWidget {...props} query={workQuery} slice={costSlice} id="usage_outcomes" testID="outcomes" />
    </>);
    const outcome = `outcomes.pr.${linked.outcomes[0]!.key}`;
    await screen.pressByTestIdAsync('ledger.project.p1.toggle');
    await screen.pressByTestIdAsync(`${outcome}.toggle`);

    for (const [button, renderedRow] of [
      ['ledger.project.p1.session.open.s1', 'ledger.project.p1.session-row-0'],
      ['value.open.s1', 'value.merged-row-0'],
      [`${outcome}.session.open.s1`, `${outcome}.session-row-0`],
    ] as const) {
      const spokenRow = screen.findByTestId(renderedRow)?.props.accessibilityLabel;
      expect(spokenRow).toEqual(expect.any(String));
      await screen.pressByTestIdAsync(button);
      const href = new URL(String(vi.mocked(router.push).mock.calls.at(-1)?.[0]), 'https://usage-work-controls.test');
      expect(href.pathname).toBe('/session/s1/usage');
      for (const scopeKey of ['period', 'scope', 'queryOverrides']) expect(href.searchParams.has(scopeKey)).toBe(false);
      const opened = resolveUsageWidgetPageInitialQuery({
        initialFilters: resolveUsagePageInitialFilters(Object.fromEntries(href.searchParams)),
        sessionId: 's1', nowMs: 1000, timeZoneOffsetMinutes: 0,
      });
      expect.soft(opened.costBasis, button).toBe(costBasis);
      expect(usagePeriodPhrase(opened)).toBe(t('usage.board.page.thisSession'));
      const amount = projectUsagePageCost(accounting, opened.costBasis);
      expect(amount.amountUsd).toBeGreaterThan(0);
      expect.soft(spokenRow, button).toContain(formatUsageCost(amount.amountUsd, amount.selection!.currency));
    }
  });

  it('commits once per mounted Work body for a displayed Session change and stays quiet otherwise', async () => {
    const serverId = actionHome!.homes.work!.id;
    const previous = storage.getState();
    const homeProps = { ...props, serverId };
    const original = createSessionListRenderableSessionFixture({ id: 's1', metadataVersion: 1,
      metadata: { name: 'Original Work Session', path: '/work', machineId: 'machine', host: 'original-work-host' } });
    const publish = (...rows: (typeof original)[]) =>
      storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'append' });
    storage.setState({ machineDisplayById: {}, machines: {} });
    publish(original);
    const commits = { ledger: 0, value: 0, outcomes: 0, autopsy: 0 };
    const screen = await renderScreen(<>
      <React.Profiler id="ledger" onRender={() => { commits.ledger++; }}>
        <UsageProjectLedgerWidget {...homeProps} id="usage_project_ledger" testID="quiet-ledger" />
      </React.Profiler>
      <React.Profiler id="value" onRender={() => { commits.value++; }}>
        <UsageSessionValueWidget {...homeProps} id="usage_session_value" testID="quiet-value" />
      </React.Profiler>
      <React.Profiler id="outcomes" onRender={() => { commits.outcomes++; }}>
        <UsageOutcomesWidget {...homeProps} id="usage_outcomes" testID="quiet-outcomes" />
      </React.Profiler>
      <React.Profiler id="autopsy" onRender={() => { commits.autopsy++; }}>
        <UsageWorkAutopsy {...homeProps} query={normalizeUsageQuery({ ...query, session: 's1' })} testID="quiet-autopsy" />
      </React.Profiler>
    </>);
    try {
      await screen.pressByTestIdAsync('quiet-ledger.project.p1.toggle');
      await screen.pressByTestIdAsync(`quiet-outcomes.pr.${work.outcomes[0]!.key}.toggle`);
      const linkedRows = () => [
        screen.findByTestId('quiet-ledger.project.p1.session.open.s1')?.props.accessibilityLabel,
        screen.findByTestId(`quiet-outcomes.pr.${work.outcomes[0]!.key}.session.open.s1`)?.props.accessibilityLabel,
      ];
      const sessionValue = () => screen.findByTestId('quiet-value.open.s1')?.props.accessibilityLabel;
      const autopsyShows = (host: string) => screen.findByTestId('quiet-autopsy.summary')!
        .findAll(node => node.children.some(child => typeof child === 'string' && child.includes(host))).length > 0;
      for (const label of [...linkedRows(), sessionValue()]) expect.soft(label).toContain('Original Work Session');
      expect.soft(autopsyShows('original-work-host')).toBe(true);

      const before = { ...commits };
      for (let i = 0; i < 10; i++) {
        await act(async () => publish(createSessionListRenderableSessionFixture({ id: `offscreen-${i}` })));
      }
      expect.soft(commits).toEqual(before);
      await act(async () => publish({ ...original, metadataVersion: 2,
        metadata: { ...original.metadata!, name: 'Renamed Work Session', host: 'renamed-work-host' } }));
      for (const label of [...linkedRows(), sessionValue()]) expect.soft(label).toContain('Renamed Work Session');
      expect.soft(autopsyShows('renamed-work-host')).toBe(true);
      expect({
        ledger: commits.ledger - before.ledger,
        value: commits.value - before.value,
        outcomes: commits.outcomes - before.outcomes,
        autopsy: commits.autopsy - before.autopsy,
      }).toEqual({ ledger: 1, value: 1, outcomes: 1, autopsy: 1 });
    } finally {
      await screen.unmount();
      storage.setState(previous, true);
    }
  });

  it('skips demanded Session ids on disjoint row deltas and rereads when the delta is unknown', async () => {
    const serverId = actionHome!.homes.work!.id;
    const previous = storage.getState();
    const displayed = createSessionListRenderableSessionFixture({ id: 'demanded', metadataVersion: 1,
      metadata: { name: 'Original', path: '/work' } });
    const demand = [displayed.id, 'other-demand'];
    const publish = (...rows: (typeof displayed)[]) =>
      storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'append' });
    publish(displayed, createSessionListRenderableSessionFixture({ id: 'other-demand' }));
    let readCountForPublication = () => 0;
    // Measure the fresh bucket before the hook reads it. The producer's copy of the previous bucket
    // increments the previous publication's counter, so it does not count as selector work.
    const unsubscribe = storage.subscribe((state, previousState) => {
      const bucket = state.sessionListRowsByServerId[serverId];
      if (!bucket || bucket === previousState.sessionListRowsByServerId[serverId]) return;
      let reads = 0;
      for (const id of demand) {
        const row = bucket[id];
        if (row) Object.defineProperty(bucket, id, {
          configurable: true, enumerable: true,
          get() { reads++; return row; },
        });
      }
      readCountForPublication = () => reads;
    });
    const hook = await renderHook(() => useUsageSessionRows(serverId, demand));
    try {
      expect(hook.getCurrent()[displayed.id]?.metadata?.name).toBe('Original');
      let demandedReads = 0;
      const firstRevision = storage.getState().sessionListRenderableDelta.revision;
      for (let i = 0; i < 10; i++) {
        const unrelated = createSessionListRenderableSessionFixture({ id: `unrelated-${i}` });
        await act(async () => publish(unrelated));
        expect(storage.getState().sessionListRenderableDelta.changedSessionIds).toEqual([unrelated.id]);
        demandedReads += readCountForPublication();
      }
      expect(storage.getState().sessionListRenderableDelta.revision).toBe(firstRevision + 10);
      expect.soft(demandedReads).toBe(0);

      const renamed = { ...displayed, metadataVersion: 2, metadata: { ...displayed.metadata!, name: 'Renamed' } };
      await act(async () => publish(renamed));
      expect(hook.getCurrent()[displayed.id]?.metadata?.name).toBe('Renamed');
      await act(async () => storage.setState(state => ({
        sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [serverId]: {} },
      })));
      expect(hook.getCurrent()[displayed.id]).toBeUndefined();
      await act(async () => {
        publish(renamed);
        storage.getState().applyServerScopedSessionListRows(serverId,
          [createSessionListRenderableSessionFixture({ id: 'ordinary' })], { source: 'ordinary', mode: 'append' });
      });
      expect(hook.getCurrent()[displayed.id]?.metadata?.name).toBe('Renamed');
      await act(async () => storage.getState().clearSessionListRowsForServerScope(serverId));
      expect(storage.getState().sessionListRenderableDelta.removedSessionIds).toContain('ordinary');
      expect(hook.getCurrent()[displayed.id]).toBeUndefined();
    } finally {
      unsubscribe();
      await hook.unmount();
      storage.setState(previous, true);
    }
  });

  it('conceals hidden Work Session labels and restores them after sharing without changing the drill target', async () => {
    const previous = storage.getState();
    const serverId = actionHome!.homes.work!.id;
    const row = createSessionListRenderableSessionFixture({ id: 's1', metadata: {
      name: 'Private usage project', path: '/private-work', host: 'host', machineId: 'machine',
    } });
    storage.setState({ sessionListRowsByServerId: { [serverId]: { [row.id]: row } } });
    storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } });
    storage.getState().setSessionTagAssignmentsOptimistic(serverId, row.id, ['private']);
    let workRenders = 0;
    const hook = await renderHook(() => {
      workRenders++;
      return useUsageWork(slice, query, serverId);
    });
    try {
      expect(hook.getCurrent().sessionLabel('s1')).toBe('Private usage project');
      const before = workRenders;
      for (let i = 0; i < 10; i++) {
        await act(async () => {
          const rows = storage.getState().sessionListRowsByServerId;
          const unrelated = createSessionListRenderableSessionFixture({ id: `other-${i}` });
          storage.setState({ sessionListRowsByServerId: { ...rows,
            [serverId]: { ...rows[serverId], [unrelated.id]: unrelated } } });
        });
      }
      expect.soft(workRenders - before, 'Work renders for 10 unrelated Session rows').toBe(0);
      await act(async () => { setScreenSharingPrivacyActive(true); });
      expect(hook.getCurrent().sessionLabel('s1')).toBe(t('session.untitled'));
      await act(async () => { hook.getCurrent().openSession('s1'); });
      expect(vi.mocked(router.push).mock.calls.at(-1)?.[0]).toContain('/session/s1/usage');
      await act(async () => { setScreenSharingPrivacyActive(false); });
      expect(hook.getCurrent().sessionLabel('s1')).toBe('Private usage project');
    } finally { setScreenSharingPrivacyActive(false); await hook.unmount(); storage.setState(previous, true); }
  });

  it('conceals hidden parallel timeline Session labels while retaining the measured intervals', async () => {
    const previous = storage.getState();
    const server = actionHome!.homes.work!;
    const row = createSessionListRenderableSessionFixture({ id: 's1', metadataVersion: 1, metadata: {
      name: 'Private parallel project', path: '/private-parallel', host: 'host', machineId: 'machine',
    } });
    const publish = (...rows: (typeof row)[]) =>
      storage.getState().applyServerScopedSessionListRows(server.id, rows, { source: 'rowOnly', mode: 'append' });
    publish(row);
    storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [server.id]: ['private'] } });
    storage.getState().setSessionTagAssignmentsOptimistic(server.id, row.id, ['private']);
    const howYouWork = resolveUsageHowYouWork({ period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0, nowMs: 500,
      detail: { status: 'available', facts: [{ workId: JSON.stringify(['s1', 't1']), evidenceId: 't1', agentId: 'claude',
        machineId: 'machine', kind: 'busy', startMs: 10, endMs: 800 }] } });
    const timelineCounts = createCommittedFiberRenderCounter();
    let readRoot: ReturnType<typeof readTestRendererRoot> | undefined;
    const screen = await renderScreen(<React.Profiler id="parallel" onRender={() => { if (readRoot) timelineCounts.onCommitRoot(readRoot()); }}>
      <UsageParallelWidget {...props} serverId={server.id} slice={{ ...slice, howYouWork }}
        presentation={{ style: 'timeline' }} id="usage_parallel" testID="private-parallel" />
    </React.Profiler>);
    readRoot = readTestRendererRoot(screen.tree.root);
    const body = screen.findAllByType(UsageParallelWidget)[0]!.children.find(
      (child): child is ReactTestInstance => typeof child !== 'string',
    )!;
    const intervals = () => screen.findAllByType(IntervalTimeline)[0]!.props.intervals;
    try {
      await act(async () => {});
      expect(JSON.stringify(intervals())).toContain('Private parallel project');
      const count = intervals().length;
      timelineCounts.start();
      for (let i = 0; i < 10; i++) {
        await act(async () => publish(createSessionListRenderableSessionFixture({ id: `other-${i}` })));
      }
      expect.soft(timelineCounts.read().commitsFor(body.type), 'body commits for ten unrelated Session rows').toBe(0);
      expect.soft(timelineCounts.read().commitsFor(IntervalTimeline), 'chart commits for ten unrelated Session rows').toBe(0);
      timelineCounts.start();
      await act(async () => publish({ ...row, metadataVersion: 2,
        metadata: { ...row.metadata!, name: 'Renamed parallel project' } }));
      expect.soft(timelineCounts.read().commitsFor(body.type), 'body commits for one published rename').toBe(1);
      expect.soft(timelineCounts.read().commitsFor(IntervalTimeline), 'chart commits for one published rename').toBe(1);
      timelineCounts.stop();
      expect(JSON.stringify(intervals())).toContain('Renamed parallel project');
      await act(async () => { setScreenSharingPrivacyActive(true); });
      expect(JSON.stringify(intervals())).not.toContain('Renamed parallel project');
      expect(intervals()).toHaveLength(count);
      await act(async () => { setScreenSharingPrivacyActive(false); });
      expect(JSON.stringify(intervals())).toContain('Renamed parallel project');
    } finally { setScreenSharingPrivacyActive(false); await screen.unmount(); storage.setState(previous, true); }
  });

  it('reveals exact row money in its own basis when the ledger cannot share one numeric money column', async () => {
    const rows = ['USD', 'EUR'].map((currency, index) => ({ ...contribution(`money-${index}`, `session-${index}`, null),
      projectKey: `project-${index}`, cost: { reportedUsd: 1.23456, estimatedUsd: 0, currency } }));
    const work = allocateFixtureWork({ contributions: rows, evidence: [] });
    const accounting = { ...slice.accounting!, breakdowns: { project: rows.map((row, index) => ({ key: row.projectKey, label: `Named project ${index}`,
      eventCount: 1, tokens: row.tokens, cost: row.cost })) } };
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'cost' })}
      slice={withFixtureWorkAccounting({ ...slice, accounting, work })} id="usage_project_ledger" testID="ledger" />);
    expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'ledger.projects-datum-0')?.props.datum.value).toContain('USD 1.23456');
    expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'ledger.projects-datum-1')?.props.datum.value).toContain('EUR 1.23456');
    await screen.pressByTestIdAsync('ledger.project.project-0.toggle');
    expect(screen.findByTestId('ledger.project.project-0.detail')).toBeTruthy();
  });
  it('says an unread token amount is not measured, never that it has no API price (acceptance 1122 Session page)', async () => {
    const tokensQuery = normalizeUsageQuery({ ...query, metric: 'tokens' });
    const hook = await renderHook(() => useUsageWork(slice, tokensQuery, 'home'));
    try {
      expect(hook.getCurrent().format(null)).toBe(t('usage.board.page.notMeasuredYet'));
      expect(hook.getCurrent().cell(null, null)).toBe(t('usage.board.page.notMeasuredYet'));
    } finally { await hook.unmount(); }
  });
  const layoutIdentityStrip = async (strip: ReactTestInstance | null, width: number) => {
    const layout = strip?.findAll(node => typeof node.props.onLayout === 'function')[0];
    if (!layout) throw new Error('Expected a fitted mark strip');
    await act(() => { layout.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 16 } } }); });
  };
  it('keeps all hidden identities recoverable in a narrow Project row’s disclosure', async () => {
    const agentIds = ['claude', 'codex', 'muse', 'pi', ...Array.from({ length: 12 }, (_, index) => `a-fixture-agent-${index}`)];
    const sessionlessProvider = 'provider.project-only';
    const rows = [
      ...agentIds.map(agentId => ({ ...contribution(agentId, 's1', null), agentId })),
      { ...contribution('project-only', 'unused', null), sessionId: null, agentId: null,
        providerId: sessionlessProvider, providerConnectionId: 'connection' },
    ];
    const work = allocateFixtureWork({ contributions: rows, evidence: [] });
    const screen = await renderScreen(<UsageChartInteractions>
      <UsageProjectLedgerWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'tokens' })}
        slice={withFixtureWorkAccounting({ ...slice, work })} id="usage_project_ledger" testID="ledger" />
    </UsageChartInteractions>);
    const layout = (width: number) => layoutIdentityStrip(screen.findByTestId('ledger.marks'), width);
    const displayed = () => screen.findAllByType(UsageAgentMark);
    await layout(160);
    expect(displayed().length).toBeGreaterThan(0);
    const shown = new Set(displayed().map(mark => mark.props.agentId));
    const hidden = agentIds.filter(agentId => !shown.has(agentId));
    expect(hidden.length).toBeGreaterThan(0);
    expect(screen.findAllByType(UsageWorkProviderMark)).toHaveLength(0);
    expect(screen.getTextContent()).toContain(t('usage.board.work.moreMarks', { count: hidden.length + 1 }));
    const toggle = 'ledger.project.p1.toggle';
    expect(screen.findByTestId('ledger.project.p1.detail')).toBeNull();
    await screen.pressByTestIdAsync(toggle);
    expect(screen.findByTestId('ledger.project.p1.detail')).toBeTruthy();
    const identities = String(screen.findByTestId('ledger.project.p1.identities')?.props.children ?? '').split(' · ');
    expect(identities).toEqual(expect.arrayContaining([...hidden.map(id => usageAgentTitle(id)),
      resolveUsageWorkProviderDisplay({ providerId: sessionlessProvider, machineIds: [null] }, 'home').label]));
    await screen.pressByTestIdAsync(toggle);
    await layout(1000);
    expect(displayed()).toHaveLength(agentIds.length);
    expect(screen.findAllByType(UsageWorkProviderMark)).toHaveLength(1);
    expect(screen.getTextContent()).not.toContain('+');
  });
  // Provider naming (review J-B31 after ff62c956107): identity decides, never the label. The marks, the visible
  // detail line and the spoken detail list exactly one entry per distinct identity, none of them a raw qualified id.
  it.each([
    { kind: 'one identity witnessed on two Machines', providers: [['happier.provider.cliproxyapi/cliproxyapi', 'machine-1'],
      ['happier.provider.cliproxyapi/cliproxyapi', 'machine-2']], expected: ['CLIProxyAPI'] },
    { kind: 'two identities with the same label', providers: [['acme.first/gateway', 'machine'], ['acme.second/gateway', 'machine']],
      expected: null },
    { kind: 'a Provider labelled like an Agent', providers: [['acme.tools/claude', 'machine']], expected: null },
    { kind: 'a Provider declared nowhere', providers: [['happier.provider.nowhere-declared/nowhere-declared', 'machine']],
      expected: ['Nowhere Declared'] },
    { kind: 'an opaque Provider key', providers: [['provider.project-only', 'machine']],
      expected: [formatUsageDimensionLabel('source', 'provider.project-only', 'Provider.project-only')] },
  ] as const)('names $kind once per identity in the marks, the detail line and the spoken detail', async ({ providers, expected }) => {
    const rows: UsageWorkContribution[] = providers.map(([providerId, machineId], index) => ({
      ...contribution(`p${index}`, 's1', 't1'), machineId, providerId, providerConnectionId: 'connection' }));
    const work = allocateFixtureWork({ contributions: rows, evidence: [evidence('s1', 't1', 2493)] });
    const screen = await renderScreen(<UsageChartInteractions>
      <UsageProjectLedgerWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'tokens' })}
        slice={withFixtureWorkAccounting({ ...slice, work })} id="usage_project_ledger" testID="ledger" />
    </UsageChartInteractions>);
    await layoutIdentityStrip(screen.findByTestId('ledger.marks'), 1000);
    const identityCount = new Set(providers.map(([providerId]) => providerId)).size;
    const marks = screen.findAllByType(UsageWorkProviderMark);
    expect(marks).toHaveLength(identityCount);
    const spokenMarks = marks.map(mark => mark.findByProps({ accessible: true }).props.accessibilityLabel as string);
    expect(new Set(spokenMarks).size).toBe(identityCount);
    await screen.pressByTestIdAsync('ledger.project.p1.toggle');
    const line = String(screen.findByTestId('ledger.project.p1.identities')?.props.children ?? '').split(' · ');
    const agent = usageAgentTitle('claude');
    expect(line[0]).toBe(agent);
    const names = line.slice(1);
    expect(names).toHaveLength(identityCount);
    expect(new Set([agent, ...names]).size).toBe(identityCount + 1);
    if (expected) expect(names).toEqual(expected);
    for (const [providerId] of providers) if (providerId.includes('/')) expect(line.join(' · ')).not.toContain(providerId);
    for (const name of names) expect(spokenMarks.some(label => label.endsWith(name))).toBe(true);
    const spoken = screen.findAllByType(ChartDatum).find(node => node.props.testID === 'ledger.project.p1.prs-datum-0')?.props.datum.accessibilityLabel;
    expect(typeof spoken).toBe('string');
    for (const name of [agent, ...names]) expect(spoken).toContain(name);
  });
  const gatewayIds = ['acme.tools/gateway', 'acme.tools/gateway-gateway', 'acme.tools/gateway-gateway-gateway'];
  it.each([
    { kind: 'three unlisted gateway IDs', ids: gatewayIds },
    { kind: 'three declared gateways with the same name', ids: gatewayIds, declarations: ['Gateway', 'Gateway', 'Gateway'] },
    { kind: 'opaque keys differing only by separator', ids: ['work-gateway', 'work_gateway'] },
    { kind: 'opaque keys differing only by case', ids: ['field-api', 'FIELD-API'] },
    { kind: 'a declared label occupying a fallback key',
      ids: [...gatewayIds, 'acme.custom/other', 'acme.custom/independent'],
      declarations: ['Gateway', 'Gateway', 'Gateway', gatewayIds[0]!, 'Independent Gateway'],
      expected: [...gatewayIds, 'acme.custom/other', 'Independent Gateway'] },
  ])('uses distinct final Provider names for $kind on each reading surface', async ({ ids, declarations, expected = ids }) => {
    const serverId = actionHome!.homes.work!.id;
    const machineId = 'provider-name-collision-witness';
    const projectionKey = buildCacheKey(machineId, serverId);
    if (declarations) {
      // Seed the retained daemon response at the data boundary; lookup and label resolution run in production code.
      const declaration = readAccountProviderDeclarations({ kind: 'account' })[0]!;
      const entriesById = Object.fromEntries(ids.map((id, index) => {
        const [pluginId, localId] = id.split('/');
        return [id, { id, pluginId, provenance: 'external', sourceKind: 'path',
          definition: { ...declaration.definition, id: localId, name: declarations[index] } }];
      }));
      const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {},
        familiesById: { providers: { family: 'providers', entriesById } } });
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (!lifetime) throw new Error('Expected a current Account for the retained Machine catalog');
      PROJECTION_CACHE.set(projectionKey, {
        kind: 'ready', inputs: publishDaemonMergedProjectionInputs({ projection }),
        workflowActionCatalog: { current: null }, workflowEventCatalog: { current: null },
        fetchedAtMs: Date.now(), projectionRevision: getMachineContributionRegistryProjectionRevision({ machineId, serverId }),
        accountScope: lifetime.scope, targetServerId: serverId, locale: getPreferredLanguage(), summaries: EMPTY_PROJECTION_SUMMARIES,
      });
    }
    try {
      const rows: UsageWorkContribution[] = ids.map((providerId, index) => ({
        ...contribution(`provider-${index}`, 's1', 't1'), machineId, providerId, providerConnectionId: 'connection',
      }));
      const work = allocateFixtureWork({ contributions: rows, evidence: [evidence('s1', 't1', 2493)] });
      const screen = await renderScreen(<UsageChartInteractions>
        <UsageProjectLedgerWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'tokens' })}
          slice={withFixtureWorkAccounting({ ...slice, work })} serverId={serverId} id="usage_project_ledger" testID="ledger" />
      </UsageChartInteractions>);
      if (declarations) {
        expect(ids.map(providerId => resolveUsageWorkProviderDisplay({ providerId, machineIds: [machineId] }, serverId).label))
          .toEqual(declarations);
      }
      await layoutIdentityStrip(screen.findByTestId('ledger.marks'), 1000);
      const prefix = `${t('usage.board.work.provider')}: `;
      const spokenMarks = screen.findAllByType(UsageWorkProviderMark).map(mark =>
        String(mark.findByProps({ accessible: true }).props.accessibilityLabel).replace(prefix, ''));
      await screen.pressByTestIdAsync('ledger.project.p1.toggle');
      const names = String(screen.findByTestId('ledger.project.p1.identities')?.props.children ?? '').split(' · ').slice(1);
      const spoken = screen.findAllByType(ChartDatum).find(node =>
        node.props.testID === 'ledger.project.p1.prs-datum-0')?.props.datum.accessibilityLabel ?? '';
      const sorted = [...expected].sort();
      expect.soft(spokenMarks.sort()).toEqual(sorted);
      expect.soft(names.sort()).toEqual(sorted);
      expect.soft(spoken.split(' · ').slice(-expected.length).sort()).toEqual(sorted);
    } finally {
      PROJECTION_CACHE.delete(projectionKey);
    }
  });
  it('names a Provider from any witnessing Machine that declares it before falling back to its local id (review J-B31)', () => {
    const declaration = readAccountProviderDeclarations({ kind: 'account' })[0]!;
    const custom = 'acme.custom/gateway';
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {},
      familiesById: { providers: { family: 'providers', entriesById: {
        [custom]: { id: custom, pluginId: 'acme.custom', provenance: 'external', sourceKind: 'path',
          definition: { ...declaration.definition, id: 'gateway', name: 'Acme Gateway' } },
      } } } });
    expect(usageWorkProviderDisplay(custom, [{ machineId: 'offline', projection: null },
      { machineId: 'ready', projection }]).label).toBe('Acme Gateway');
    expect(usageWorkProviderDisplay(custom, [{ machineId: 'offline', projection: null }]).label).toBe('Gateway');
  });
  // The Sessions group's outcome caption follows the Work coverage decision (review J-B34): only a group that has
  // Sessions, whose linked PRs were read and none is linked, says "no linked outcome yet" — once, beside its title.
  it.each([
    { kind: 'no Sessions', sessionId: null, read: true, linked: false, caption: false },
    { kind: 'Sessions whose PRs were not read', sessionId: 's1', read: false, linked: false, caption: false },
    { kind: 'Sessions read with none linked', sessionId: 's1', read: true, linked: false, caption: true },
    { kind: 'Sessions with a linked PR', sessionId: 's1', read: true, linked: true, caption: false },
  ] as const)('claims an outcome state for $kind only when the coverage decision allows it', async ({ sessionId, read, linked, caption }) => {
    const rows = [{ ...contribution('only', sessionId ?? 'unused', 't1'), sessionId }];
    const work = allocateFixtureWork({ contributions: rows,
      evidence: linked ? [evidence('s1', 't1', 2493)] : [] });
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'tokens' })}
      slice={withFixtureWorkAccounting({ ...slice, work, workSummary: projectUsageWorkSummary(work.outcomes, read, { work: work, contributions: fixtureContributions(work) }) })} id="usage_project_ledger" testID="ledger" />);
    await screen.pressByTestIdAsync('ledger.project.p1.toggle');
    const title = screen.findAllByType(UsageWorkSectionTitle).find(node => node.props.children === t('usage.board.work.funnelSessions'));
    expect(title?.props.caption).toBe(caption ? t('usage.board.work.noOutcome') : undefined);
    const detail = screen.findByTestId('ledger.project.p1.detail');
    const claims = detail ? JSON.stringify(detail.findAllByType(HappierDataRows).map(node => node.props.rows)) : '';
    expect(claims).not.toContain(t('usage.board.work.noOutcome'));
    if (linked) expect(claims).toContain('Retry relay handshake');
  });
  it('leads a Project’s Sessions with the largest six behind Show all · n and keeps the Project total (acceptance r224 #48)', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ ...contribution(`c${index}`, `s${index}`, `t${index}`),
      tokens: { ...tokens, total: 10 + index } }));
    const work = allocateFixtureWork({ contributions: rows, evidence: [] });
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'tokens' })}
      slice={withFixtureWorkAccounting({ ...slice, work })} id="usage_project_ledger" testID="ledger" />);
    const total = () => screen.findAllByType(HappierDataRows).find(node => node.props.testID === 'ledger.projects')!.props.rows[0][1];
    expect(total()).toBe(145);
    await screen.pressByTestIdAsync('ledger.project.p1.toggle');
    const sessions = () => screen.findAllByType(HappierDataRows).find(node => node.props.testID === 'ledger.project.p1.session')!.props.rows;
    expect(sessions().map((row: readonly unknown[]) => row[1])).toEqual([19, 18, 17, 16, 15, 14]);
    const footer = screen.findByTestId('ledger.project.p1.session.more');
    expect(footer?.findAll(node => typeof node.props.children === 'string' || typeof node.props.children === 'number')
      .map(node => String(node.props.children)).join(' ')).toContain('10');
    // One disclosure in both states (J-B59): opening never adds a second "Show less".
    const toggles = () => screen.findAll(node => typeof node.type === 'string'
      && /^ledger\.project\.p1\.session\..*toggle$/.test(String(node.props.testID ?? ''))).length;
    expect(toggles()).toBe(1);
    await screen.pressByTestIdAsync('ledger.project.p1.session.more.toggle');
    expect(sessions()).toHaveLength(10);
    expect(toggles()).toBe(1);
    expect(total()).toBe(145);
  });
  it.each(['linked PR', 'nested branch', 'standalone branch'] as const)(
    'recovers each fitted mark from the %s’s own detail',
    async kind => {
      // The PR and both branches share a Session but have disjoint sets. The parent also has a Session-less mark.
      const groups = ['pr', 'branch-a', 'branch-b'].map(turnId => ({
        turnId,
        agents: Array.from({ length: 10 }, (_, index) => `agent-${turnId}-${index}`),
        provider: `provider.${turnId}`,
      }));
      const projectOnly = 'provider.project-only';
      const rows: UsageWorkContribution[] = [
        ...groups.flatMap(group => group.agents.map((agentId, index) => ({
          ...contribution(agentId, 's1', group.turnId),
          agentId,
          ...(index === 0 ? { providerId: group.provider, providerConnectionId: 'connection' } : {}),
        }))),
        { ...contribution('project-only', 'unused', null), sessionId: null, agentId: null,
          providerId: projectOnly, providerConnectionId: 'connection' },
      ];
      const branchEvidence = groups.slice(1).map((group, index) => ({
        sessionId: 's1', turnId: group.turnId, repositoryKey: 'repo',
        checkpointRef: `checkpoint/s1/${group.turnId}`, checkpointCommitSha: 'a'.repeat(40),
        commitSha: 'd'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' as const,
        branch: { ref: `refs/heads/${group.turnId}`, headSha: String(index + 1).repeat(40) },
      }));
      const work = allocateFixtureWork({
        contributions: rows, evidence: [evidence('s1', 'pr', 2493)], branchEvidence,
      });
      const screen = await renderScreen(<UsageChartInteractions>
        <UsageProjectLedgerWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'tokens' })}
          slice={withFixtureWorkAccounting({ ...slice, work })} id="usage_project_ledger" testID="ledger" />
      </UsageChartInteractions>);
      if (kind !== 'standalone branch') await screen.pressByTestIdAsync('ledger.project.p1.toggle');
      const tableId = kind === 'linked PR' ? 'ledger.project.p1.prs'
        : kind === 'nested branch' ? 'ledger.project.p1.branches' : 'ledger.branches';
      const table = screen.findAllByType(HappierDataRows).find(node => node.props.testID === tableId);
      if (!table) throw new Error(`Expected ${tableId}`);
      const witnesses = kind === 'linked PR' ? groups.slice(0, 1) : groups.slice(1);
      for (const [index, group] of witnesses.entries()) {
        const row = screen.findByTestId(`${tableId}-row-${index}`);
        if (!row) throw new Error(`Expected ${tableId} row ${index}`);
        const strip = row.findByType(UsageWorkMarks);
        await layoutIdentityStrip(strip, 160);
        const visible = strip.findAllByType(UsageAgentMark).length + strip.findAllByType(UsageWorkProviderMark).length;
        const hidden = group.agents.length + 1 - visible;
        expect(hidden).toBeGreaterThan(0);
        expect(strip.findAll(node => node.props.children === t('usage.board.work.moreMarks', { count: hidden })).length).toBeGreaterThan(0);

        const names = [...group.agents.map(id => usageAgentTitle(id)),
          resolveUsageWorkProviderDisplay({ providerId: group.provider, machineIds: ['machine'] }, 'home').label];
        if (kind === 'standalone branch') {
          const key = table.props.rowIds?.[index];
          await screen.pressByTestIdAsync(`ledger.branch.${key}.toggle`);
          const identityLine = screen.findByTestId(`ledger.branch.${key}.identities`);
          expect.soft(identityLine?.props.children).toBe(names.join(' · '));
        } else {
          const exact = row.findAllByType(ChartDatum).find(node => node.props.testID === `${tableId}-datum-${index}`);
          expect.soft(exact?.props.datum.subtitle ?? '').toContain(names.join(' · '));
          expect.soft(exact?.props.datum.accessibilityLabel ?? '').toContain(names.join(' · '));
          for (const unrelated of [...groups.filter(other => other !== group).map(other => other.provider), projectOnly]) {
            expect.soft(exact?.props.datum.subtitle ?? '').not.toContain(unrelated);
          }
        }
      }
    },
  );
  it('never falls back to raw opaque Project or Session ids', async () => {
    const opaque = 'a'.repeat(64);
    const rows = [contribution('opaque', 'private-session-identifier', null)].map(row => ({ ...row, projectKey: opaque }));
    const unnamed = allocateFixtureWork({ contributions: rows, evidence: [] });
    for (const accounting of [{ ...slice.accounting!, breakdowns: undefined }, { ...slice.accounting!, breakdowns: { project: [{
      ...slice.accounting!.breakdowns!.project![0]!, key: opaque, label: `  ${'b'.repeat(64)}  `,
    }] } }]) {
      const hook = await renderHook(() => useUsageWork(withFixtureWorkAccounting({ ...slice, work: unnamed, accounting }), query, 'home'));
      expect(hook.getCurrent().projectLabel(opaque)).toBe(t('usage.board.work.unknownProject'));
      expect(hook.getCurrent().sessionLabel('private-session-identifier')).toBe(t('session.untitled'));
      expect(hook.getCurrent().summary?.projects).toMatchObject([{ projectKey: null, unnamedProjectCount: 1 }]);
      await hook.unmount();
    }
  });
  it('tells apart Sessions that share a title and folders that share a name by where and when they ran', async () => {
    const rows: UsageWorkContribution[] = [
      { ...contribution('u1', 'untitled-1', 't1'), machineId: 'machine-a', observedAtMs: 1_700_000_000_000 },
      { ...contribution('u2', 'untitled-2', 't1'), machineId: 'machine-b', observedAtMs: 1_700_000_900_000 },
      { ...contribution('u3', 'lone-session', 't1'), machineId: 'machine-a' },
    ];
    const projection = allocateFixtureWork({ contributions: rows, evidence: [] });
    const hook = await renderHook(() => useUsageWork(withFixtureWorkAccounting({ ...slice, work: projection }), query, 'home'));
    const { sessionLabel } = hook.getCurrent();
    const [first, second] = [sessionLabel('untitled-1'), sessionLabel('untitled-2')];
    expect(first).not.toBe(second);
    expect(first.startsWith(t('session.untitled'))).toBe(true);
    expect(first.length).toBeGreaterThan(t('session.untitled').length);
    await hook.unmount();
  });
  it('J-B39 keeps same-folder Projects distinct in visible and accessible ledger titles (R138)', async () => {
    const { resolveMachineDisplayNames } = await import('@/utils/sessions/machineDisplayNames');
    const { WorkspaceRefV1Schema } = await import('@/sync/domains/workspaces/workspaceRefModel');
    const previous = storage.getState();
    const scope = { serverId: actionHome!.homes.work!.id, accountId: 'work-account' };
    const projectKeys = ['b3d3f1ffe98f8b9cbf3cecc7609fc50a7206a003692eadede40ee8c082df19c1',
      'bfec72540e0d393604c67d121a6911335c2e875c0d9836adddb942a1941fb73c'];
    const machines = ['3ca2700f-c0a8-440f-be06-cb4f3f51cb01', 'eadc2422-b42b-478d-97b1-af9b530d5f08'].map(id => {
      const row = createMachineFixture({ id });
      return { ...row, metadata: row.metadata && { ...row.metadata, host: 'Shared host', displayName: 'Shared host' } };
    });
    const names = resolveMachineDisplayNames(machines);
    expect(new Set(names.values()).size).toBe(2);
    try {
      storage.getState().applyMachines(machines);
      storage.setState({ profileScope: scope, projectAccountRows: { scope, status: 'ready', coverage: 'complete',
        workspaceRefs: machines.map((machine, index) => WorkspaceRefV1Schema.parse({ id: `r138-checkout-${index}`,
          projectKey: projectKeys[index], serverId: scope.serverId, machineId: machine.id,
          rootPath: '/home/happier', createdAtMs: 0 })), relationships: [], revisionsByPhysicalKey: {}, organizations: [] } });
      const rows = machines.map((machine, index) => ({ ...contribution(`usage-${index}`, `session-${index}`, 't'),
        machineId: machine.id, projectKey: projectKeys[index]! }));
      const work = allocateFixtureWork({ contributions: rows, evidence: [] });
      const workSlice = withFixtureWorkAccounting({ ...slice, work });
      const Wrapper = ({ children }: React.PropsWithChildren) => <CommandWrapper>{children}
        <UsageProjectLedgerWidget {...props} serverId={scope.serverId} slice={workSlice}
          id="usage_project_ledger" testID="same-folder-ledger" />
      </CommandWrapper>;
      const hook = await renderHook(() => useUsageWork(workSlice, query, scope.serverId), { wrapper: Wrapper });
      const { projectLabel, projectPlace, sessionLabel, summary } = hook.getCurrent();
      expect(summary?.projects.map(row => [row.projectKey, row.amount])).toEqual(projectKeys.map(key => [key, 3]));
      expect(projectKeys.map(projectLabel)).toEqual(machines.map(machine => `happier · ${names.get(machine.id)}`));
      for (const [index, machine] of machines.entries()) {
        expect(projectPlace(projectKeys[index]!)).toBe(names.get(machine.id));
        expect(sessionLabel(`session-${index}`)).toContain(names.get(machine.id)!);
      }
      expect(projectPlace(projectKeys[0]!)).not.toBe(projectPlace(projectKeys[1]!));
      const ledger = hook.tree.root.findByType(HappierDataRows);
      expect(ledger.props.rowIds).toEqual(projectKeys);
      for (const [index, machine] of machines.entries()) expect(ledger.props.rows[index][2]).toContain(names.get(machine.id)!);
      for (const [index, key] of projectKeys.entries()) {
        const title = projectLabel(key);
        expect(ledger.props.rows[index][0]).toBe(title);
        const toggle = hook.tree.root.findAllByProps({ testID: `same-folder-ledger.project.${key}.toggle` });
        expect(toggle.some(node => node.props.accessibilityLabel === `${title} · ${projectPlace(key)}`)).toBe(true);
      }
      const text = JSON.stringify(ledger.props.rows);
      for (const key of [...projectKeys, ...machines.map(machine => machine.id)]) expect(text).not.toContain(key);
      await hook.unmount();
    } finally { storage.setState(previous, true); }
  });
  it('keeps the Session-published Machine name in Work and Session meta when the Home inventory is unavailable', async () => {
    const previous = storage.getState();
    const serverId = actionHome!.homes.work!.id;
    const session = createSessionListRenderableSessionFixture({ id: 's1', metadata: {
      name: 'Retained session', path: '/work', host: 'NLDW3-5-36-33', machineId: 'machine',
    } });
    storage.setState({ machines: {}, machineDisplayById: {}, machineListByServerId: { [serverId]: null },
      machineListStatusByServerId: { [serverId]: 'error' }, sessionListRowsByServerId: { [serverId]: { s1: session } } });
    try {
      const ledger = await renderScreen(<UsageProjectLedgerWidget {...props} serverId={serverId} id="usage_project_ledger" testID="retained-ledger" />);
      expect(ledger.getTextContent()).toContain('NLDW3-5-36-33');
      const meta = await renderScreen(<UsageSessionValueWidget {...props} serverId={serverId}
        query={normalizeUsageQuery({ ...query, session: 's1' })} id="usage_session_value" testID="retained-meta" />);
      expect(meta.getTextContent()).toContain('NLDW3-5-36-33');
      const machine = createMachineFixture({ id: 'machine' });
      await act(async () => storage.getState().applyMachines([{ ...machine,
        metadata: { ...machine.metadata!, displayName: 'Renamed computer' } }]));
      expect(ledger.getTextContent()).toContain('Renamed computer');
      expect(meta.getTextContent()).toContain('Renamed computer');
      await ledger.unmount();
      await meta.unmount();
    } finally { storage.setState(previous, true); }
  });
  it('keeps Project names whole and includes where each ran', async () => {
    const rows: UsageWorkContribution[] = [
      { ...contribution('t1', 'twin-1', 't1'), projectKey: 'tmp-a', machineId: 'machine-a' },
      { ...contribution('t2', 'twin-2', 't1'), projectKey: 'tmp-b', machineId: 'machine-b' },
      { ...contribution('t3', 'lone-1', 't1'), projectKey: 'lone-key', machineId: 'machine-a' },
    ];
    const projection = allocateFixtureWork({ contributions: rows, evidence: [] });
    const project = (key: string, label: string) => ({ ...slice.accounting!.breakdowns!.project![0]!, key, label });
    const accounting = { ...slice.accounting!, breakdowns: { project: [project('tmp-a', 'tmp'), project('tmp-b', 'tmp'), project('lone-key', 'solo')] } };
    const hook = await renderHook(() => useUsageWork(withFixtureWorkAccounting({ ...slice, work: projection, accounting }), query, 'home'));
    const { projectLabel, projectPlace, summary } = hook.getCurrent();
    expect(summary?.projects.map(row => [row.projectKey, row.amount])).toEqual([
      ['tmp-a', 3], ['tmp-b', 3], ['lone-key', 3],
    ]);
    expect([projectLabel('tmp-a'), projectLabel('tmp-b'), projectLabel('lone-key')]).toEqual(['tmp · 1', 'tmp · 2', 'solo']);
    expect(projectPlace('tmp-a')).not.toBe('');
    expect(projectPlace('tmp-a')).not.toBe(projectPlace('tmp-b'));
    expect(projectPlace('lone-key')).not.toBe('');
    await hook.unmount();
  });
  it('uses human Project labels and paths without exposing anchor keys (R137)', async () => {
    const previous = storage.getState();
    const scope = { serverId: actionHome!.homes.work!.id, accountId: 'work-account' };
    const keys = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)];
    const { WorkspaceRefV1Schema } = await import('@/sync/domains/workspaces/workspaceRefModel');
    const refs = ['/work/customer/apps/happier', '/work/personal/apps/happier'].map((rootPath, index) =>
      WorkspaceRefV1Schema.parse({ id: `checkout-${index}`, projectKey: keys[index], serverId: scope.serverId,
        machineId: 'machine-a', rootPath, createdAtMs: 0 }));
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const rows = [...refs.map(ref => {
      const key = { kind: 'workspace-ref' as const, serverId: scope.serverId, id: ref.id };
      return { key, revision: 1, content: cipher.seal({ key, value: ref }) };
    }), ...keys.map(projectKey => {
      const key = { kind: 'project-organization' as const, serverId: scope.serverId, projectKey };
      return { key, revision: 1, content: cipher.seal({ key, value: { label: 'happier' } }) };
    })];
    const owner = createProjectAccountRowsSync({ scope, cipher, isCurrent: () => true,
      transport: { read: async () => { throw new Error('Project fixture uses its census'); },
        list: async () => ({ status: 'listed', coverage: 'complete', rows }),
        mutate: async () => { throw new Error('Project names must not mutate rows'); } },
      apply: (...args) => storage.getState().applyProjectAccountRowsForScope(scope, ...args) });
    try {
      storage.setState({ profileScope: scope });
      storage.getState().activateProjectAccountRowsScope(scope);
      const work = allocateFixtureWork({ contributions: keys.map((projectKey, index) =>
        ({ ...contribution(`human-${index}`, `session-${index}`, null), projectKey })), evidence: [] });
      const hook = await renderHook(() => useUsageWork(withFixtureWorkAccounting({ ...slice, work }), query, scope.serverId));
      // Deliver protected facts after the mounted Account finishes acquisition.
      await act(async () => { await owner.refresh(); });
      const names = keys.map(key => hook.getCurrent().projectLabel(key));
      expect(names[0]).toContain('customer');
      expect(names[1]).toContain('personal');
      expect(names.slice(2)).toEqual(['happier · 3', 'happier · 4']);
      for (const key of keys) expect(names.join(' ')).not.toContain(key);
      expect(hook.getCurrent().summary?.projects.map(row => row.projectKey).sort()).toEqual([...keys].sort());
      await hook.unmount();
    } finally { storage.setState({ profileScope: previous.profileScope, projectAccountRows: previous.projectAccountRows }); }
  });
  it('keeps repeated unnamed Projects unnamed without expanding the anchor ledger (R137)', async () => {
    const previous = storage.getState();
    const scope = { serverId: actionHome!.homes.work!.id, accountId: 'work-account' };
    const namedKey = 'a'.repeat(64);
    const unnamedKeys = ['b'.repeat(64), 'c'.repeat(64)];
    const opaqueLabel = 'd'.repeat(64);
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const rows = [namedKey, ...unnamedKeys].map(projectKey => {
      const key = { kind: 'project-organization' as const, serverId: scope.serverId, projectKey };
      return { key, revision: 1, content: cipher.seal({ key, value: { label: projectKey === namedKey ? 'happier' : opaqueLabel } }) };
    });
    const owner = createProjectAccountRowsSync({ scope, cipher, isCurrent: () => true,
      transport: { read: async () => { throw new Error('Label read uses its census'); },
        list: async () => ({ status: 'listed', coverage: 'complete', rows }),
        mutate: async () => { throw new Error('Label read must not mutate Project rows'); } },
      apply: (...args) => storage.getState().applyProjectAccountRowsForScope(scope, ...args) });
    try {
      storage.setState({ profileScope: scope });
      storage.getState().activateProjectAccountRowsScope(scope);
      const work = allocateFixtureWork({ contributions: [namedKey, ...unnamedKeys].flatMap((projectKey, index) =>
        [0, 1].map(part => ({ ...contribution(`anchor-${index}-${part}`, `session-${index}`, `turn-${part}`), projectKey }))), evidence: [] });
      const hook = await renderHook(() => useUsageWork(withFixtureWorkAccounting({ ...slice, work }), query, scope.serverId));
      await act(async () => { await owner.refresh(); });
      expect(hook.getCurrent().projectLabel(namedKey)).toBe('happier');
      expect(hook.getCurrent().summary?.projects).toHaveLength(2);
      expect(hook.getCurrent().summary?.projects.map(row => ({ key: row.projectKey, amount: row.amount, unnamed: row.unnamedProjectCount })))
        .toEqual(expect.arrayContaining([{ key: namedKey, amount: 6, unnamed: 0 }, { key: null, amount: 12, unnamed: 2 }]));
      for (const key of unnamedKeys) expect(hook.getCurrent().projectLabel(key)).toBe(t('usage.board.work.unknownProject'));
      expect(hook.getCurrent().projectLabel(null)).toBe(t('usage.board.work.unknownProject'));
      await hook.unmount();
    } finally { storage.setState({ profileScope: previous.profileScope, projectAccountRows: previous.projectAccountRows }); }
  });
  it('keeps an unanswered All Coach evaluation pending instead of claiming there are no findings', async () => {
    const allQuery = normalizeUsageQuery({ ...query, period: { relative: 'all' } });
    const pendingSlice = resolveUsagePageAggregation({ queries: [allQuery],
      accounting: [{ query: allQuery, status: 'available', value: slice.accounting!, asOfMs: 1000 }],
      sources: [{ source: 'how_you_work', status: 'pending' }], nowMs: 1000 }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsageCoachWidget {...props} query={allQuery} slice={pendingSlice}
      id="usage_coach" testID="first-coach" />);
    expect(screen.findHostByTestId('first-coach.empty')).toBeNull();
    expect(screen.findHostByTestId('first-coach.loading')).not.toBeNull();
    // While it reads, the band claims no count and shows no unknown figure: an unread check is not one that needs
    // more evidence, no finding is not yet zero findings, and an unknown is never the lead row (owner ruling 11-13).
    const metric = (key: string) => screen.findAllByType(HappierDataMetric).find(node => node.props.testID === `first-coach.summary.${key}`)?.props.value;
    expect(['findings', 'insufficient'].map(metric)).toEqual([undefined, undefined]);
    expect(screen.findAllByType(HappierDataMetric).filter(node => String(node.props.testID).startsWith('first-coach.summary.'))
      .map(node => node.props.value)).not.toContain('—');
    // A subsequent progress revision retains the incomplete evaluation as stale.
    // That qualification is not proof that the private evidence has answered.
    const retainedPending = resolveUsagePageAggregation({ queries: [allQuery],
      accounting: [{ query: allQuery, status: 'available', value: slice.accounting!, asOfMs: 1000 }],
      previous: { v: 1, results: [pendingSlice] },
      sources: [{ source: 'how_you_work', status: 'pending' }], nowMs: 1000 }, bundledUsageModelPriceCatalog).results[0]!;
    expect(retainedPending.coach?.currentness).toBe('stale');
    await screen.update(<UsageCoachWidget {...props} query={allQuery} slice={retainedPending}
      id="usage_coach" testID="first-coach" />);
    expect(screen.findHostByTestId('first-coach.empty')).toBeNull();
    expect(screen.findHostByTestId('first-coach.loading')).not.toBeNull();
    const settledSlice = resolveUsagePageAggregation({ queries: [allQuery],
      accounting: [{ query: allQuery, status: 'available', value: slice.accounting! }],
      howYouWork: [{ query: allQuery, asOfMs: 1000, detail: { status: 'available', facts: [] } }], nowMs: 1000 }, bundledUsageModelPriceCatalog).results[0]!;
    await screen.update(<UsageCoachWidget {...props} query={allQuery} slice={settledSlice}
      id="usage_coach" testID="first-coach" />);
    expect(screen.findHostByTestId('first-coach.empty')).not.toBeNull();
    expect(metric('findings')).toBe(0);
  });
  it('leads the facts band with the listed findings while another source still reads, never a row of dashes (USAGE-ACCEPT #8)', async () => {
    const pendingSlice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting!, asOfMs: 1000 }],
      sources: [{ source: 'how_you_work', status: 'pending' }], nowMs: 1000 }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={{ ...pendingSlice, coach }} id="usage_coach" testID="reading-coach" />);
    expect(coach.findings.length).toBeGreaterThan(0);
    const band = screen.findAllByType(HappierDataMetric).filter(node => String(node.props.testID).startsWith('reading-coach.summary.'));
    expect(band.find(node => node.props.testID === 'reading-coach.summary.findings')?.props.value).toBe(coach.findings.length);
    expect(band.map(node => node.props.value)).not.toContain('—');
  });
  it('never reassures a first-use Coach whose every check still needs evidence, and leads to a session (C3)', async () => {
    const settled = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting! }],
      howYouWork: [{ query, asOfMs: 1000, detail: { status: 'available', facts: [] } }], nowMs: 1000 }, bundledUsageModelPriceCatalog).results[0]!;
    expect(settled.coach!.evaluations.some(row => row.status === 'no_finding')).toBe(false);
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={settled} id="usage_coach" testID="new-coach" />);
    const empty = screen.findHostByTestId('new-coach.empty');
    expect(empty).not.toBeNull();
    const words = screen.getTextContent();
    expect(words).not.toContain(t('usage.board.coach.emptyTitle'));
    expect(words).toContain(t('usage.board.coach.firstUseTitle'));
    expect(words).toContain(t('usage.board.coach.firstUseAction'));
  });
  it('shows admitted Sessions checked from the canonical result and recovers after retry', async () => {
    const project = (admitted: number, notRead?: number) => resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting!, asOfMs: 1000 }],
      howYouWork: [{ query, asOfMs: 1000, sessionCoverage: { selected: 5, admitted, ...(notRead === undefined ? {} : { notRead }) },
        detail: { status: admitted < 5 ? 'partial' : 'available', facts: [] } }], nowMs: 1000 }, bundledUsageModelPriceCatalog).results[0]!;
    const partial = project(3);
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={partial} id="usage_coach" testID="coverage-coach" />);
    const metric = (key: string) => screen.findAllByType(HappierDataMetric).find(node => node.props.testID === `coverage-coach.summary.${key}`)?.props.value;
    expect(metric('sessions')).toBe(3);
    expect(metric('insufficient')).toBeGreaterThan(0);
    await screen.update(<UsageCoachWidget {...props} slice={project(5, 5)} id="usage_coach" testID="coverage-coach" />);
    expect(metric('sessions')).toBe(0);
    await screen.update(<UsageCoachWidget {...props} slice={project(5, 2)} id="usage_coach" testID="coverage-coach" />);
    expect(metric('sessions')).toBe(3);
    const recovered = project(5);
    await screen.update(<UsageCoachWidget {...props} slice={recovered} id="usage_coach" testID="coverage-coach" />);
    expect(metric('sessions')).toBe(5);
    expect(screen.findHostByTestId('coverage-coach.summary.sessions')?.props.accessibilityLabel)
      .toContain(`${t('usage.board.coach.summarySessions')}: 5`);
    const periodOnly = { ...slice, accounting: UsageAnalyticsQueryResponseSchema.parse({ ...slice.accounting,
      breakdowns: { ...slice.accounting!.breakdowns, session: ['s1', 's2'].map(key => ({ ...slice.accounting!.breakdowns!.project![0]!, key })) } }) };
    await screen.update(<UsageCoachWidget {...props} slice={periodOnly} id="usage_coach" testID="coverage-coach" />);
    expect(metric('sessions')).toBeUndefined();
    // An unknown session count leaves the band rather than standing in it as a dash.
    await screen.update(<UsageCoachWidget {...props} slice={{ ...slice, accounting: undefined }} id="usage_coach" testID="coverage-coach" />);
    expect(metric('sessions')).toBeUndefined();
    expect(screen.findHostByTestId('coverage-coach.summary.sessions')).toBeNull();
  });
  it('does not reserve a second cold-read room inside the Coach widget', async () => {
    const pendingSlice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting!, asOfMs: 1000 }],
      sources: [{ source: 'how_you_work', status: 'pending' }], nowMs: 1000 }, bundledUsageModelPriceCatalog).results[0]!;
    const heldRoom = async (size: 'medium' | 'large') => {
      const screen = await renderScreen(<WidgetPresentationProvider value={{ size,
        footprint: { columns: 1, columnSpan: 1, rowSpan: 2, width: 'full', height: 'regular' }, geometry: { width: 326, height: 260 } }}>
        <UsageCoachWidget {...props} slice={pendingSlice} id="usage_coach" testID="phone-coach" />
      </WidgetPresentationProvider>);
      // Cold-read room belongs to UsageWidgetBody's usageBodyHeightMemory owner.
      let held = 0;
      for (let node = screen.findHostByTestId('phone-coach.coach')?.parent; node; node = node.parent) {
        for (const entry of ([] as unknown[]).concat(node.props.style ?? []).flat(2)) {
          if (entry && typeof entry === 'object' && 'minHeight' in entry) held = Math.max(held, Number(entry.minHeight));
        }
      }
      return held;
    };
    expect(await heldRoom('medium')).toBe(0);
    // The Coach's own view lists freely: nothing is held there.
    expect(await heldRoom('large')).toBe(0);
  });
  it.each([
    'baseline Machines, shared Work Machine',
    'different checkout parents',
    'same exact checkout',
    'three indistinguishable places',
    'nine worktrees',
    'explicit organization title',
    'unnamed Project',
    'literal title collides with a generated title',
  ])('J-B39 keeps Work and the options projector in agreement for %s', async scenario => {
    const { createProjectAnchorOfKeyV1, projectProjectListV1, resolveWorkspaceRefV1 } =
      await import('@happier-dev/protocol/workspaces');
    const { projectUsageOptionFacts, readUsageProjectOptionTitles, readUsageScopeOptions } =
      await import('@happier-dev/protocol/usage/usageFilterOptions');
    const { useUsageProjectNames } = await import('./usageBodyKit');
    const previous = storage.getState();
    const scope = { serverId: actionHome!.homes.work!.id, accountId: 'work-account' };
    const checkout = (id: string, projectKey: string, rootPath: string, createdAtMs = 1, machineId = 'work') =>
      ({ id, projectKey, rootPath, createdAtMs, serverId: scope.serverId, machineId });
    const baseline = checkout('one', 'a', '/workspace/repo', 1, 'first-box');
    const second = checkout('two', 'b', '/workspace/repo', 1, 'second-box');
    const worktrees = [checkout('one-worktree', 'a', '/worktrees/one', 2), checkout('two-worktree', 'b', '/worktrees/two', 2)];
    const organization = (projectKey: string, label: string) => ({
      key: { kind: 'project-organization' as const, serverId: scope.serverId, projectKey }, revision: 1, value: { label },
    });
    let refs = [baseline, second, ...worktrees];
    let organizations: ReturnType<typeof organization>[] = [];
    let expected = ['repo · First box', 'repo · Second box'];
    let keys = ['a', 'b'];
    let machineNames: Record<string, string> = { 'first-box': 'First box', 'second-box': 'Second box', work: 'Work box' };

    switch (scenario) {
      case 'different checkout parents':
        refs = [checkout('one', 'a', '/customer/repo'), checkout('two', 'b', '/personal/repo')];
        expected = ['repo · customer', 'repo · personal'];
        break;
      case 'same exact checkout': {
        const repeated = resolveWorkspaceRefV1([baseline], {
          serverId: scope.serverId, machineId: baseline.machineId, rootPath: baseline.rootPath + '/',
        });
        expect(repeated.kind).toBe('resolved');
        if (repeated.kind !== 'resolved') throw new Error('Exact checkout was not reused');
        expect(repeated.ref.id).toBe(baseline.id);
        refs = [repeated.ref];
        keys = ['a', repeated.ref.id];
        expected = ['repo'];
        break;
      }
      case 'three indistinguishable places':
        refs = [baseline, second, checkout('three', 'c', '/workspace/repo', 1, 'offline-box')];
        keys = ['a', 'b', 'c'];
        expected = ['repo · 1', 'repo · 2', 'repo · 3'];
        machineNames = { work: 'Work box' };
        break;
      case 'nine worktrees':
        refs = [baseline, ...Array.from({ length: 9 }, (_, i) => ({
          ...checkout(`worktree-${i}`, 'a', `/worktrees/usage-outcome-${i + 1}`, i + 2),
          lastOpenedAtMs: i + 100,
        }))];
        keys = ['a'];
        expected = ['repo'];
        break;
      case 'explicit organization title':
        organizations = [organization('b', 'Main operations')];
        expected = ['repo', 'Main operations'];
        break;
      case 'unnamed Project':
        refs = [checkout('private', 'a', `/work/${'f'.repeat(64)}`)];
        keys = ['a'];
        expected = ['No project name'];
        break;
      case 'literal title collides with a generated title':
        organizations = [organization('c', 'repo · First box')];
        keys = ['a', 'b', 'c'];
        expected = ['repo · 1', 'repo · Second box', 'repo · First box'];
        break;
    }
    const machines = Object.entries(machineNames).map(([id, displayName]) => {
      const row = createMachineFixture({ id });
      return { ...row, metadata: row.metadata && { ...row.metadata, host: displayName, displayName } };
    });
    const inventory: typeof slice = { ...slice, accounting: { ...slice.accounting!, breakdowns: undefined, scopeKeys: [{
      dimension: 'project', keys, projectMachines: keys.map(key => ({ key, machineIds: ['work'] })),
    }] } };
    const hook = await renderBareHook(() => useUsageProjectNames(scope.serverId));
    try {
      for (const workspaceRefs of [refs, [...refs].reverse()]) {
        await act(async () => {
          storage.getState().applyMachines(machines);
          storage.setState({ profileScope: scope, projectAccountRows: { scope, status: 'ready', coverage: 'complete',
            workspaceRefs, relationships: [], revisionsByPhysicalKey: {}, organizations } });
        });
        const { projectGroups, hiddenProjectGroups } = projectProjectListV1({ ...scope, workspaceRefs, organizations });
        const options = { projectFacts: projectUsageOptionFacts([...projectGroups, ...hiddenProjectGroups], organizations), machineNames };
        const anchorOf = createProjectAnchorOfKeyV1(workspaceRefs);
        const picker = readUsageProjectOptionTitles([inventory], [], key => anchorOf(scope.serverId, key), options);
        const action = readUsageScopeOptions([inventory], 'projects', [], key => anchorOf(scope.serverId, key), options);
        const projectedKeys = [...new Set(keys.map(key => anchorOf(scope.serverId, key)))];

        expect.soft(projectedKeys.map(id => hook.getCurrent().label(id))).toEqual(expected);
        expect.soft(projectedKeys.map(id => picker.get(id))).toEqual(expected.map(title => title === 'No project name' ? null : title));
        expect.soft([...action]).toEqual(projectedKeys.map((key, index) => [key, expected[index]]));
        expect.soft(new Set(action.values()).size).toBe(projectedKeys.length);
        if (scenario === 'baseline Machines, shared Work Machine') {
          const scoped = { ...inventory, accounting: { ...inventory.accounting!,
            scopeKeys: [{ dimension: 'project' as const, keys: ['a'] }] } };
          expect.soft([...readUsageScopeOptions([scoped], 'projects', [], undefined, options)])
            .toEqual([['a', expected[0]]]);
        }
      }
    } finally {
      await hook.unmount();
      storage.setState(previous, true);
    }
  });
  it('renders the Usage Project anchor only when a checkout joins a Project', async () => {
    const { WorkspaceRefV1Schema } = await import('@/sync/domains/workspaces/workspaceRefModel');
    const { useUsageProjectAnchorOf } = await import('./usageBodyKit');
    const previous = storage.getState();
    const scope = { serverId: actionHome!.homes.work!.id, accountId: 'work-account' };
    const rows = { scope, status: 'ready' as const, coverage: 'complete' as const,
      relationships: [], revisionsByPhysicalKey: {}, organizations: [] };
    const checkout = WorkspaceRefV1Schema.parse({ id: 'checkout', serverId: scope.serverId,
      machineId: 'machine', rootPath: '/checkout', createdAtMs: 0 });
    storage.setState({ profileScope: scope, projectAccountRows: { ...rows, workspaceRefs: [] } });
    let renders = 0;
    const hook = await renderHook(() => {
      renders++;
      return useUsageProjectAnchorOf(scope.serverId);
    });
    try {
      const before = renders;
      for (let i = 0; i < 10; i++) {
        await act(async () => storage.setState({ projectAccountRows: { ...rows,
          workspaceRefs: [{ ...checkout, createdAtMs: i }] } }));
      }
      expect.soft(renders - before).toBe(0);
      expect(hook.getCurrent().resolve(checkout.id)).toBe(checkout.id);
      await act(async () => storage.setState({ projectAccountRows: { ...rows,
        workspaceRefs: [{ ...checkout, projectKey: 'joined-project' }] } }));
      expect(hook.getCurrent().resolve(checkout.id)).toBe('joined-project');
      expect(renders - before).toBe(1);
    } finally {
      await hook.unmount();
      storage.setState({ profileScope: previous.profileScope, projectAccountRows: previous.projectAccountRows });
    }
  });

  it('keeps Usage Project joins and options quiet through revision-only census publications', async () => {
    const { WorkspaceRefV1Schema } = await import('@/sync/domains/workspaces/workspaceRefModel');
    const { useUsageProjectAnchorOf, useUsageProjectOptionFacts } = await import('./usageBodyKit');
    const previous = storage.getState();
    const scope = { serverId: actionHome!.homes.work!.id, accountId: 'work-account' };
    const checkout = WorkspaceRefV1Schema.parse({ id: 'checkout', serverId: scope.serverId,
      projectKey: 'project', machineId: 'machine', rootPath: '/checkout', createdAtMs: 0 });
    const rows = { scope, status: 'ready' as const, coverage: 'complete' as const,
      relationships: [], revisionsByPhysicalKey: {}, organizations: [], workspaceRefs: [checkout] };
    let renders = 0;
    const hook = await renderHook(() => {
      renders++;
      return { anchor: useUsageProjectAnchorOf(scope.serverId), options: useUsageProjectOptionFacts(scope.serverId) };
    });
    try {
      const publish = (next: typeof rows) => storage.getState().applyProjectAccountRowsForScope(scope, next);
      await act(async () => {
        storage.setState({ profileScope: scope });
        storage.getState().activateProjectAccountRowsScope(scope);
        publish(rows);
      });
      const refs = storage.getState().projectAccountRows!.workspaceRefs;
      const filter = vi.spyOn(refs, 'filter');
      try {
        expect(hook.getCurrent().anchor.resolve(checkout.id)).toBe('project');
        expect(hook.getCurrent().options?.get('project')?.machineIds).toEqual(['machine']);
        const before = renders;
        const checkoutKey = buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: scope.serverId, id: checkout.id });
        for (let i = 0; i < 10; i++) {
          await act(async () => publish({ ...rows, revisionsByPhysicalKey: { [checkoutKey]: i } }));
          expect(storage.getState().projectAccountRows?.workspaceRefs).toBe(refs);
        }
        expect(storage.getState().projectAccountRows?.revisionsByPhysicalKey[checkoutKey]).toBe(9);
        expect.soft(filter).not.toHaveBeenCalled();
        expect.soft(renders - before).toBe(0);
        await act(async () => publish({ ...rows, workspaceRefs: [{ ...checkout, projectKey: 'moved-project', machineId: 'moved-machine' }],
          revisionsByPhysicalKey: { [checkoutKey]: 10 } }));
        expect(hook.getCurrent().anchor.resolve(checkout.id)).toBe('moved-project');
        expect(hook.getCurrent().options?.get('moved-project')?.machineIds).toEqual(['moved-machine']);
        expect(renders - before).toBe(1);
      } finally { filter.mockRestore(); }
    } finally {
      await hook.unmount();
      storage.setState({ profileScope: previous.profileScope, projectAccountRows: previous.projectAccountRows });
    }
  });

  it('keeps managed Project names without inventing a Machine identity', async () => {
    const { WorkspaceRefV1Schema } = await import('@/sync/domains/workspaces/workspaceRefModel');
    const previous = storage.getState();
    const scope = { serverId: actionHome!.homes.work!.id, accountId: 'work-account' };
    try {
      const { useUsageProjectNames } = await import('./usageBodyKit');
      const names = await renderBareHook(() => useUsageProjectNames(scope.serverId));
      await act(async () => storage.setState({ profileScope: scope, projectAccountRows: { scope, status: 'ready', coverage: 'complete',
        workspaceRefs: [WorkspaceRefV1Schema.parse({ v: 2, kind: 'managed', id: 'guest-checkout', serverId: scope.serverId,
          projectKey: 'managed-project', managedId: 'sandbox', controller: { machineId: 'controller', installationId: 'installation' },
          rootPath: '/home/guest/repo', createdAtMs: 1 })], relationships: [], revisionsByPhysicalKey: {}, organizations: [] } }));
      expect(names.getCurrent().machineIds.get('managed-project')).toEqual([]);
      await names.unmount();
    } finally {
      storage.setState({ profileScope: previous.profileScope, projectAccountRows: previous.projectAccountRows });
    }
  });
  it.each(['plain', 'e2ee'] as const)('names Work from the admitted protected Project producer and retires it on Account loss (%s)', async mode => {
    const previous = storage.getState();
    const scope = { serverId: actionHome!.homes.work!.id, accountId: 'work-account' };
    const cipher = createProjectAccountRowCipherV1({ mode,
      material: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(5) },
      randomBytes: length => new Uint8Array(length).fill(3) });
    // Native/owner-root accounting has an organization label without fabricating
    // a checkout that would retain a private path (the observed live Work producer).
    const rowKey = { kind: 'project-organization' as const, serverId: 'producer-cli-profile', projectKey: 'p1' };
    const content = cipher.seal({ key: rowKey, value: { label: 'Human project' } });
    // Exercise the exact QA label, distinct from its accounting key, through
    // protected storage; the old accounting-only filter never saw this ingress.
    const opaque = '84ae4f69031158170a5d5dd1f71dce833e983675d3632a33ead3592cba283061';
    const opaqueKey = { ...rowKey, projectKey: 'opaque-project' };
    const opaqueContent = cipher.seal({ key: opaqueKey, value: { label: opaque } });
    const twinKey = { ...rowKey, projectKey: 'twin-project-anchor' };
    const twinContent = cipher.seal({ key: twinKey, value: { label: 'Human project' } });
    const otherOpaqueKey = { ...rowKey, projectKey: 'other-opaque-project' };
    const otherOpaqueContent = cipher.seal({ key: otherOpaqueKey, value: { label: 'b'.repeat(64) } });
    const namedWork = allocateFixtureWork({ contributions: [...contributions,
      { ...contribution('opaque', 'opaque-session', null), projectKey: opaqueKey.projectKey },
      { ...contribution('other-opaque', 'other-opaque-session', null), projectKey: otherOpaqueKey.projectKey }], evidence: [] });
    const owner = createProjectAccountRowsSync({ scope, cipher, isCurrent: () => true,
      transport: { read: async () => { throw new Error('Label read uses its census'); },
        list: async () => ({ status: 'listed', coverage: 'complete', rows: [{ key: rowKey, revision: 1, content }, { key: twinKey, revision: 1, content: twinContent },
        { key: opaqueKey, revision: 1, content: opaqueContent }, { key: otherOpaqueKey, revision: 1, content: otherOpaqueContent }] }),
        mutate: async () => { throw new Error('Label read must not mutate Project rows'); } },
      apply: (...args) => storage.getState().applyProjectAccountRowsForScope(scope, ...args) });
    try {
      storage.setState({ profileScope: scope });
      storage.getState().activateProjectAccountRowsScope(scope);
      const workSlice = withFixtureWorkAccounting({ ...slice, work: namedWork });
      const screen = await renderScreen(<UsageProjectLedgerWidget {...props} serverId={scope.serverId} slice={workSlice} id="usage_project_ledger" testID="label-ledger" />);
      await act(async () => { await owner.refresh(); });
      expect(storage.getState().projectAccountRows?.organizations ?? [], JSON.stringify({
        profileScope: storage.getState().profileScope, rows: storage.getState().projectAccountRows,
      })).toContainEqual(expect.objectContaining({ key: rowKey, value: { label: 'Human project' } }));
      expect(screen.getTextContent()).toContain('Human project');
      const { useUsageProjectNames } = await import('./usageBodyKit');
      const labels = await renderHook(() => useUsageProjectNames(scope.serverId));
      expect(labels.getCurrent().labels.get(rowKey.projectKey)).toBe('Human project · 1');
      expect(labels.getCurrent().labels.get(twinKey.projectKey)).toBe('Human project · 2');
      await labels.unmount();
      expect(screen.getTextContent()).not.toContain(opaque);
      const hook = await renderHook(() => useUsageWork(workSlice, query, scope.serverId));
      expect(hook.getCurrent().summary?.projects).toMatchObject([
        { projectKey: 'p1' }, { projectKey: null, unnamedProjectCount: 2, amount: 6 },
      ]);
      await hook.unmount();
      await act(async () => storage.getState().setProjectAccountRowsStatusForScope(scope, 'locked'));
      expect(screen.getTextContent()).not.toContain('Human project');
      await act(async () => storage.getState().setProjectAccountRowsStatusForScope(scope, 'ready'));
      expect(screen.getTextContent()).toContain('Human project');
      await act(async () => storage.setState({ profileScope: { ...scope, serverId: 'other-home' } }));
      expect(screen.getTextContent()).not.toContain('Human project');
      await act(async () => storage.setState({ profileScope: scope }));
      expect(screen.getTextContent()).toContain('Human project');
      await act(async () => storage.setState({ profileScope: { ...scope, accountId: 'other-account' } }));
      expect(screen.getTextContent()).not.toContain('Human project');
      await screen.unmount();
    } finally {
      storage.setState({ profileScope: previous.profileScope, projectAccountRows: previous.projectAccountRows,
        pinnedWorkspaceRefIds: previous.pinnedWorkspaceRefIds });
    }
  });
  it('projects the measured growing request into Coach Why after a later zero-input observation', async () => {
    const rows = [100, 200, 300, 200, 0].map((input, index) => {
      const categories = { input, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0, total: input + 10 };
      return { ...contribution(`growth-${index}`, 'growth-session', `turn-${index}`),
        eventCount: 1, observedAtMs: 10 + index * 10, tokens: categories, tokenCategories: categories };
    });
    const evaluation = evaluateUsageCoach({ queryKey: key, period: { startMs: 0, endMs: 1000 }, asOfMs: 1000,
      currentness: 'current', accounting: { ...slice.accounting!, contributions: rows } }, bundledUsageModelPriceCatalog);
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={{ ...slice, coach: evaluation }}
      id="usage_coach" testID="coach" />);
    await screen.pressByTestIdAsync('coach.finding.context_bloat.why-header');
    const measured = screen.findByTestId('coach.finding.context_bloat.evidence.measurements')!;
    const texts = measured.findAll(node => typeof node.props.children === 'string').map(node => node.props.children);
    expect(texts).toContain(`300 ${t('usage.board.coach.metric_composed_tokens')}`);
    expect(texts).not.toContain(`0 ${t('usage.board.coach.metric_composed_tokens')}`);
  });
  it('draws a finding\'s measured samples as its mini chart on the Coach view, never a single sample as a trend', async () => {
    const rows = [1000, 2000, 3001, 2000, 0].map((input, index) => {
      const categories = { input, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0, total: input + 10 };
      return { ...contribution(`growth-${index}`, 'growth-session', `turn-${index}`),
        eventCount: 1, observedAtMs: 10 + index * 10, tokens: categories, tokenCategories: categories };
    });
    const evaluation = evaluateUsageCoach({ queryKey: key, period: { startMs: 0, endMs: 1000 }, asOfMs: 1000,
      currentness: 'current', accounting: { ...slice.accounting!, contributions: rows } }, bundledUsageModelPriceCatalog);
    const finding = evaluation.findings.find(entry => entry.detectorId === 'context_bloat')!;
    expect(finding.evidenceSeries?.[0]?.points.length).toBeGreaterThan(1);
    const single = { ...evaluation, findings: evaluation.findings.map(entry => entry === finding
      ? { ...entry, evidenceSeries: [{ ...entry.evidenceSeries![0]!, points: [entry.evidenceSeries![0]!.points[0]!] }] } : entry) };
    const wide = (coach: typeof evaluation) => <WidgetPresentationProvider value={{ size: 'large',
      footprint: { columns: 2, columnSpan: 2, rowSpan: 4, width: 'full', height: 'tall' }, geometry: { width: 1000, height: 800 } }}>
      <UsageCoachWidget {...props} slice={{ ...slice, coach }} id="usage_coach" testID="coach" />
    </WidgetPresentationProvider>;
    const once = await renderScreen(wide(single));
    expect(once.findByTestId('coach.finding.context_bloat')).toBeTruthy();
    expect(once.findHostByTestId('coach.finding.context_bloat.trend')).toBeFalsy();
    const priced = { ...evaluation, findings: evaluation.findings.map(entry => entry !== finding ? entry : { ...entry,
      estimate: { kind: 'observed_difference' as const, value: 1.23456, unit: 'currency' as const, currency: 'USD',
        method: 'matched_outcome_cost_v1' as const, assumptions: [], period: { startMs: 0, endMs: 1000 }, evidenceIds: ['growth-2'] } }) };
    const screen = await renderScreen(wide(priced));
    expect(screen.findHostByTestId('coach.finding.context_bloat.trend')).toBeTruthy();
    expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'coach.finding.context_bloat.meta.detail')?.props.datum.value).toContain('3,001');
    expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'coach.finding.context_bloat.estimate.detail')?.props.datum.value).toContain('USD 1.23456');
    // The spark's caption names its largest sample and when it was taken, never a trailing zero as "Latest"
    // (acceptance 11-21 #12).
    expect(screen.getTextContent()).toContain(t('usage.board.coach.peakSample', { value: '' }).trim());
    expect(screen.getTextContent()).toContain(formatUsageObservedAt(30));
    expect(screen.getTextContent()).not.toContain(t('usage.board.coach.peakSample', { value: `0 ${t('usage.board.coach.metric_context_window_tokens')}` }));
    // A finding without an estimate leaves its impact column empty, never an unlabeled dash beside the menu.
    const unpriced = await renderScreen(wide(evaluation));
    expect(unpriced.findHostByTestId('coach.finding.context_bloat.trend')).toBeTruthy();
    expect(unpriced.findHostByTestId('coach.finding.context_bloat.impact')).toBeTruthy();
    expect(unpriced.findHostByTestId('coach.finding.context_bloat.impact')!.findAll(node => node.children.includes('—'))).toHaveLength(0);
    // Before the frame measures it, a full-width Coach already draws its wide row (trend in place): the row never
    // settles 10 px when the measurement lands (R141).
    const unmeasured = await renderScreen(<WidgetPresentationProvider value={{ size: 'large',
      footprint: { columns: 2, columnSpan: 2, rowSpan: 4, width: 'full', height: 'tall' } }}>
      <UsageCoachWidget {...props} slice={{ ...slice, coach: priced }} id="usage_coach" testID="coach" />
    </WidgetPresentationProvider>);
    expect(unmeasured.findHostByTestId('coach.finding.context_bloat.trend')).toBeTruthy();
  });
  it('does not open digest scheduling without a captured Account', async () => {
    const digestSlice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: slice.accounting!, status: 'available', asOfMs: 1000 }] }, bundledUsageModelPriceCatalog).results[0]!;
    storage.setState({ profileScope: null });
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={digestSlice} id="usage_coach" testID="coach" />);
    expect(screen.findByTestId('coach.digest.configure')).toBeTruthy();
    expect(screen.findByTestId('coach.digest.configure')?.props.disabled).toBe(true);
    expect(screen.findByTestId('coach.digest.editor')).toBeNull();
    await screen.pressByTestIdAsync('coach.digest.configure');
    expect(screen.findByTestId('coach.digest.editor')).toBeNull();
  });
  // USAGE-ACCEPT 1121 #13: the qualifier is said once for the group, never on its rows.
  it.each([true, false])('says the Session value token qualifier once for its group, never per row (all from parts: %s)', async allFromParts => {
    const parts = { ...contribution('parts', 's1', 't1'),
      tokens: { input: 10, output: 3, reasoning: null, cacheRead: null, cacheWrite: null, total: null } };
    const reported = contribution('second', 's2', 't2');
    const work = allocateFixtureWork({
      contributions: [parts, allFromParts ? { ...reported, tokens: parts.tokens } : reported], evidence: [],
    });
    const screen = await renderScreen(<UsageSessionValueWidget {...props}
      query={normalizeUsageQuery({ ...query, metric: 'tokens' })} slice={withFixtureWorkAccounting({ ...slice, work })}
      id="usage_session_value" testID="value" />);
    const rows = screen.findAllByType(RankedRows).find(node => node.props.testID === 'value.unlinked')!.props.rows as
      readonly { id: string; annotation?: string }[];
    const qualifier = t('usage.board.page.tokensFromParts');
    expect(Object.fromEntries(rows.map(row => [row.id, row.annotation?.includes(qualifier) ?? false])))
      .toEqual({ s1: false, s2: false });
    expect(screen.getTextContent().split(t(allFromParts ? 'usage.board.page.tokensFromPartsOnce' : 'usage.board.page.tokensFromPartsSome'))).toHaveLength(2);
  });
  it('says one parts qualifier across Session value groups and one across Outcomes rows', async () => {
    const parts = { ...tokens, total: null };
    const work = allocateFixtureWork({ contributions: [
      { ...contribution('first', 's1', 't1'), tokens: parts },
      { ...contribution('second', 's2', 't2'), tokens: parts },
      { ...contribution('third', 's3', 't3'), tokens: parts },
    ], evidence: [evidence('s1', 't1', 1), evidence('s2', 't2', 2)] });
    const tokenQuery = normalizeUsageQuery({ ...query, metric: 'tokens' });
    const value = await renderScreen(<UsageSessionValueWidget {...props} query={tokenQuery} slice={withFixtureWorkAccounting({ ...slice, work })}
      id="usage_session_value" testID="value" />);
    const outcomes = await renderScreen(<UsageOutcomesWidget {...props} query={tokenQuery} slice={withFixtureWorkAccounting({ ...slice, work })}
      id="usage_outcomes" testID="outcomes" />);
    expect(value.findByTestId('value.merged')).toBeTruthy();
    expect(value.findByTestId('value.unlinked')).toBeTruthy();
    const qualifier = t('usage.board.page.tokensFromPartsOnce');
    expect([value.getTextContent().split(qualifier).length - 1, outcomes.getTextContent().split(qualifier).length - 1])
      .toEqual([1, 1]);
  });

  it('draws every Session value group against one bar scale, so a small linked Session never fills a bar (acceptance r230 #82)', async () => {
    const sized = (id: string, sessionId: string, turnId: string, total: number) =>
      ({ ...contribution(id, sessionId, turnId), tokens: { ...tokens, total } });
    const work = allocateFixtureWork({ contributions: [sized('small', 's1', 't1', 100), sized('big', 's2', 't2', 10_000)],
      evidence: [evidence('s1', 't1', 7)] });
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'tokens' })}
      slice={withFixtureWorkAccounting({ ...slice, work })} id="usage_session_value" testID="value" />);
    const linked = screen.findAllByType(RankedRows).find(node => node.props.testID !== 'value.unlinked')!;
    const bar = (id: string) => screen.findAllByType(HappierProgress).find(node => node.props.testID === `${id}-bar-0`)?.props.value as number;
    expect([bar(linked.props.testID as string), bar('value.unlinked')]).toEqual([0.01, 1]);
  });

  it('groups Session value counts by locale, like every other Usage count (acceptance r230 #86)', async () => {
    const readings = Array.from({ length: 1001 }, (_, index) => contribution(`row-${index}`, `row-${index}`, null));
    const work = allocateFixtureWork({ contributions: readings, evidence: [] });
    let caption: string | null = null;
    const screen = await renderScreen(<WidgetFrameBodyCaptionContext.Provider value={next => { caption = next ?? caption; }}>
      <UsageSessionValueWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'tokens' })}
        slice={withFixtureWorkAccounting({ ...slice, work })} id="usage_session_value" testID="value" />
    </WidgetFrameBodyCaptionContext.Provider>);
    // The app language (English here) groups the count; the copy owner still decides the plural from the integer (J-B56).
    expect(caption).toBe('1,001 sessions');
    expect(screen.getTextContent()).toContain('· 1,001');
    expect(screen.getTextContent()).not.toContain('· 1001');
  });

  it('qualifies hidden Session value rows only after they are shown', async () => {
    const readings = Array.from({ length: 9 }, (_, index) => contribution(`row-${index}`, `row-${index}`, null));
    readings[8] = { ...readings[8]!, tokens: { ...tokens, input: 1, output: 0, reasoning: null, cacheRead: null,
      cacheWrite: null, total: null } };
    const work = allocateFixtureWork({ contributions: readings, evidence: [] });
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={normalizeUsageQuery({ ...query, metric: 'tokens' })}
      slice={withFixtureWorkAccounting({ ...slice, work })} id="usage_session_value" testID="value" />);
    const qualifier = t('usage.board.page.tokensFromPartsSome');
    const collapsed = screen.getTextContent().includes(qualifier);
    await screen.pressByTestIdAsync('value.unlinked.more.toggle');
    expect([collapsed, screen.getTextContent().includes(qualifier)]).toEqual([false, true]);
  });

  it('collapses the ledger summary to one sentence when nothing is linked, instead of repeating the total', async () => {
    const unlinked = allocateFixtureWork({ contributions, evidence: [] });
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: unlinked })} id="usage_project_ledger" testID="ledger" />);
    const summary = screen.findHostByTestId('ledger.conservation')!;
    const text = summary.findAll(node => typeof node.props.children === 'string').map(node => node.props.children as string).join(' ');
    expect(text).toContain(t('usage.board.work.noneLinked'));
    expect(text).not.toContain(t('usage.board.work.notLinked'));
    expect(text).not.toContain(t('usage.board.work.linkedToPrs'));
  });
  it('labels measured token floors once in the ledger while retaining a reported total in the same group', async () => {
    const reported = contribution('reported', 's1', 't1');
    const parts = { ...contribution('parts', 's1', 't1'),
      tokens: { input: 1710, output: 3, reasoning: null, cacheRead: null, cacheWrite: null, total: null } };
    const work = allocateFixtureWork({ contributions: [reported, parts], evidence: [] });
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props}
      query={normalizeUsageQuery({ ...query, metric: 'tokens' })} slice={withFixtureWorkAccounting({ ...slice, work })}
      id="usage_project_ledger" testID="parts-ledger" />);
    const rows = screen.findAllByType(HappierDataRows).find(node => node.props.testID === 'parts-ledger.projects')!;
    expect(rows.props.rows[0][1]).toBe(1727);
    // Every row is a floor, so the total says it once and the row does not repeat it (USAGE-ACCEPT 1118 #11).
    expect(rows.props.rows[0][2]).not.toContain(t('usage.board.page.tokensFromParts'));
    expect(screen.getTextContent().split(t('usage.board.page.tokensFromParts')).length - 1).toBe(1);
  });
  it('bounds the project ledger behind Show all and says the PR qualifier once for the band, not on every row', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ ...contribution(`m${index}`, `ms${index}`, null), projectKey: `project-${index}` }));
    const unlinked = allocateFixtureWork({ contributions: many, evidence: [] });
    const accounting = { ...slice.accounting!, breakdowns: { project: many.map(row => ({ key: row.projectKey,
      label: `Project ${row.projectKey}`, eventCount: 1, tokens: row.tokens, cost: row.cost })) } };
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: unlinked, accounting })} id="usage_project_ledger" testID="ledger" />);
    // A long list leads with its largest rows; the rest are one press away, never a wall.
    expect(screen.findByTestId('ledger.project.project-11')).toBeNull();
    expect(screen.findByTestId('ledger.projects.more')).toBeTruthy();
    const text = screen.getTextContent();
    // Nothing is linked anywhere, so no row repeats "0 linked PRs" or its unlinked amount.
    expect(text).not.toContain(t('usage.board.work.ledgerRowLine', { sessions: 1, prs: 0 }));
    expect(text).not.toContain(t('usage.board.work.notLinkedPart', { amount: '' }).trim());
    expect(text).toContain(t('usage.board.work.noneLinked'));
    await screen.pressByTestIdAsync('ledger.projects.more.toggle');
    expect(screen.findByTestId('ledger.project.project-11')).toBeTruthy();
  });
  it('shows a standalone exact branch and a separate bound Provider mark without inventing one from the Agent', async () => {
    const bound = { ...contribution('branch', 's1', 't1'), providerId: 'provider.openrouter', providerConnectionId: 'connection' };
    const branch = { ref: 'refs/heads/standalone', headSha: 'c'.repeat(40) };
    const branchWork = allocateFixtureWork({ contributions: [bound, contribution('native', 's2', 't2')], evidence: [],
      branchEvidence: [{ sessionId: 's1', turnId: 't1', repositoryKey: 'opaque-repo', checkpointRef: 'checkpoint/s1/t1',
        checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', branch }] });
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: branchWork })} id="usage_project_ledger" testID="ledger" />);
    expect(screen.findByTestId('ledger.branches')).toBeTruthy();
    expect(screen.getTextContent()).toContain('standalone');
    expect(screen.getTextContent()).toContain(branch.headSha.slice(0, 7));
    expect(screen.findByTestId('ledger.provider.provider.openrouter')).toBeTruthy();
    expect(screen.findAllByTestId('ledger.provider.claude')).toHaveLength(0);
    // The Session without a binding never borrows the Agent's name, and an unknown provider is not
    // information: no "Provider: Not recorded" line (quiet truth).
    expect(screen.getTextContent()).not.toContain('Not recorded');
  });
  it('holds How you work bodies in their reading state while that read is pending, never "aren\'t readable here"', async () => {
    const pending = { ...slice, howYouWork: undefined, sources: [...slice.sources.filter(source => source.source !== 'how_you_work'),
      { source: 'how_you_work', status: 'pending' as const }] };
    for (const [Widget, id] of [[UsageHumanLoopWidget, 'usage_human_loop'], [UsageParallelWidget, 'usage_parallel']] as const) {
      const screen = await renderScreen(<Widget {...props} slice={pending} id={id} testID="hyw" />);
      expect(screen.findByTestId('hyw.loading')).toBeTruthy();
      expect(screen.findByTestId('hyw.empty')).toBeFalsy();
    }
  });
  it('leads "What they waited for" with the longest waits and keeps the long tail behind Show all', async () => {
    const base = resolveUsageHowYouWork({ period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0, detail: { status: 'available', facts: [] } });
    const byTool = Array.from({ length: 12 }, (_, index) => ({ toolId: `tool${index}`, requestCount: 1, pairedDecisionCount: 1, decisionLatencyMs: (12 - index) * 60_000 }));
    const howYouWork = { ...base, permissions: { requestCount: 12, pairedDecisionCount: 12, decisionLatencyMs: 78 * 60_000 + 125, unknownRequestTimeCount: 0,
      unknownDecisionTimeCount: 0, byAnsweringClient: { ios: 0, android: 0, web: 0, desktop: 0, unknown: 0 }, byTool } };
    const screen = await renderScreen(<UsageHumanLoopWidget {...props} slice={{ ...slice, howYouWork }} id="usage_human_loop" testID="loop" />);
    expect(screen.getTextContent()).toContain('tool0');
    expect(screen.getTextContent()).not.toContain('tool11');
    await screen.pressByTestIdAsync('loop.tools.more.toggle');
    expect(screen.getTextContent()).toContain('tool11');
    expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'loop.waited.detail')?.props.datum.value).toBe('1 h 18 min 0.125 s');
    await screen.update(<UsageHumanLoopWidget {...props} slice={{ ...slice, howYouWork: { ...howYouWork,
      permissions: { ...howYouWork.permissions, decisionLatencyMs: 78 * 60_000 } } }} id="usage_human_loop" testID="loop" />);
    expect(screen.findAllByType(ChartDatum).some(node => node.props.testID === 'loop.waited.detail')).toBe(false);
  });
  it.each(['tokens', 'cost'] as const)('shows the accounting Session amount without inventing cumulative-only turns (%s)', async (metric) => {
    const sessionQuery = normalizeUsageQuery({ ...query, metric, session: 's1', costBasis: 'auto' });
    // r178: the Session receives an API-equivalent total, but Pi supplies no turn_delta.
    const paid = { input: 3305, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3309 };
    const cumulative = { ...contribution('cumulative', 's1', null), agentId: 'pi', modelId: 'openai/gpt-4.1-mini',
      source: 'pi-session-stats', tokens: paid,
      cost: { reportedUsd: null, estimatedUsd: null, currency: 'USD', apiEquivalentUsd: 0.0013284, pricingSource: 'catalog' } };
    const cumulativeSlice: UsageQueryResultSlice = withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery,
      accounting: { v: 1, totals: { eventCount: 1, tokens: paid,
        cost: cumulative.cost },
        costPresentation: { mode: 'auto', effectiveUsd: 0.0013284, currency: 'USD', source: 'catalog' } },
      work: allocateFixtureWork({ contributions: [cumulative], evidence: [] }) });
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery} slice={cumulativeSlice}
      id="usage_session_value" testID="value" />);
    const metrics = screen.findAllByType(HappierDataMetric);
    const totalLabel = metric === 'cost' ? usagePeriodPhrase(sessionQuery) : t('usage.cost');
    const total = metrics.find(node => node.props.label === totalLabel);
    expect(total?.props.value).toBe(0.0013284);
    expect(total?.props.valueFormatter(total.props.value)).toContain('$0.0013');
    if (metric === 'tokens') expect(metrics.find(node => node.props.label === usagePeriodPhrase(sessionQuery))?.props.value).toBe(3309);
    expect(metrics.find(node => node.props.label === t('usage.board.work.turns'))?.props.value)
      .toBe(t('usage.board.howYouWork.notRecorded'));
    await screen.update(<UsageSessionValueWidget {...props} query={sessionQuery} slice={{ ...cumulativeSlice, work: undefined }}
      id="usage_session_value" testID="value" />);
    expect(screen.findAllByType(HappierDataMetric).find(node => node.props.label === totalLabel)?.props.value).toBe(0.0013284);
  });
  it('opens a selected Session autopsy with exact contribution, checkpoint and witnessed wait phases', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
    const howYouWork = resolveUsageHowYouWork({ period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0,
      detail: { status: 'partial', phaseEvents: [{ evidenceId: 'native-compaction', sessionId: 's1', turnId: 't1',
        observedAtMs: 400, kind: 'compaction', method: 'native_event' }], facts: [
        { workId: JSON.stringify(['s1', 't1']), evidenceId: 't1', agentId: 'claude', machineId: 'machine', kind: 'busy', startMs: 10, endMs: 800 },
        { workId: JSON.stringify(['s1', 't1']), evidenceId: 'approval', agentId: 'claude', machineId: 'machine', kind: 'permission_wait', startMs: 200, endMs: 300 },
        { workId: JSON.stringify(['s1', 't2']), evidenceId: 't2', agentId: 'claude', machineId: 'machine', kind: 'busy', startMs: 900, endMs: null },
      ] } });
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery} slice={{ ...slice, shownQuery: sessionQuery, howYouWork }} id="usage_session_value" testID="value" />);
    expect(screen.findByTestId('value.autopsy')).toBeTruthy();
    const text = screen.getTextContent();
    expect(text).toContain('checkpoint/s1/t1');
    expect(text).toContain('bbbbbbb');
    // Turns are named by their witnessed order and waits by what they waited for, never by a raw id.
    expect(text).toContain('Turn 1');
    // The row for usage with no turn opens like every other row title (acceptance 1122 Session page).
    expect(text).toContain(`${t('usage.board.work.reason_missing_turn').charAt(0).toLocaleUpperCase()}${t('usage.board.work.reason_missing_turn').slice(1)}`);
    expect(text.toLowerCase()).toContain('waiting for your approval');
    expect(text).not.toContain('["s1","t1"]');
    expect(text).not.toContain('b'.repeat(40));
    expect(screen.findByTestId('value.autopsy.summary')).toBeTruthy();
    expect(screen.findByTestId('value.autopsy.turns')).toBeTruthy();
    // One fact, one answer: the Turns figure counts the recorded turn the list shows, and says once that some usage
    // has none, never "Not recorded" above a "Turn 1" row (acceptance 11-21 #15).
    const turnsFact = screen.findAllByType(HappierDataMetric).find(node => node.props.label === t('usage.board.work.turns'));
    expect(turnsFact?.props.value).toBe(1);
    expect(turnsFact?.props.caption).toBe(t('usage.board.work.turnsUnrecordedPart'));
    // With one recorded turn the largest turn is the Session itself: it is not said twice.
    expect(screen.findAllByType(HappierDataMetric).find(node => node.props.label === t('usage.board.work.largestTurn'))).toBeUndefined();
    // Both priced moments share one instant: there is no line to draw, so the section is one quiet line, not an empty plot.
    expect(screen.findByTestId('value.autopsy.costTimeline')).toBeNull();
    expect(screen.findByTestId('value.autopsy.costTimeline.single')).toBeTruthy();
    expect(screen.findByTestId('value.autopsy.phases-select-checkpoint:' + 'a'.repeat(40))).toBeNull();
    expect(screen.findByTestId('value.autopsy.phases-select-commit:' + 'b'.repeat(40))).toBeNull();
    expect(text).toContain('Compaction');
    expect(screen.findByTestId('value.autopsy.unknownEnds')).toBeTruthy();
  });
  it.each(['view', 'owner'] as const)('labels a Session page\'s figures as the viewer\'s own for %s access, and draws no empty dashboard line for a recipient (r226 #62)', async level => {
    const { createSessionFixture, createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const previous = storage.getState();
    storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: 'home', access: createSessionAccessFixture(level) })]);
    try {
      const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
      // The viewer's own ledger in this Session has no Work: zero is the answer, not "nothing in this period".
      const none = allocateFixtureWork({ contributions: [], evidence: [] });
      const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
        slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery, work: none })} id="usage_session_value" testID="value" />);
      const text = screen.getTextContent();
      expect.soft(text.includes(t('usage.board.page.sessionRecipientFigure'))).toBe(level === 'view');
      expect.soft(text.includes(t('usage.board.page.thisSession'))).toBe(level === 'owner');
      // Outside a Session's own page (a Session-pinned widget on the Account Work view), only the recipient's zero
      // drops the empty line (J-B58).
      expect.soft(text.includes(t('usage.board.work.emptyReason'))).toBe(level === 'owner');
      await screen.unmount();
      // On the Session's own page the empty line never shows, for its owner either (r230 #83).
      const hosted = await renderScreen(<UsageSessionPageHost value="s1"><UsageSessionValueWidget {...props} query={sessionQuery}
        slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery, work: none })} id="usage_session_value" testID="value" /></UsageSessionPageHost>);
      expect.soft(hosted.getTextContent().includes(t('usage.board.work.emptyReason'))).toBe(false);
      await hosted.unmount();
    } finally { storage.setState(previous, true); }
  });
  it('says only the PR is missing for a turn whose commit is linked, and keeps the broad absence for a turn with no git evidence', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
    const branch = { ref: 'refs/heads/master', headSha: 'b'.repeat(40) };
    const linked = allocateFixtureWork({
      contributions: [contribution('with-commit', 's1', 't1'), contribution('bare', 's1', 't2'), contribution('with-pr', 's1', 't3')],
      evidence: [{ ...evidence('s1', 't3', 2493), commitSha: 'c'.repeat(40) }],
      branchEvidence: [{ sessionId: 's1', turnId: 't1', repositoryKey: 'opaque-repo', checkpointRef: 'checkpoint/s1/t1',
        checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', branch }] });
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery, work: linked })} id="usage_session_value" testID="value" />);
    const text = screen.getTextContent();
    expect(text).toContain('bbbbbbb');
    expect(text).toContain(t('usage.board.work.reason_missing_pr'));
    expect(text).toContain(t('usage.board.work.reason_missing_evidence'));
    // The turn's one caption line leads with the PR state and what was linked, and ends with the long checkpoint ref.
    const linkedRow = screen.findAllByType(HappierDataRows).find(rows => rows.props.testID === 'value.autopsy.turns')!.props.rows.find((row: readonly unknown[]) => String(row[3]).includes('bbbbbbb'));
    expect(linkedRow[2]).toBe(t('usage.board.work.reason_missing_pr'));
    expect(String(linkedRow[linkedRow.length - 1])).toContain('checkpoint/s1/t1');
  });
  it('leads a long Session\'s turns and folds the rest behind Show all · N (R135 item 3)', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
    const many = allocateFixtureWork({
      contributions: Array.from({ length: 12 }, (_, index) => contribution(`turn-${index}`, 's1', `t${index}`)), evidence: [] });
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery, work: many })} id="usage_session_value" testID="value" />);
    const turns = () => screen.findAllByType(HappierDataRows).find(rows => rows.props.testID === 'value.autopsy.turns')!.props.rows;
    expect(turns()).toHaveLength(6);
    await screen.pressByTestIdAsync('value.autopsy.turns.more.toggle');
    expect(turns()).toHaveLength(12);
  });
  it('leads a long Session\'s witnessed phases in time order and folds the rest behind Show all · N (sweep 1110 item 16)', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
    const howYouWork = resolveUsageHowYouWork({ period: { startMs: 0, endMs: 100_000 }, timeZoneOffsetMinutes: 0,
      detail: { status: 'partial', phaseEvents: [], facts: Array.from({ length: 12 }, (_, index) => (
        { workId: JSON.stringify(['s1', `t${index}`]), evidenceId: `t${index}`, agentId: 'claude', machineId: 'machine', kind: 'busy' as const,
          startMs: index * 1000, endMs: index * 1000 + 500 })) } });
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={{ ...slice, shownQuery: sessionQuery, howYouWork }} id="usage_session_value" testID="value" />);
    const phases = () => screen.findAllByType(IntervalTimeline).find(node => node.props.testID === 'value.autopsy.phases')!.props.intervals;
    expect(phases()).toHaveLength(6);
    expect(phases().map((interval: { start: number }) => interval.start)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    await screen.pressByTestIdAsync('value.autopsy.phases.more.toggle');
    expect(phases().length).toBeGreaterThanOrEqual(12);
  });
  it('retains exact Autopsy summary and mixed-basis turn amounts behind their compact values', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1', costBasis: 'auto' });
    const reported = { ...contribution('eur-exact', 's1', 't1'),
      cost: { reportedUsd: 1.23456, estimatedUsd: 0, currency: 'EUR' } };
    const estimated = { ...contribution('usd-exact', 's1', 't2'),
      cost: { reportedUsd: 0, estimatedUsd: 4.56789, currency: 'USD', costSource: 'pricing_estimate' as const } };
    const body = (rows: UsageWorkContribution[]) => <UsageSessionValueWidget {...props} query={sessionQuery}
      slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery,
        accounting: { ...slice.accounting!, contributions: rows },
        work: allocateFixtureWork({ contributions: rows, evidence: [] }) })}
      id="usage_session_value" testID="value" />;
    const screen = await renderScreen(body([reported]));
    const summary = screen.findAllByType(ChartDatum).find(node => node.props.datum.label === usagePeriodPhrase(sessionQuery));
    expect.soft(summary?.props.datum).toMatchObject({ value: expect.stringMatching(/^1\.23456 \(€1\.23\)$/), subtitle: expect.stringContaining('€1.23') });
    expect(screen.getTextContent()).toContain('€1.23');
    await screen.update(body([reported, estimated]));
    const turnDatums = screen.findAllByType(ChartDatum)
      .filter(node => String(node.props.testID).startsWith('value.autopsy.turns-datum-')).map(node => node.props.datum);
    expect.soft(turnDatums).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'EUR 1.23456', subtitle: expect.stringContaining('reported') }),
      expect.objectContaining({ value: 'USD 4.56789', subtitle: expect.stringContaining('estimated') }),
    ]));
    expect(screen.getTextContent()).toContain('$4.57');
  });
  it.each([
    { basis: 'api_equivalent', cost: (usd: number) => ({ reportedUsd: 0, estimatedUsd: 0, apiEquivalentUsd: usd, currency: 'USD' }) },
    { basis: 'reported', cost: (usd: number) => ({ reportedUsd: usd, estimatedUsd: 0, currency: 'USD' }) },
  ] as const)('says the $basis basis once, as the Session value caption, and leaves every shared-basis amount bare (acceptance r224 #47)', async ({ basis, cost }) => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1', costBasis: basis });
    const rows = [5, 3, 1].map((usd, index) => ({ ...contribution(`turn-${index}`, 's1', `t${index}`),
      observedAtMs: index + 1, cost: cost(usd / 1000) }));
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery,
        accounting: { ...slice.accounting!, totals: { ...slice.accounting!.totals, eventCount: 3, cost: cost(0.009) }, contributions: rows },
        work: allocateFixtureWork({ contributions: rows, evidence: [] }) })}
      id="usage_session_value" testID="value" />);
    const phrase = usageCostKindPhrase(basis);
    const text = screen.getTextContent();
    expect(text.split(phrase)).toHaveLength(2);
    const hero = screen.findAllByType(HappierDataMetric).find(node => node.props.label === usagePeriodPhrase(sessionQuery));
    expect(hero?.props.caption).toContain(phrase);
    const largest = screen.findAllByType(HappierDataMetric).find(node => node.props.label === t('usage.board.work.largestTurn'));
    expect(largest?.props.valueFormatter(largest.props.value)).toMatch(/^\$0\.005\d*$/);
    // A reported cost is never called API-equivalent.
    if (basis === 'reported') expect(text).not.toContain(usageCostKindPhrase('api_equivalent'));
  });
  it.each([
    { kind: 'mixed recorded turns', fromParts: [false, true], secondTurn: 't2', exactDerived: 1 },
    { kind: 'all reported', fromParts: [false, false], secondTurn: 't2', exactDerived: null },
    { kind: 'all derived', fromParts: [true, true], secondTurn: 't2', exactDerived: null },
    { kind: 'reported turn and derived no-turn subtotal', fromParts: [false, true], secondTurn: null, exactDerived: 1 },
    { kind: 'derived turn and reported no-turn subtotal', fromParts: [true, false], secondTurn: null, exactDerived: 0 },
  ])('keeps precise turn provenance in the exact detail for $kind', async ({ fromParts, secondTurn, exactDerived }) => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1', metric: 'tokens' });
    const rows = [10, 7].map((amount, index) => ({
      ...contribution(`turn-${index}`, 's1', index === 0 ? 't1' : secondTurn),
      tokens: { input: amount - 1, output: 1, reasoning: null, cacheRead: null, cacheWrite: null,
        total: fromParts[index] ? null : amount },
    }));
    const work = allocateFixtureWork({ contributions: rows, evidence: [] });
    const total: UsageAnalyticsTokens = fromParts.some(Boolean)
      ? { input: 15, output: 2, reasoning: null, cacheRead: null, cacheWrite: null, total: null, measured: { total: 17, fromParts: true } }
      : { input: 15, output: 2, reasoning: null, cacheRead: null, cacheWrite: null, total: 17 };
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery, work,
        accounting: { ...slice.accounting!, totals: { ...slice.accounting!.totals, eventCount: 2, tokens: total }, contributions: rows } })}
      id="usage_session_value" testID="value" />);
    const qualifier = t('usage.board.page.tokensFromParts');
    const hero = screen.findAllByType(HappierDataMetric).find(node => node.props.label === usagePeriodPhrase(sessionQuery));
    expect(hero?.props.value).toBe(17);
    expect(Boolean(hero?.props.caption.includes(qualifier))).toBe(fromParts.some(Boolean));
    const table = screen.findAllByType(HappierDataRows).find(node => node.props.testID === 'value.autopsy.turns')!;
    const noTurn = t('usage.board.work.reason_missing_turn');
    const labels = [t('usage.board.work.turnNumber', { number: 1 }),
      secondTurn === null ? noTurn.charAt(0).toLocaleUpperCase() + noTurn.slice(1) : t('usage.board.work.turnNumber', { number: 2 })];
    expect(table.props.rows.map((row: readonly unknown[]) => row.slice(0, 2))).toEqual([[labels[0], 10], [labels[1], 7]]);
    expect(JSON.stringify(table.props.rows)).not.toContain(qualifier);
    const datums = screen.findAllByType(ChartDatum)
      .filter(node => String(node.props.testID).startsWith('value.autopsy.turns-datum-')).map(node => node.props.datum);
    const qualified = datums.filter(datum => datum.subtitle?.includes(qualifier));
    if (exactDerived !== null) {
      expect(qualified).toEqual([expect.objectContaining({
        label: labels[exactDerived],
        value: `${[10, 7][exactDerived]} ${t('usage.board.page.tokensUnit')}`,
        accessibilityLabel: expect.stringContaining(qualifier),
      })]);
    } else expect(qualified).toEqual([]);
  });
  it('qualifies derived turn details only when the reported group is shown alongside them', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1', metric: 'tokens' });
    const rows = Array.from({ length: 9 }, (_, index) => ({
      ...contribution(`turn-${index}`, 's1', `t${index}`),
      observedAtMs: index + 1,
      tokens: {
        input: index === 8 ? 1 : 9, output: 1, reasoning: null, cacheRead: null, cacheWrite: null,
        total: index === 8 ? 2 : null,
      },
    }));
    const work = allocateFixtureWork({ contributions: rows, evidence: [] });
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery, work,
        accounting: { ...slice.accounting!, contributions: rows } })}
      id="usage_session_value" testID="value" />);
    const qualified = () => screen.findAllByType(ChartDatum).filter(node =>
      String(node.props.testID).startsWith('value.autopsy.turns-datum-')
      && node.props.datum.subtitle?.includes(t('usage.board.page.tokensFromParts')));
    expect(qualified()).toHaveLength(0);
    await screen.pressByTestIdAsync('value.autopsy.turns.more.toggle');
    expect(qualified()).toHaveLength(8);
    expect(qualified().every(node => node.props.datum.label !== t('usage.board.work.turnNumber', { number: 9 }))).toBe(true);
  });
  it('formats witnessed Autopsy git moments in the preferred language without changing their instants', async () => {
    const previous = getPreferredLanguage();
    const committedAtMs = 500;
    const checkpointCommittedAtMs = 300;
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
    const timedWork = allocateFixtureWork({ contributions,
      evidence: [{ ...evidence('s1', 't1', 2493), committedAtMs, checkpointCommittedAtMs }] });
    try {
      setPreferredLanguageFromSettings('fr');
      await preloadTranslations();
      const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
        slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery, work: timedWork })} id="usage_session_value" testID="value" />);
      const formatted = new Intl.DateTimeFormat('fr', { dateStyle: 'medium', timeStyle: 'short' }).format(committedAtMs);
      expect(screen.getTextContent()).toContain(formatted);
      expect(screen.findByType(IntervalTimeline).props.intervals).toContainEqual(expect.objectContaining({
        id: `commit:${'b'.repeat(40)}`, start: committedAtMs, end: committedAtMs, annotation: expect.stringContaining(formatted),
      }));
      expect(screen.findByType(IntervalTimeline).props.intervals).toContainEqual(expect.objectContaining({
        id: `checkpoint:${'a'.repeat(40)}`, start: checkpointCommittedAtMs, end: checkpointCommittedAtMs,
      }));
    } finally {
      setPreferredLanguageFromSettings(previous);
      await preloadTranslations();
    }
  });
  it('names the admitted historical model and machine through the existing catalog and display reader', async () => {
    const previous = storage.getState().machineDisplayById;
    const machine = createMachineFixture({ id: 'machine' });
    storage.setState({ machineDisplayById: { ...previous, machine: { ...machine,
      metadata: { ...machine.metadata!, displayName: 'Evidence workstation' } } } });
    try {
      const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
      const namedWork = allocateFixtureWork({ contributions: [{ ...contribution('named', 's1', 't1'), modelId: 'claude-opus-4-5' }], evidence: [] });
      const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
        slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery, work: namedWork })} id="usage_session_value" testID="value" />);
      expect(screen.getTextContent()).toContain('Opus 4.5');
      expect(screen.getTextContent()).toContain('Evidence workstation');
      const unknownWork = allocateFixtureWork({ contributions: [{ ...contribution('unlisted', 's1', 't1'),
        modelId: 'third-party/model-snapshot', machineId: 'unknown-machine-uuid' }], evidence: [] });
      await screen.update(<UsageSessionValueWidget {...props} query={sessionQuery}
        slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery, work: unknownWork })} id="usage_session_value" testID="value" />);
      expect(screen.getTextContent()).toContain('third-party/model-snapshot');
      expect(screen.getTextContent()).not.toContain('Third Party Model Snapshot');
      expect(screen.getTextContent()).not.toContain('unknown-machine-uuid');
    } finally { await act(async () => { storage.setState({ machineDisplayById: previous }); }); }
  });
  it('shows independently known Work currencies and kinds without using the mixed whole as their formatter', async () => {
    const rows = [{ ...contribution('eur', 'eur-session', 'eur-turn'), projectKey: 'eur-project',
      cost: { reportedUsd: 3, estimatedUsd: 4, currency: 'EUR' } },
    { ...contribution('usd', 'usd-session', 'usd-turn'), projectKey: 'usd-project',
      cost: { reportedUsd: 0, estimatedUsd: 4, currency: 'USD', costSource: 'pricing_estimate' as const } }];
    const mixedQuery = normalizeUsageQuery({ ...query, costBasis: 'auto' });
    const mixedSlice: UsageQueryResultSlice = withFixtureWorkAccounting({ ...slice, shownQuery: mixedQuery,
      work: allocateFixtureWork({ contributions: rows, evidence: [evidence('eur-session', 'eur-turn', 1),
        evidence('usd-session', 'usd-turn', 2)] }),
      accounting: { ...slice.accounting!, totals: { ...slice.accounting!.totals,
        cost: { reportedUsd: 3, estimatedUsd: 4, currency: 'MIXED' } },
        breakdowns: { project: rows.map(row => ({ key: row.projectKey, label: row.projectKey === 'eur-project' ? 'Europe' : 'America',
          eventCount: 1, tokens: row.tokens, cost: row.cost })) } } });
    for (const [Widget, id] of [[UsageProjectLedgerWidget, 'usage_project_ledger'], [UsageSessionValueWidget, 'usage_session_value'], [UsageOutcomesWidget, 'usage_outcomes']] as const) {
      const screen = await renderScreen(<Widget {...props} query={mixedQuery} slice={mixedSlice} id={id} testID="work" />);
      const text = screen.getTextContent();
      expect(text).toContain('€3.00');
      expect(text).toContain('$4.00');
      expect(text).toContain('reported');
      expect(text).toContain('estimated');
      expect(text).not.toContain('$3.00');
    }
  });
  it('expands a project row in place into every Session, linked PR and branch, and opens a Session\'s autopsy from there', async () => {
    const navigation = vi.spyOn(router, 'push');
    try {
      const rows = Array.from({ length: 7 }, (_, index) => contribution(`c${index}`, `s${index}`, `t${index}`));
      const branch = { ref: 'refs/heads/glass', headSha: 'c'.repeat(40) };
      const complete = allocateFixtureWork({ contributions: rows,
        evidence: [evidence('s0', 't0', 2493)],
        branchEvidence: [{ sessionId: 's1', turnId: 't1', repositoryKey: 'repo', checkpointRef: 'checkpoint/s1/t1',
          checkpointCommitSha: 'a'.repeat(40), commitSha: 'd'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', branch }] });
      const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 1, width: 'half', height: 'compact' }, geometry: { width: 320, height: 96 } }}>
        <UsageProjectLedgerWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: complete })} id="usage_project_ledger" testID="ledger" />
      </WidgetPresentationProvider>);
      expect(screen.findByTestId('ledger.project.p1.detail')).toBeFalsy();
      await screen.pressByTestIdAsync('ledger.project.p1.toggle');
      expect(screen.findByTestId('ledger.project.p1.detail')).toBeTruthy();
      for (let index = 0; index < 7; index += 1) expect(screen.findByTestId(`ledger.project.p1.session.open.s${index}`)).toBeTruthy();
      expect(screen.findByTestId('ledger.project.p1.prs')).toBeTruthy();
      expect(screen.findByTestId('ledger.project.p1.branches')).toBeTruthy();
      expect(screen.getTextContent()).toContain('2493');
      expect(screen.getTextContent()).toContain('glass');
      await screen.pressByTestIdAsync('ledger.project.p1.session.open.s6');
      expect(new URL(String(navigation.mock.calls.at(-1)?.[0]), 'https://usage.test').pathname).toBe('/session/s6/usage');
      // Outside the Usage page there is no filter row: narrowing opens Usage on this project.
      await screen.pressByTestIdAsync('ledger.project.p1.filter');
      const narrowed = navigation.mock.calls.at(-1)?.[0];
      if (!narrowed || typeof narrowed !== 'object' || !('params' in narrowed) || !narrowed.params
        || !('scope' in narrowed.params) || typeof narrowed.params.scope !== 'string') throw new Error('Expected a scoped Usage route');
      expect(JSON.parse(narrowed.params.scope)).toMatchObject({ projects: ['p1'] });
      await screen.pressByTestIdAsync('ledger.project.p1.toggle');
      expect(screen.findByTestId('ledger.project.p1.detail')).toBeFalsy();
    } finally { navigation.mockRestore(); }
  });
  it('expands a branch into its commit evidence and Sessions, and a PR into the Sessions that paid for it', async () => {
    const navigation = vi.spyOn(router, 'push');
    try {
      const branch = { ref: 'refs/heads/glass', headSha: 'c'.repeat(40) };
      const branchWork = allocateFixtureWork({ contributions,
        evidence: [evidence('s1', 't1', 2493)],
        branchEvidence: [{ sessionId: 's2', turnId: 't2', repositoryKey: 'repo', checkpointRef: 'checkpoint/s2/t2',
          checkpointCommitSha: 'a'.repeat(40), commitSha: 'd'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', branch }] });
      const screen = await renderScreen(<>
        <UsageProjectLedgerWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: branchWork })} id="usage_project_ledger" testID="ledger" />
        <UsageOutcomesWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: branchWork })} id="usage_outcomes" testID="outcomes" />
      </>);
      const branchKey = branchWork.branches[0]!.key;
      expect(screen.findByTestId(`ledger.branch.${branchKey}.session.open.s2`)).toBeFalsy();
      await screen.pressByTestIdAsync(`ledger.branch.${branchKey}.toggle`);
      expect(screen.getTextContent()).toContain('ddddddd');
      await screen.pressByTestIdAsync(`ledger.branch.${branchKey}.session.open.s2`);
      expect(new URL(String(navigation.mock.calls.at(-1)?.[0]), 'https://usage.test').pathname).toBe('/session/s2/usage');
      const prKey = branchWork.outcomes[0]!.key;
      expect(screen.findByTestId(`outcomes.pr.${prKey}.session.open.s1`)).toBeFalsy();
      await screen.pressByTestIdAsync(`outcomes.pr.${prKey}.toggle`);
      await screen.pressByTestIdAsync(`outcomes.pr.${prKey}.session.open.s1`);
      expect(new URL(String(navigation.mock.calls.at(-1)?.[0]), 'https://usage.test').pathname).toBe('/session/s1/usage');
    } finally { navigation.mockRestore(); }
  });
  it('keeps the fourth Session and seventh PR reachable at compact phone size', async () => {
    const navigation = vi.spyOn(router, 'push');
    try {
    const rows = Array.from({ length: 7 }, (_, index) => contribution(`c${index}`, `s${index}`, `t${index}`));
    const complete = allocateFixtureWork({ contributions: rows, evidence: rows.map((row, index) => evidence(row.sessionId!, row.turnId!, 100 + index)) });
    const compactSlice = withFixtureWorkAccounting({ ...slice, work: complete });
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 1, width: 'half', height: 'compact' }, geometry: { width: 320, height: 96 } }}>
      <UsageSessionValueWidget {...props} slice={compactSlice} id="usage_session_value" testID="value" />
      <UsageOutcomesWidget {...props} slice={compactSlice} id="usage_outcomes" testID="outcomes" />
    </WidgetPresentationProvider>);
    expect(screen.findByTestId('value.open.s3')).toBeTruthy();
    expect(screen.findByTestId('outcomes.prs')).toBeTruthy();
    expect(screen.getTextContent()).toContain('106');
      await screen.pressByTestIdAsync('value.open.s3');
      const destination = navigation.mock.calls.at(-1)?.[0];
      expect(typeof destination).toBe('string');
      const route = new URL(String(destination), 'https://usage.test');
      expect(route.pathname).toBe('/session/s3/usage');
      expect(route.searchParams.get('serverId')).toBe('home');
      expect(resolveUsagePageInitialFilters(Object.fromEntries(route.searchParams))).toMatchObject({ costMode: 'reported' });
      expect(route.searchParams.has('scope')).toBe(false);
      expect(route.searchParams.has('queryOverrides')).toBe(false);
    } finally { navigation.mockRestore(); }
  });

  it('shows missing Work money as unknown and preserves witnessed zero', async () => {
    const rows = [
      { ...contribution('unknown', 'unpriced', 't1'), cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const } },
      { ...contribution('free', 'free', 't2'), cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const } },
    ];
    const unpriced = allocateFixtureWork({ contributions: rows, evidence: [] });
    const screen = await renderScreen(<UsageSessionValueWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: unpriced })} id="usage_session_value" testID="value" />);
    const unpricedRow = screen.findByTestId('value.open.unpriced');
    const freeRow = screen.findByTestId('value.open.free');
    expect(unpricedRow).toBeTruthy();
    expect(screen.getTextContent()).toContain(t('usage.board.recap.money_unpriced'));
    expect(screen.getTextContent()).toContain('$0.00');
    expect(freeRow).toBeTruthy();
  });
  it('keeps an unpriced Session cost a quiet dash and draws no empty cost-over-time plot (USAGE-ACCEPT 1118 #17)', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, metric: 'tokens', session: 'unpriced', costBasis: 'auto' });
    const unknownCost = { reportedUsd: null, estimatedUsd: null, currency: 'USD', costSource: 'none' as const };
    const rows = [
      { ...contribution('unknown', 'unpriced', 't1'), cost: unknownCost },
      { ...contribution('unknown-2', 'unpriced', 't2'), cost: unknownCost },
    ];
    // The Session's hero comes from its accounting projection; the same unpriced rows feed accounting and Work.
    const sessionSlice = (cost: NonNullable<UsageQueryResultSlice['accounting']>['totals']['cost'],
      contributions: readonly ReturnType<typeof contribution>[]): UsageQueryResultSlice => (withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery,
      accounting: { v: 1, totals: { eventCount: contributions.length, tokens: { ...tokens, total: 84 }, cost }, contributions: [...contributions] },
      work: allocateFixtureWork({ contributions: [...contributions], evidence: [] }) }));
    const costFact = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType(HappierDataMetric)
      .find(node => node.props.label === t('usage.cost'));
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery} slice={sessionSlice(unknownCost, rows)}
      id="usage_session_value" testID="value" />);
    expect(costFact(screen)?.props.value).toBe('—');
    expect(String(costFact(screen)?.props.caption ?? '')).not.toBe('');
    expect(screen.findByTestId('value.autopsy.costTimeline')).toBeNull();
    expect(screen.findByTestId('value.autopsy.costTimeline.single')).toBeNull();
    // Contrast: the same Session with a reported price keeps its amount.
    const priced = { reportedUsd: 3, estimatedUsd: 0, currency: 'USD' };
    await screen.update(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={sessionSlice(priced, rows.map(row => ({ ...row, cost: { ...priced, costSource: 'provider_reported' as const } })))}
      id="usage_session_value" testID="value" />);
    expect(typeof costFact(screen)?.props.value).toBe('number');
    // Priced moments at two instants draw the line.
    await screen.update(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={sessionSlice(priced, rows.map((row, index) => ({ ...row, observedAtMs: 1 + index * 60_000,
        cost: { ...priced, costSource: 'provider_reported' as const } })))}
      id="usage_session_value" testID="value" />);
    expect(screen.findByTestId('value.autopsy.costTimeline')).toBeTruthy();
    expect(screen.findByTestId('value.autopsy.costTimeline.single')).toBeNull();
    // A later row that adds no price leaves the running cost flat: one quiet line, not a flat plot (live 11-22).
    await screen.update(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={sessionSlice(priced, rows.map((row, index) => ({ ...row, observedAtMs: 1 + index * 60_000,
        cost: index === 0 ? { ...priced, costSource: 'provider_reported' as const } : unknownCost })))}
      id="usage_session_value" testID="value" />);
    expect(screen.findByTestId('value.autopsy.costTimeline')).toBeNull();
    expect(screen.findByTestId('value.autopsy.costTimeline.single')).toBeTruthy();
  });
  it('does not substitute an earlier quota reset for unused capacity at a later subscription end', async () => {
    const now = Date.UTC(2026, 9, 10, 12);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const recordKey = { providerId: 'codex', accountSubjectId: 'work', subjectKind: 'account' as const, quotaScope: 'account' as const };
      const source = { ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' }, bindingKind: 'account' as const };
      const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'work' }, observedAtMs: now, fetchedAtMs: now,
        staleAfterMs: 3_600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
        subscription: { status: 'subscribed', renewal: 'off', currentPeriodEndAtMs: now + 5_400_000, observedAtMs: now, staleAfterMs: 3_600_000,
          enteredMonthlyPrice: { amount: 20.125, currency: 'USD', enteredAtMs: now } },
        meters: [{ meterId: 'hour', label: 'Hour', used: 20, remaining: 80, limit: 100, unit: 'requests', utilizationPct: 20,
          resetsAt: now + 1_800_000, windowDurationMs: 3_600_000, status: 'ok', details: {} }] });
      const read = () => projectProviderAccountUsageQuotaReadV1({ input: { source }, current: snapshot, nowMs: now });
      const screened = (quota: ReturnType<typeof read>) => <UsagePlanFitWidget {...props} slice={{ ...slice, quota: [quota] }} id="usage_plan_fit" testID="fit" />;
      const screen = await renderScreen(screened(read()), { wrapper: ({ children }) => <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider> });
      expect(screen.getTextContent()).not.toContain('60%');
      expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'fit.plan.work.figure')?.props.datum.value).toContain('20.125');
      snapshot.subscription!.currentPeriodEndAtMs = now + 1_800_000;
      await screen.update(screened(read()));
      expect(screen.getTextContent()).toContain('60%');
    } finally { clock.mockRestore(); }
  });
  it('ledger states the PR-linked amount and the unlinked remainder that add back to the total', async () => {
    const screen = await renderScreen(
      <UsageProjectLedgerWidget
        {...props}
        id="usage_project_ledger"
        testID="ledger"
      />,
    );
    const text = screen.getTextContent();
    expect(screen.findByTestId('ledger.conservation')).toBeTruthy();
    expect(text).toContain('$3.00');
    expect(text).toContain('$6.00');
    expect(text).toContain('$9.00');
  });

  it('session value never draws an unlinked session as zero output', async () => {
    const screen = await renderScreen(
      <WidgetPresentationProvider value={{ size: 'full',
        footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'tall' },
        geometry: { width: 700, height: 500 } }}>
        <UsageSessionValueWidget {...props} id="usage_session_value" testID="value" />
      </WidgetPresentationProvider>,
    );
    expect(screen.findByType(OutcomeScatter).props.points).toMatchObject([
      { id: 's1', x: 6, y: 1 },
    ]);
    const unlinked = screen.findAllByType(RankedRows).find(rows => rows.props.testID === 'value.unlinked');
    expect(unlinked?.props.rows).toMatchObject([{ id: 's2', value: 3 }]);
    expect(screen.findHostByTestId('value.open.s2')).not.toBeNull();
  });

  it('labels the merged count in Session value\'s opened rows, said once aloud (acceptance r227 #71)', async () => {
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'full',
      footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'tall' },
      geometry: { width: 700, height: 500 } }}>
      <UsageSessionValueWidget {...props} id="usage_session_value" testID="value" />
    </WidgetPresentationProvider>);
    await screen.pressByTestIdAsync('value.scatter-values-toggle');
    const row = screen.findHostByTestId('value.scatter-values-row-0');
    const unit = t('usage.board.work.mergedCount', { count: 1 });
    expect(screen.getTextContent()).toContain(unit);
    const spoken = String(row?.props.accessibilityLabel ?? '');
    expect(spoken).toContain(unit);
    expect(spoken).not.toContain(t('usage.board.work.yMerged'));
  });

  it('says the cost basis once, by the caption, and leaves Cost per PR, Session value and scatter amounts bare (acceptance r227 #70)', async () => {
    const phrase = usageCostKindPhrase('reported');
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'full',
      footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'tall' },
      geometry: { width: 700, height: 500 } }}>
      <UsageOutcomesWidget {...props} id="usage_outcomes" testID="outcomes" />
      <UsageSessionValueWidget {...props} id="usage_session_value" testID="value" />
    </WidgetPresentationProvider>);
    const captioned = screen.findAllByType(RankedRows).filter(rows => rows.props.basis);
    expect(captioned.map(rows => rows.props.testID)).toEqual(expect.arrayContaining(['outcomes.prs']));
    for (const rows of captioned) {
      expect.soft(String(rows.props.basis).split(phrase), String(rows.props.testID)).toHaveLength(2);
      expect.soft(rows.props.valueFormatter(3), String(rows.props.testID)).toBe(formatUsageCost(3, 'USD'));
    }
    const scatter = screen.findByType(OutcomeScatter);
    expect(String(scatter.props.basis).split(phrase)).toHaveLength(2);
    expect(scatter.props.formatX(3)).toBe(formatUsageCost(3, 'USD'));
    // The amount's accessible name carries the basis once: the caption's words, not the amount's.
    const spoken = String(screen.findHostByTestId('outcomes.prs-row-0')?.props.accessibilityLabel ?? '');
    expect(spoken).toContain(formatUsageCost(3, 'USD'));
    expect(spoken.split(phrase)).toHaveLength(2);
  });

  it('shows unlinked Sessions once when a wide scatter has no witnessed outcome axis', async () => {
    const unlinked = allocateFixtureWork({ contributions, evidence: [] });
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'full',
      footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'tall' },
      geometry: { width: 700, height: 500 } }}>
      <UsageSessionValueWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: unlinked })} id="usage_session_value" testID="value" />
    </WidgetPresentationProvider>);
    expect(screen.findByTestId('value.scatter')).toBeFalsy();
    expect(screen.findAllHostsByTestId('value.open.s1')).toHaveLength(1);
    expect(screen.findAllHostsByTestId('value.open.s2')).toHaveLength(1);
  });

  it.each(['draft', 'open'] as const)('shows the linked draft outcome for the provider state %s', async (state) => {
    const witness = evidence('s1', 't1', 2493);
    const draftWork = allocateFixtureWork({
      contributions,
      evidence: [{ ...witness, pullRequest: { ...witness.pullRequest!, state, isDraft: true } }],
    });
    const screen = await renderScreen(
      <UsageSessionValueWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: draftWork })} id="usage_session_value" testID="draft-value" />,
    );
    expect(screen.getTextContent()).toContain(`${witness.pullRequest!.title} · ${t('usage.board.work.state_draft')}`);
  });

  it('outcomes shows the exact PR and the session funnel', async () => {
    const screen = await renderScreen(
      <UsageOutcomesWidget {...props} id="usage_outcomes" testID="outcomes" />,
    );
    expect(screen.findByType(OutcomeFunnel).props.steps).toMatchObject([
      { id: 'sessions', value: 2 },
      { id: 'witnessed', value: 1 },
      { id: 'allocated', value: 1 },
      { id: 'merged', value: 1 },
    ]);
    expect(screen.getTextContent()).toContain('2493');
  });

  it('shows witnessed Work and known unread Sessions on all three surfaces before a sibling Machine answers', async () => {
    const workQuery = normalizeUsageQuery({ ...query, metric: 'tokens', includeWorkEvidence: true, workProjection: 'detail' });
    const admitted = [...contributions, contribution('slow', 's3', 't3')];
    const accounting = [{ query: workQuery, status: 'available' as const,
      value: { ...slice.accounting!, contributions: admitted } }];
    const slow = createDeferred<void>();
    const progress = createDeferred<UsageQueryResultSlice>();
    const project = (work: Awaited<ReturnType<typeof collectUsageWorkSources>>, previous?: UsageQueryBatchResult) =>
      resolveUsagePageAggregation({ queries: [workQuery], accounting, work, previous, nowMs: 1000 }, bundledUsageModelPriceCatalog);
    const renderWork = (state: UsageQueryResultSlice) => {
      const body = { ...props, slice: state, query: workQuery };
      return renderScreen(<>
        <UsageProjectLedgerWidget {...body} id="usage_project_ledger" testID="progress-ledger" />
        <UsageOutcomesWidget {...body} id="usage_outcomes" testID="progress-outcomes" />
        <UsageOutcomesWidget {...body} id="usage_outcomes" testID="progress-shipped" presentation={{ style: 'shipped' }} />
      </>);
    };
    const reading = collectUsageWorkSources({
      queries: [workQuery], accounting, assertCurrent: () => {}, now: () => 1000,
      resolveSession: async id => ({ machineId: id, cwd: '/repo' }),
      readMachine: async id => {
        if (id === 's3') await slow.promise;
        return { sessions: [id === 's1'
          ? { sessionId: id, status: 'partial', pullRequestsRead: true, evidence: [evidence('s1', 't1', 2493)] }
          : { sessionId: id, status: 'error', errorCode: 'BACKEND_UNAVAILABLE' }] };
      },
      onProgress: work => {
        const state = project(work).results[0]!;
        if (state.work?.outcomes.length && state.sources.some(source => source.unreadSessions?.failed === 1)) {
          progress.resolve(state);
        }
      },
    });
    try {
      const state = await progress.promise;
      const screen = await renderWork(state);
      const cause = t('usage.board.work.workUnreadOther', { count: 1, formattedCount: '1' });
      const pending = t('usage.board.page.coveragePending', { sources: usageSourceTitle('work') });
      expect.soft(screen.findByTestId('progress-ledger.conservation')?.props.accessibilityLabel).toContain(`${pending} · ${cause}`);
      for (const widget of ['progress-outcomes', 'progress-shipped']) {
        const notice = screen.findAllByType(SurfaceFreshnessLine).find(node => node.props.testID === widget + '.workProgress');
        expect.soft(notice?.props.reason).toContain(`${pending} · ${cause}`);
        expect.soft(notice?.props.busy).toBe(true);
        expect.soft(notice?.props.action).toBeUndefined();
      }
      expect.soft(screen.getTextContent()).toContain('2493');
      expect.soft(screen.findByTestId('progress-shipped.shipped')).toBeTruthy();
      expect(state.workSummary?.mergedPrCount).toBeUndefined();
    } finally {
      slow.resolve();
    }
    const previous = project(await reading);
    const previousSource = previous.results[0]!.sources.find(source => source.source === 'work');
    expect(previousSource).toMatchObject({ status: 'partial', asOfMs: 1000, unreadSessions: { failed: 2 } });
    const unstarted = project([{ query: workQuery, status: 'pending' }], previous).results[0]!;
    expect(unstarted.sources.find(source => source.source === 'work')).toEqual({ source: 'work', status: 'pending', asOfMs: 1000 });
    const screen = await renderWork(unstarted);
    const pending = t('usage.board.page.coveragePending', { sources: usageSourceTitle('work') });
    expect.soft(screen.findByTestId('progress-ledger.conservation')?.props.accessibilityLabel).toContain(pending);
    expect.soft(screen.findByTestId('progress-ledger.conservation')?.props.accessibilityLabel).not.toContain(
      t('usage.board.work.workUnreadOther', { count: 2, formattedCount: '2' }));
    for (const widget of ['progress-outcomes', 'progress-shipped']) {
      const notice = screen.findAllByType(SurfaceFreshnessLine).find(node => node.props.testID === widget + '.workProgress');
      expect.soft(notice?.props.reason).toBe(pending);
      expect.soft(notice?.props.busy).toBe(true);
    }
    expect(screen.getTextContent()).toContain('2493');
  });

  it('explains Work that cannot be attributed when the recorded usage has a Session and no turn', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1', metric: 'cost' });
    const unassigned: UsageWorkContribution = { ...contribution('pi-session-stats', 's1', null),
      source: 'pi-session-stats', eventCount: 1, tokens: { ...tokens, input: 18_210, total: 18_214 },
      cost: { reportedUsd: null, estimatedUsd: null, currency: 'USD' } };
    const result = resolveUsagePageAggregation({
      queries: [sessionQuery],
      accounting: [{ query: sessionQuery, status: 'available', asOfMs: 1000,
        value: { ...slice.accounting!, contributions: [unassigned], breakdowns: {},
          totals: { eventCount: 1, tokens: unassigned.tokens, cost: unassigned.cost } } }],
      work: [{ query: sessionQuery, status: 'unknown', asOfMs: 1000 }],
      nowMs: 1000,
    }, bundledUsageModelPriceCatalog).results[0]!;
    expect(result.work?.allocations).toEqual([expect.objectContaining({ reason: 'missing_turn' })]);
    expect(result.workSummary?.mergedPrCount).toBeUndefined();

    const page = (state: UsageQueryResultSlice) => {
      const body = { ...props, slice: state, query: sessionQuery };
      return <>
        <UsageProjectLedgerWidget {...body} query={{ ...sessionQuery, metric: 'tokens' }} id="usage_project_ledger" testID="ledger" />
        <UsageOutcomesWidget {...body} id="usage_outcomes" testID="cost" />
        <UsageOutcomesWidget {...body} id="usage_outcomes" testID="shipped" presentation={{ style: 'shipped' }} />
      </>;
    };
    const screen = await renderScreen(page(result));
    const reason = t('usage.board.work.reason_missing_turn');
    expect.soft(screen.getTextContent()).toContain(reason);
    expect.soft(screen.getTextContent()).not.toContain(t('usage.board.work.workUnavailableTitle'));
    expect.soft(screen.findByTestId('ledger.conservation')?.props.accessibilityLabel).toContain(reason);
    expect.soft(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'cost.workUnavailable')?.props.reason).toContain(reason);
    expect.soft(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'shipped.unavailable')?.props.reason).toBe(reason);

    expect.soft(screen.getTextContent()).not.toContain(t('usage.board.page.workNotRead'));

    const accounting = [{ query: sessionQuery, status: 'available' as const, asOfMs: 1000,
      value: { ...result.accounting!, contributions: [{ ...unassigned, turnId: 't1' }] } }];
    const withoutEvidence = (work?: { query: typeof sessionQuery; status: UsageQueryResultSlice['sources'][number]['status'];
      errorCode?: string; pullRequestReadSessions?: string[]; evidence?: [] }) => resolveUsagePageAggregation({
      queries: [sessionQuery], accounting, work: work ? [work] : [], nowMs: 1000,
    }, bundledUsageModelPriceCatalog).results[0]!;
    const stateCard = (id: string) => screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === id);
    const noEvidence = t('usage.board.work.reason_missing_evidence');
    for (const [status, unread] of [
      ['not_loaded', withoutEvidence()],
      ['pending', withoutEvidence({ query: sessionQuery, status: 'pending' })],
    ] as const) {
      expect(unread.work?.allocations[0]?.reason).toBe('missing_evidence');
      expect(unread.sources.find(source => source.source === 'work')?.status).toBe(status);
      await screen.update(page(unread));
      expect.soft(screen.findByTestId('ledger.conservation')?.props.accessibilityLabel).toContain(t('usage.board.work.workUnavailableTitle'));
      expect.soft(screen.getTextContent()).not.toContain(t('usage.board.page.workNotRead'));
      expect.soft(screen.getTextContent()).not.toContain(noEvidence);
      expect(screen.findByTestId('cost.loading')).toBeTruthy();
      expect(screen.findByTestId('shipped.loading')).toBeTruthy();
    }

    await screen.update(page(withoutEvidence({ query: sessionQuery, status: 'error', errorCode: 'work_evidence_failed' })));
    expect(screen.findByTestId('ledger.conservation')?.props.accessibilityLabel).toContain(t('usage.board.page.workNotRead'));
    expect(stateCard('cost.workUnavailable')?.props.title).toBe(t('usage.board.page.workNotRead'));
    expect(stateCard('shipped.unavailable')).toBeTruthy();
    expect.soft(screen.getTextContent()).not.toContain(noEvidence);
    expect(screen.getTextContent()).not.toContain(t('usage.board.work.workUnavailableTitle'));

    await screen.update(page(withoutEvidence({ query: sessionQuery, status: 'available', pullRequestReadSessions: ['s1'], evidence: [] })));
    expect(screen.findByTestId('ledger.conservation')?.props.accessibilityLabel).toContain(noEvidence);
    expect(stateCard('cost.noPrs')?.props.reason).toBe(noEvidence);
    expect(stateCard('shipped.empty')?.props.reason).toBe(noEvidence);

    const linked = evidence('s1', 't1', 2493);
    const witnessed = resolveUsagePageAggregation({
      queries: [sessionQuery],
      accounting: [{ query: sessionQuery, status: 'available', asOfMs: 1000,
        value: { ...result.accounting!, contributions: [{ ...unassigned, turnId: 't1' }] } }],
      work: [{ query: sessionQuery, status: 'available', asOfMs: 1000, pullRequestReadSessions: ['s1'],
        evidence: [{ ...linked, pullRequest: { ...linked.pullRequest, mergedAtMs: 500 } }] }],
      nowMs: 1000,
    }, bundledUsageModelPriceCatalog).results[0]!;
    await screen.update(page(witnessed));
    expect(screen.getTextContent()).toContain(linked.pullRequest.title);
    expect(screen.findByTestId('shipped.shippedChart')).toBeTruthy();
  });

  it.each(['open', 'merged'] as const)('keeps a known %s PR without counting unread merges or claiming no links in the ledger', async state => {
    const witness = evidence('s1', 't1', 2493);
    const witnessedWork = allocateFixtureWork({ contributions, evidence: [
      { ...witness, pullRequest: { ...witness.pullRequest, state } },
    ] });
    const unread = withFixtureWorkAccounting({ ...slice, workSummary: projectUsageWorkSummary(witnessedWork.outcomes, false, { work: witnessedWork, contributions: fixtureContributions(witnessedWork) }), work: witnessedWork, sources: [
      { source: 'work', status: 'partial', errorCode: 'work_evidence_failed', unreadSessions: { failed: 1 } },
    ] }) satisfies UsageQueryResultSlice;
    const outcomes = await renderScreen(<UsageOutcomesWidget {...props} slice={unread} id="usage_outcomes" testID="outcomes" />);
    expect(outcomes.getTextContent()).toContain('2493');
    expect(outcomes.findByType(OutcomeFunnel).props.steps.find((step: React.ComponentProps<typeof OutcomeFunnel>['steps'][number]) => step.id === 'merged')?.value).toBeNull();
    const measured = { ...unread, workSummary: projectUsageWorkSummary(witnessedWork.outcomes, true, { work: witnessedWork, contributions: fixtureContributions(witnessedWork) }) };
    await outcomes.update(<UsageOutcomesWidget {...props} slice={measured} id="usage_outcomes" testID="outcomes" />);
    expect(outcomes.findByType(OutcomeFunnel).props.steps.find((step: React.ComponentProps<typeof OutcomeFunnel>['steps'][number]) => step.id === 'merged')?.value).toBe(state === 'merged' ? 1 : 0);
    const efficiency = await renderScreen(<UsageEfficiencyWidget {...props} slice={unread} id="usage_efficiency" testID="efficiency" />);
    const perMerge = () => efficiency.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'efficiency.perMergedPr')?.props;
    expect(perMerge()).toMatchObject({ value: '—', caption: t('usage.board.page.notMeasuredYet') });
    await efficiency.update(<UsageEfficiencyWidget {...props} slice={measured} id="usage_efficiency" testID="efficiency" />);
    expect(perMerge()?.caption).toBe(t(state === 'merged' ? 'usage.board.page.linkedByEvidence' : 'usage.board.page.noneLinkedByEvidence'));
    const ledger = await renderScreen(<UsageProjectLedgerWidget {...props} slice={unread} id="usage_project_ledger" testID="ledger" />);
    await ledger.pressByTestIdAsync('ledger.project.p1.toggle');
    expect(ledger.getTextContent()).toContain(witness.pullRequest.title);
    const withoutLinks = { ...unread, work: allocateFixtureWork({ contributions, evidence: [] }) };
    await ledger.update(<UsageProjectLedgerWidget {...props} slice={withoutLinks} id="usage_project_ledger" testID="ledger" />);
    expect(ledger.getTextContent()).not.toContain(t('usage.board.work.noneLinked'));
    expect(ledger.findByTestId('ledger.conservation')?.props.accessibilityLabel).toContain(
      `${t('usage.board.work.workPartialTitle')} · ${t('usage.board.work.workUnreadOther', { count: 1, formattedCount: '1' })}`);
  });

  it('dates the Work links at the ledger total by their own read, older than the accounting beside them, until Refresh moves both (J-A35)', async () => {
    const { readUsagePageFreshness } = await import('./usageBodyKit');
    const linksAt = Date.UTC(2026, 10, 24, 13, 3);
    const accountingAt = Date.UTC(2026, 10, 24, 14, 24);
    const witness = evidence('s1', 't1', 2493);
    const read = (workAsOfMs: number, readAtMs: number) => resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting!, asOfMs: readAtMs, readAtMs }],
      work: [{ query, status: 'available', asOfMs: workAsOfMs, pullRequestReadSessions: ['s1', 's2'], evidence: [witness] }],
      nowMs: readAtMs }, bundledUsageModelPriceCatalog).results[0]!;
    const linksRead = (atMs: number) => t('usage.board.work.linksReadAt', { time: formatUsageObservedAt(atMs) });
    // A usage event moved accounting on; Work was read earlier and was not reread.
    const older = read(linksAt, accountingAt);
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={older} id="usage_project_ledger" testID="ledger" />);
    const total = () => screen.findByTestId('ledger.conservation')?.props.accessibilityLabel ?? '';
    expect.soft(total().toLowerCase()).toContain(linksRead(linksAt).toLowerCase());
    expect.soft(screen.getTextContent().toLowerCase()).toContain(linksRead(linksAt).toLowerCase());
    // The page's one freshness line keeps accounting's time and names Work's older read apart, never Work at T2.
    expect.soft(readUsagePageFreshness([older])).toMatchObject({ asOfMs: accountingAt, olderSource: { source: 'work', asOfMs: linksAt } });
    // Refresh reads both again: both move, and nothing is older any more.
    const refreshedAt = Date.UTC(2026, 10, 24, 15, 0);
    const refreshed = read(refreshedAt, refreshedAt);
    await screen.update(<UsageProjectLedgerWidget {...props} slice={refreshed} id="usage_project_ledger" testID="ledger" />);
    expect.soft(total().toLowerCase()).toContain(linksRead(refreshedAt).toLowerCase());
    expect.soft(readUsagePageFreshness([refreshed]).olderSource).toBeNull();
  });
  it('states no Work read time when every target answered outside a repository (J-A Delivery 37)', async () => {
    const { readUsagePageFreshness } = await import('./usageBodyKit');
    const readAt = Date.UTC(2026, 10, 24, 14, 24);
    const unsupported = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: slice.accounting!, asOfMs: readAt, readAtMs: readAt }],
      work: [{ query, status: 'unsupported', asOfMs: Date.UTC(2026, 10, 24, 13, 3) }], nowMs: readAt }, bundledUsageModelPriceCatalog).results[0]!;
    expect(unsupported.sources.find(source => source.source === 'work')).toMatchObject({ status: 'unsupported' });
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={unsupported} id="usage_project_ledger" testID="ledger" />);
    const said = t('usage.board.work.linksReadAt', { time: '' }).trim().toLowerCase();
    expect.soft(screen.getTextContent().toLowerCase()).not.toContain(said);
    expect.soft(String(screen.findByTestId('ledger.conservation')?.props.accessibilityLabel ?? '').toLowerCase()).not.toContain(said);
    expect.soft(readUsagePageFreshness([unsupported]).olderSource).toBeNull();
  });
  it('states a settled Work gap at the total with the owner counts and no button of its own: the header retries (J-B46)', async () => {
    const witness = evidence('s1', 't1', 2493);
    const witnessedWork = allocateFixtureWork({ contributions, evidence: [witness] });
    const gap = withFixtureWorkAccounting({ ...slice, workSummary: projectUsageWorkSummary(witnessedWork.outcomes, false, { work: witnessedWork, contributions: fixtureContributions(witnessedWork) }), work: witnessedWork, sources: [
      { source: 'work', status: 'partial', asOfMs: 1000, errorCode: 'work_evidence_failed', unreadSessions: { failed: 1, not_entitled: 1 } },
    ] }) satisfies UsageQueryResultSlice;
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={gap} id="usage_project_ledger" testID="ledger" />);
    expect.soft(screen.findAll(node => typeof node.props?.testID === 'string' && node.props.testID.startsWith('ledger.workRetry'))).toHaveLength(0);
    // Outside a page (Home, a board) the body's own coverage line keeps its Retry; on a page the header owns it.
    expect.soft(screen.findByTestId('ledger.conservation')?.props.accessibilityLabel).toContain(
      `${t('usage.board.work.workPartialTitle')} · ${t('usage.board.work.workUnreadOther', { count: 2, formattedCount: '2' })}`);
  });
  it('shows prior linked Work rows with an unknown merged figure during and after a failed refresh', async () => {
    const witness = evidence('s1', 't1', 2493);
    const accounting = [{ query, status: 'available' as const, value: slice.accounting! }];
    const initial = resolveUsagePageAggregation({ queries: [query], accounting,
      work: [{ query, status: 'available', asOfMs: 900, pullRequestReadSessions: ['s1', 's2'],
        evidence: [{ ...witness, pullRequest: { ...witness.pullRequest, mergedAtMs: 500 } }] }],
    }, bundledUsageModelPriceCatalog);
    const pending = resolveUsagePageAggregation({ queries: [query], accounting, previous: initial,
      work: [{ query, status: 'pending' }],
    }, bundledUsageModelPriceCatalog);
    const failed = resolveUsagePageAggregation({ queries: [query], accounting, previous: initial, projectionPrevious: pending,
      work: [{ query, status: 'error', errorCode: 'work_evidence_failed', unreadSessions: { failed: 2 } }],
    }, bundledUsageModelPriceCatalog);
    const renderWork = (result: typeof initial) => <>
      <UsagePeriodSummaryWidget {...props} slice={result.results[0]!} id="usage_period_summary" testID="overview" />
      <UsageOutcomesWidget {...props} slice={result.results[0]!} id="usage_outcomes" testID="outcomes" />
    </>;
    const screen = await renderScreen(renderWork(initial));
    const mergedFigure = () => screen.findAllByType(HappierDataMetric).find(metric => metric.props.label === t('usage.board.page.mergedPrs'))?.props;
    const mergedFunnelStep = () => screen.findByType(OutcomeFunnel).props.steps.find((step: React.ComponentProps<typeof OutcomeFunnel>['steps'][number]) => step.id === 'merged');
    expect(mergedFigure()).toMatchObject({ value: 1, caption: t('usage.board.page.linkedByEvidence') });
    expect(mergedFunnelStep()?.value).toBe(1);
    await screen.update(renderWork(pending));
    expect(screen.getTextContent()).toContain(witness.pullRequest.title);
    expect.soft(mergedFigure()).toMatchObject({ value: '—', caption: t('usage.board.page.notMeasuredYet') });
    expect.soft(mergedFunnelStep()?.value).toBeNull();
    await screen.update(renderWork(failed));
    expect(screen.getTextContent()).toContain(witness.pullRequest.title);
    expect(failed.results[0]?.sources).toContainEqual({ source: 'work', status: 'stale', asOfMs: 900,
      errorCode: 'work_evidence_failed', unreadSessions: { failed: 2 } });
    expect.soft(mergedFigure()).toMatchObject({ value: '—', caption: t('usage.board.page.notMeasuredYet') });
    expect.soft(mergedFunnelStep()?.value).toBeNull();
  });

  it('keeps the admitted merge week and Values when a sibling Session read fails', async () => {
    const witness = evidence('s1', 't1', 2493);
    const witnessedWork = allocateFixtureWork({ contributions, evidence: [
      { ...witness, pullRequest: { ...witness.pullRequest, mergedAtMs: 500 } },
    ] });
    const renderShipped = (pullRequestsRead: boolean) => {
      const shippedSlice = withFixtureWorkAccounting({
        ...slice,
        work: witnessedWork,
        workSummary: projectUsageWorkSummary(witnessedWork.outcomes, pullRequestsRead, { work: witnessedWork, contributions: fixtureContributions(witnessedWork) }),
        mergedOutcomes: summarizeUsageMergedOutcomes({
          work: witnessedWork, contributions: fixtureContributions(witnessedWork), period: { startMs: 0, endMs: 1000 },
          timeZoneOffsetMinutes: query.timeZoneOffsetMinutes, pullRequestsRead,
        }),
        sources: pullRequestsRead ? slice.sources : [{ source: 'work', status: 'partial', unreadSessions: { failed: 1 } }],
      }) satisfies UsageQueryResultSlice;
      return <WidgetPresentationProvider value={{ size: 'large',
        footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'tall' }, geometry: { width: 520, height: 260 } }}>
        <UsageChartInteractions>
          <UsageOutcomesWidget {...props} slice={shippedSlice} presentation={{ style: 'shipped' }} id="usage_outcomes" testID="shipped" />
        </UsageChartInteractions>
      </WidgetPresentationProvider>;
    };

    const screen = await renderScreen(renderShipped(false));
    expect(screen.findByTestId('shipped.shipped')).toBeTruthy();
    expect(screen.findByTestId('shipped.shippedChart.spine.0.0')).toBeTruthy();
    await screen.pressByTestIdAsync('shipped.shippedChart-values-toggle');
    const values = () => screen.findByType(HappierDataTable).props;
    const knownRows = values().rows;
    expect(knownRows).toEqual([[expect.any(String), t('usage.board.charts.shippedCount', { count: 1 })]]);
    expect(values().label).toContain(t('usage.board.page.notMeasuredYet'));
    expect(values().label).not.toContain(t('usage.board.charts.shippedA11y', { count: 1 }));

    await screen.update(renderShipped(true));
    expect(screen.findByTestId('shipped.shippedChart.spine.0.0')).toBeTruthy();
    expect(values().rows).toEqual(knownRows);
    expect(values().label).toBe(t('usage.board.charts.shippedA11y', { count: 1 }));
  });

  it('keeps ambiguous witnesses without known PR rows unavailable after an incomplete read', async () => {
    const ambiguous = allocateFixtureWork({ contributions, evidence: [evidence('s1', 't1', 1), evidence('s1', 't1', 2)] });
    const partial = withFixtureWorkAccounting({ ...slice, work: ambiguous, workSummary: projectUsageWorkSummary(ambiguous.outcomes, false, { work: ambiguous, contributions: fixtureContributions(ambiguous) }),
      sources: [{ source: 'work', status: 'partial', unreadSessions: { failed: 1 } }] }) satisfies UsageQueryResultSlice;
    const screen = await renderScreen(<UsageOutcomesWidget {...props} slice={partial} id="usage_outcomes" testID="outcomes" />);
    expect(screen.findByTestId('outcomes.workUnavailable')).toBeTruthy();
    expect(screen.findByTestId('outcomes.noPrs')).toBeFalsy();
    expect(screen.findAllByType(OutcomeFunnel)).toHaveLength(0);
  });

  it('keeps unread PR evidence unknown in both styles without reading money or losing Session commands', async () => {
    const navigation = vi.spyOn(router, 'push');
    try {
    const bare = allocateFixtureWork({
      contributions: Array.from({ length: 3800 }, (_, index) => contribution(`bare-${index}`, `s${index % 2 + 1}`, `t${index}`)),
      evidence: [],
    });
    let moneyReads = 0;
    for (const row of fixtureContributions(bare)) Object.defineProperty(row.cost, 'reportedUsd', {
      enumerable: true, get: () => { moneyReads++; return 3; },
    });
    const refresh = vi.fn(async () => {});
    const caption = vi.fn();
    const unread = withFixtureWorkAccounting({ ...slice, work: bare, workSummary: undefined, sources: [
      { source: 'work', status: 'partial', errorCode: 'work_evidence_failed', unreadSessions: { failed: 1 } },
    ] }) satisfies UsageQueryResultSlice;
    const reader = React.createRef<ReturnType<typeof useOptionalCurrentUiContextReader>>();
    function Outcomes() {
      reader.current = useOptionalCurrentUiContextReader();
      return <UsageOutcomesWidget {...props} model={{ refresh }} slice={unread} id="usage_outcomes" testID="outcomes" />;
    }
    const screen = await renderScreen(<WidgetFrameBodyCaptionContext.Provider value={caption}>
      <Outcomes />
    </WidgetFrameBodyCaptionContext.Provider>);
    expect(screen.findByTestId('outcomes.funnel')).toBeFalsy();
    expect(screen.findByTestId('outcomes.noPrs')).toBeFalsy();
    expect(screen.findByTestId('outcomes.workUnavailable')).toBeTruthy();
    expect(caption).not.toHaveBeenLastCalledWith(t('usage.board.page.noneLinkedByEvidence'));
    await act(async () => { await screen.findByType(SurfaceFreshnessLine).props.action.onPress(); });
    expect(refresh).toHaveBeenCalledOnce();
    const commands = reader.current!.readCurrentUiContext()!.commands.filter(row => row.title.startsWith(`${t('common.open')}: `));
    expect(commands).toHaveLength(2);
    const routes: string[] = [];
    for (const command of commands) {
      await act(async () => {
        expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: command.id },
          context: { surface: 'agent' } })).toMatchObject({ ok: true });
      });
      routes.push(new URL(String(navigation.mock.calls.at(-1)?.[0]), 'https://usage.test').pathname);
    }
    expect(routes.sort()).toEqual(['/session/s1/usage', '/session/s2/usage']);
    const shipped = await renderScreen(<UsageOutcomesWidget {...props} slice={unread}
      presentation={{ style: 'shipped' }} id="usage_outcomes" testID="shipped" />);
    expect(shipped.findByTestId('shipped.unavailable')).toBeTruthy();
    expect(shipped.findByTestId('shipped.empty')).toBeFalsy();
    const workRead = { ...unread, sources: slice.sources };
    await shipped.update(<UsageOutcomesWidget {...props} slice={workRead}
      presentation={{ style: 'shipped' }} id="usage_outcomes" testID="shipped" />);
    expect(shipped.findByTestId('shipped.unavailable')).toBeTruthy();
    expect(shipped.findByTestId('shipped.empty')).toBeFalsy();
    const mergedOutcomes = summarizeUsageMergedOutcomes({
      work: bare, contributions: fixtureContributions(bare), period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes, pullRequestsRead: true,
    });
    const workSummary = projectUsageWorkSummary(bare.outcomes, true, { work: bare, contributions: fixtureContributions(bare) });
    await shipped.update(<UsageOutcomesWidget {...props} slice={{ ...workRead, mergedOutcomes, workSummary }}
      presentation={{ style: 'shipped' }} id="usage_outcomes" testID="shipped" />);
    expect(shipped.findByTestId('shipped.empty')).toBeTruthy();
    expect(shipped.getTextContent()).toMatch(/merged PRs linked in this period/);
    const measured = await renderScreen(<WidgetFrameBodyCaptionContext.Provider value={caption}>
      <UsageOutcomesWidget {...props} slice={{ ...workRead, mergedOutcomes, workSummary }}
        id="usage_outcomes" testID="measured" />
    </WidgetFrameBodyCaptionContext.Provider>);
    expect(caption).toHaveBeenLastCalledWith(t('usage.board.page.noneLinkedByEvidence'));
    expect(measured.findByTestId('measured.noPrs')).toBeTruthy();
    expect(measured.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'measured.noPrs')?.props.size).toBe('line');
    expect(moneyReads, 'neither unavailable nor measured-empty Outcomes reads money').toBe(0);
    } finally { navigation.mockRestore(); }
  });

  it('keeps the no-Sessions state ahead of the no-PR state', async () => {
    const bare = allocateFixtureWork({
      contributions: [{ ...contribution('sessionless', 's1', 't1'), sessionId: null }], evidence: [],
    });
    const screen = await renderScreen(<UsageOutcomesWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: bare, workSummary: projectUsageWorkSummary(bare.outcomes, true, { work: bare, contributions: fixtureContributions(bare) }) })}
      id="usage_outcomes" testID="outcomes" />);
    expect(screen.findByTestId('outcomes.empty')).toBeTruthy();
    expect(screen.findByTestId('outcomes.noPrs')).toBeFalsy();
    expect(screen.findByTestId('outcomes.funnel')).toBeFalsy();
  });

  it('keeps empty Outcomes Session command labels private and updates retained Machine names when inventory arrives', async () => {
    const previous = storage.getState();
    const serverId = actionHome!.homes.work!.id;
    const sessions = ['s1', 's2'].map((id, index) => createSessionListRenderableSessionFixture({ id, metadata: {
      name: 'Retained session', path: '/work', host: `Retained host ${index + 1}`, machineId: `machine-${index + 1}`,
    } }));
    storage.setState({ machines: {}, machineDisplayById: {}, machineListByServerId: { [serverId]: null },
      machineListStatusByServerId: { [serverId]: 'error' },
      sessionListRowsByServerId: { [serverId]: Object.fromEntries(sessions.map(session => [session.id, session])) } });
    storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } });
    storage.getState().setSessionTagAssignmentsOptimistic(serverId, 's1', ['private']);
    const bare = allocateFixtureWork({ contributions: sessions.map((session, index) => ({
      ...contribution(`retained-${index}`, session.id, 't1'), machineId: `machine-${index + 1}`,
      observedAtMs: 1_700_000_000_000 + index * 900_000,
    })), evidence: [] });
    const Wrapper = ({ children }: React.PropsWithChildren) => <CommandWrapper>{children}
      <UsageOutcomesWidget {...props} serverId={serverId} slice={withFixtureWorkAccounting({ ...slice, work: bare })} id="usage_outcomes" testID="retained-outcomes" />
    </CommandWrapper>;
    const hook = await renderHook(() => useOptionalCurrentUiContextReader(), { wrapper: Wrapper });
    const commandTitles = () => hook.getCurrent()!.readCurrentUiContext()!.commands
      .filter(row => row.title.startsWith(`${t('common.open')}: `)).map(row => row.title);
    try {
      expect(commandTitles()).toHaveLength(2);
      expect(commandTitles().some(title => title.includes('Retained host 1'))).toBe(true);
      expect(commandTitles().some(title => title.includes('Retained host 2'))).toBe(true);
      await act(async () => { setScreenSharingPrivacyActive(true); });
      expect(commandTitles()).toContain(`${t('common.open')}: ${t('session.untitled')}`);
      expect(commandTitles().some(title => title.includes('Retained host 1'))).toBe(false);
      await act(async () => { setScreenSharingPrivacyActive(false); });
      const machines = ['machine-1', 'machine-2'].map((id, index) => {
        const machine = createMachineFixture({ id });
        return { ...machine, metadata: { ...machine.metadata!, displayName: `Current computer ${index + 1}` } };
      });
      await act(async () => { storage.getState().applyMachines(machines); });
      expect(commandTitles().some(title => title.includes('Current computer 1'))).toBe(true);
      expect(commandTitles().some(title => title.includes('Current computer 2'))).toBe(true);
      expect(commandTitles().some(title => title.includes('Retained host'))).toBe(false);
    } finally { setScreenSharingPrivacyActive(false); await hook.unmount(); storage.setState(previous, true); }
  });

  it('keeps witnessed ambiguous PRs in the ready funnel without an allocated PR', async () => {
    const ambiguous = allocateFixtureWork({
      contributions: [contribution('ambiguous', 's1', 't1')],
      evidence: [evidence('s1', 't1', 1), evidence('s1', 't1', 2)],
    });
    expect(ambiguous.outcomes).toHaveLength(0);
    const screen = await renderScreen(<UsageOutcomesWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: ambiguous, workSummary: projectUsageWorkSummary(ambiguous.outcomes, true, { work: ambiguous, contributions: fixtureContributions(ambiguous) }) })}
      id="usage_outcomes" testID="outcomes" />);
    expect(screen.findByType(OutcomeFunnel).props.steps).toMatchObject([
      { id: 'sessions', value: 1 }, { id: 'witnessed', value: 1 },
      { id: 'allocated', value: 0 }, { id: 'merged', value: 0 },
    ]);
  });

  it('coach on Overview is the findings alone: no facts band, checks, digest or preferences', async () => {
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'full',
      footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'tall' }, geometry: { width: 900, height: 300 } }}>
      <UsageCoachWidget {...props} id="usage_coach" testID="coach" />
    </WidgetPresentationProvider>);
    expect(screen.findByTestId('coach.finding.compaction_storms')).toBeTruthy();
    expect(screen.findByTestId('coach.summary')).toBeFalsy();
    expect(screen.findByTestId('coach.checks')).toBeFalsy();
    expect(screen.findByTestId('coach.configure')).toBeFalsy();
  });

  it('says a finding in its measured facts; observation counts and coverage wait behind Why (R7)', async () => {
    const screen = await renderScreen(
      <UsageCoachWidget {...props} id="usage_coach" testID="coach" />,
    );
    const finding = coach.findings[0]!;
    const meta = screen.findByTestId('coach.finding.compaction_storms.meta')!;
    const metaText = String(meta.props.children);
    expect(metaText).toContain(`${finding.measurements[0]!.value} ${t(`usage.board.coach.metric_${finding.measurements[0]!.metric as 'compactions'}`, { count: finding.measurements[0]!.value })}`);
    // Mechanism words (observation counts, evidence coverage) are method facts, not the finding's line.
    const evidenceLine = t('usage.board.coach.evidenceLine', { count: finding.evidence.length,
      coverage: t(`usage.board.coach.coverage_${finding.coverage}`) });
    expect(metaText).not.toContain(evidenceLine);
    expect(screen.getTextContent()).not.toContain(evidenceLine);
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.why-header');
    expect(screen.getTextContent()).toContain(evidenceLine);
    await screen.update(<UsageCoachWidget {...props} id="usage_coach" testID="coach"
      slice={{ ...slice, pending: true, coach: { ...coach, currentness: 'stale', asOfMs: 1100 } }} />);
    expect(screen.findByTestId('coach.finding.compaction_storms.evidence')).toBeTruthy();
    expect(screen.getTextContent()).toContain(evidenceLine);
  });

  it('says a count of one in the singular, through the copy owner (acceptance r230 #85)', async () => {
    const first = coach.findings[0]!;
    const one = { ...coach, findings: [{ ...first, measurements: first.measurements.map(measurement =>
      measurement.metric === 'compactions' ? { ...measurement, value: 1 } : measurement) }, ...coach.findings.slice(1)] };
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={{ ...slice, coach: one }} id="usage_coach" testID="coach" />);
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.why-header');
    const text = screen.findByTestId('coach.finding.compaction_storms.evidence.measurements')!
      .findAll(node => typeof node.props.children === 'string').map(node => node.props.children).join(' ');
    expect(text).toContain('1 compaction');
    expect(text).not.toContain('1 compactions');
  });

  it('lists a finding\'s many observations behind Why as a led list with Show all, not a wall of lines', async () => {
    const first = coach.findings[0]!;
    const observation = first.evidence[0]!;
    const many = { ...coach, findings: [{ ...first,
      evidence: Array.from({ length: 40 }, (_, index) => ({ ...observation, id: `obs-${index}`, observedAtMs: observation.observedAtMs + index * 60_000 })) },
      ...coach.findings.slice(1)] };
    const screen = await renderScreen(<UsageCoachWidget {...props} slice={{ ...slice, coach: many }} id="usage_coach" testID="coach" />);
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.why-header');
    const listed = () => new Set(screen.findAll(node => String(node.props.testID ?? '').startsWith('coach.finding.compaction_storms.evidence.obs-'))
      .map(node => node.props.testID)).size;
    expect(listed()).toBeLessThan(10);
    expect(listed()).toBeGreaterThan(0);
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.evidence.showAll.toggle');
    expect(listed()).toBe(40);
  });

  it('coach shows the evidence-backed finding, hides a dismissed one and keeps insufficient checks visible', async () => {
    const screen = await renderScreen(
      <UsageCoachWidget {...props} id="usage_coach" testID="coach" />,
    );
    expect(screen.findByTestId('coach.finding.compaction_storms')).toBeTruthy();
    expect(screen.findByTestId('coach.finding.compaction_storms.why')).toBeTruthy();
    expect(screen.findByTestId('coach.finding.compaction_storms.evidence')).toBeFalsy();
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.why-header');
    expect(screen.findByTestId('coach.finding.compaction_storms.evidence')).toBeTruthy();
    // A citation reads as its site; its exact address is the link's accessible name and target.
    const citation = coach.findings[0]!.basis.citations[0]!;
    expect(screen.getTextContent()).toContain(new URL(citation.url).host);
    expect(screen.findAll(node => node.props.accessibilityRole === 'link'
      && String(node.props.accessibilityLabel ?? '').startsWith(citation.url))).not.toHaveLength(0);
    expect(screen.getTextContent()).toContain(coach.findings[0]!.basis.limitations[0]!);
    expect(screen.findByTestId('coach.finding.compaction_storms.evidence.c1')).toBeTruthy();
    expect(String(screen.findByTestId('coach.finding.compaction_storms.evidence.c1')!.props.children)).not.toContain('c1');
    const measurements = screen.findByTestId('coach.finding.compaction_storms.evidence.measurements')!;
    const measurementsText = measurements.findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children).join(' ');
    const observedCompactions = coach.findings[0]!.measurements.find(measurement => measurement.metric === 'compactions')!;
    expect(measurementsText).toContain(`${observedCompactions.value} ${t('usage.board.coach.metric_compactions', { count: observedCompactions.value })}`);
    expect(screen.getTextContent()).not.toContain(coach.findings[0]!.basis.method);
    await screen.pressByTestIdAsync('coach.finding.compaction_storms.evidence.diagnostics-header');
    expect(screen.getTextContent()).toContain(coach.findings[0]!.basis.method);
    expect(screen.findByTestId('coach.checks-header')).toBeTruthy();
    const dismissed = applyUsageCoachPreferences(
      coach,
      {
        ...DEFAULT_USAGE_COACH_PREFERENCES_V1,
        suppressions: [
          { kind: 'dismissed', evidenceKey: coach.findings[0]!.evidenceKey },
        ],
      },
      500,
    );
    const hidden = await renderScreen(
      <UsageCoachWidget
        {...props}
        slice={{ ...slice, coach: dismissed }}
        id="usage_coach"
        testID="coach"
      />,
    );
    expect(hidden.findByTestId('coach.finding.compaction_storms')).toBeFalsy();
    expect(hidden.findByTestId('coach.empty')).toBeTruthy();
    expect(hidden.findByTestId('coach.hidden-header')).toBeTruthy();
    await hidden.pressByTestIdAsync('coach.hidden-header');
    expect(hidden.findByTestId('coach.hidden.compaction_storms.restore')).toBeTruthy();
  });
});

describe('Work view when Work links are only partly read (USAGE-UI-WORK-R5)', () => {
  const offline = { source: 'work', status: 'partial', errorCode: 'machine_offline', unreadSessions: { machine_unavailable: 1011 } } as const;
  const workStates = [
    { state: 'reading', source: { source: 'work', status: 'pending' } as const,
      footer: () => t('usage.board.page.coveragePending', { sources: usageSourceTitle('work') }) },
    { state: 'partly read', source: offline, footer: () => `${t('usage.board.work.workPartialTitle')} · ${t('usage.board.work.workUnreadUnreachable', { count: 1011, formattedCount: (1011).toLocaleString(getPreferredLanguage()) })}` },
    { state: 'failed', source: { source: 'work', status: 'error', errorCode: 'work_evidence_failed' } as const, footer: () => t('usage.board.page.workNotRead') },
  ];
  const unreadSlice = (source: UsageQueryResultSlice['sources'][number]): UsageQueryResultSlice => ({ ...slice,
    workSummary: projectUsageWorkSummary(work.outcomes, false, { work: work, contributions: fixtureContributions(work) }),
    sources: [{ source: 'accounting', status: 'available' }, source] });

  // Tokens: an unknown token part reads "not measured yet", the placeholder the production frame printed on each row.
  const tokensQuery = normalizeUsageQuery({ ...query, metric: 'tokens' });
  it.each(workStates)('the ledger says the $state state once, at the total, and keeps every measured amount', async ({ state, source, footer }) => {
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} query={tokensQuery} slice={unreadSlice(source)} id="usage_project_ledger" testID="ledger" />);
    const label = screen.findByTestId('ledger.conservation')?.props.accessibilityLabel as string;
    expect(label).toContain(footer());
    if (state === 'partly read') expect(label).not.toContain(t('usage.board.work.workUnavailableTitle'));
    const text = screen.getTextContent();
    // A row carries only what is known about it: its amount and its linked PR, never a placeholder for the unknown part.
    expect(text).not.toContain(t('usage.board.page.notMeasuredYet'));
    expect(text).toContain(t('usage.board.work.ledgerRowLine', { sessions: 2, prs: 1 }));
    expect(screen.findByType(HappierDataRows).props.rows[0][1]).toBe(42);
    expect(text.split(footer())).toHaveLength(2);
  });

  it('the ledger keeps its read state unchanged: the linked and not linked parts add back to the total', async () => {
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} query={tokensQuery} id="usage_project_ledger" testID="ledger" />);
    const label = screen.findByTestId('ledger.conservation')?.props.accessibilityLabel as string;
    expect(label).toContain(t('usage.board.work.conservation', { allocated: '14', unallocated: '28' }));
    expect(label).not.toContain(t('usage.board.work.workPartialTitle'));
    expect(screen.getTextContent()).toContain(t('usage.board.work.notLinkedPart', { amount: '28' }));
  });

  it('names each typed cause the owner gives and the plain partial without a count', async () => {
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props}
      slice={unreadSlice({ source: 'work', status: 'partial', unreadSessions: { failed: 1, timed_out: 2 } })} id="usage_project_ledger" testID="ledger" />);
    expect(screen.findByTestId('ledger.conservation')?.props.accessibilityLabel).toContain(
      `${t('usage.board.work.workPartialTitle')} · ${t('usage.board.work.workUnreadOther', { count: 3, formattedCount: '3' })}`);
    await screen.update(<UsageProjectLedgerWidget {...props}
      slice={unreadSlice({ source: 'work', status: 'partial', errorCode: 'machine_offline' })} id="usage_project_ledger" testID="ledger" />);
    expect(screen.findByTestId('ledger.conservation')?.props.accessibilityLabel).toContain(t('usage.board.work.workUnreadUnreachableSome'));
  });

  it.each([
    { cause: RPC_ERROR_CODES.SESSION_MACHINE_CONTROL_UNAVAILABLE, sourceCode: undefined },
    { cause: 'target_unavailable', sourceCode: undefined },
    { cause: 'machine_offline', sourceCode: 'machine_offline' },
  ])('describes an unread Machine as unreachable ($cause)', async ({ cause, sourceCode }) => {
    const accounting = [{ query: tokensQuery, status: 'available' as const, value: slice.accounting! }];
    const sources = await collectUsageWorkSources({
      queries: [tokensQuery], accounting, assertCurrent: () => {}, now: () => 1000,
      resolveSession: async sessionId => sessionId === 's1' ? { machineId: 'reachable', cwd: '/repo' } : { errorCode: cause },
      readMachine: async () => ({ sessions: [{ sessionId: 's1', status: 'partial', pullRequestsRead: true,
        evidence: [evidence('s1', 't1', 2493)] }] }),
    });
    const result = resolveUsagePageAggregation({ queries: [tokensQuery], accounting, work: sources }, bundledUsageModelPriceCatalog).results[0]!;
    expect(result.sources.find(source => source.source === 'work')).toEqual({
      source: 'work', status: 'partial', asOfMs: 1000, unreadSessions: { machine_unavailable: 1 },
      ...(sourceCode ? { errorCode: sourceCode } : {}),
    });
    expect(usageWorkLinksNotice(result).cause).toBe(
      "1 session is on a Machine that can't be reached; its links are read when that Machine can be reached again");
  });

  it('formats larger Russian Work counts separately from plural selection', async () => {
    const previous = getPreferredLanguage();
    const count = 1021;
    try {
      setPreferredLanguageFromSettings('ru');
      await preloadTranslations();
      const number = count.toLocaleString('ru');
      const notice = usageWorkLinksNotice(unreadSlice({ source: 'work', status: 'partial',
        errorCode: 'work_evidence_failed', unreadSessions: { machine_unavailable: count, timed_out: 1019, not_entitled: 1, failed: 1 } }));
      expect(notice.cause?.split(' · ')).toEqual([
        expect.stringContaining(number + ' сессия'),
        'Не удалось прочитать: ' + number + ' сессия',
      ]);
    } finally {
      setPreferredLanguageFromSettings(previous);
      await preloadTranslations();
    }
  });

  it.each(['outcomes', 'value', 'autopsy'] as const)('the %s widget titles a partly read Work read as incomplete, with its cause', async widget => {
    const partial = { ...slice, work: undefined, workSummary: undefined, sources: [{ source: 'accounting', status: 'available' }, offline] } satisfies UsageQueryResultSlice;
    const sessionQuery = normalizeUsageQuery({ ...query, session: 's1' });
    const screen = await renderScreen(widget === 'outcomes'
      ? <UsageOutcomesWidget {...props} slice={partial} id="usage_outcomes" testID="w" />
      : widget === 'value' ? <UsageSessionValueWidget {...props} slice={partial} id="usage_session_value" testID="w" />
        // Without accounting the autopsy itself says why it has no Work facts (with accounting it shows the summary).
        : <UsageWorkAutopsy {...props} query={sessionQuery} slice={{ ...partial, accounting: undefined, shownQuery: sessionQuery }} testID="w" />);
    const text = screen.getTextContent();
    expect(text).toContain(t('usage.board.work.workPartialTitle'));
    expect(text).toContain(t('usage.board.work.workUnreadUnreachable', { count: 1011, formattedCount: (1011).toLocaleString(getPreferredLanguage()) }));
    expect(text).not.toContain(t('usage.board.work.workUnavailableTitle'));
  });

  it('says a one-commit branch range once: "Commit 027cb70 · +1 / −0" (acceptance 1122 #59)', async () => {
    const sha = '027cb70'.padEnd(40, 'e');
    const branch = { ref: 'refs/heads/usage-outcome-01', headSha: sha };
    const branchWork = allocateFixtureWork({ contributions: [contribution('one', 's1', 't1')], evidence: [],
      branchEvidence: [{ sessionId: 's1', turnId: 't1', repositoryKey: 'repo', checkpointRef: 'checkpoint/s1/t1',
        checkpointCommitSha: 'a'.repeat(40), commitSha: sha, attributionScope: 'no_happier_checkpoint_overlap_observed', branch,
        retainedChange: { targetSha: sha, method: 'changed_file_tree_comparison', status: 'retained', addedLines: 1, removedLines: 0 } }] });
    const screen = await renderScreen(<UsageProjectLedgerWidget {...props} slice={withFixtureWorkAccounting({ ...slice, work: branchWork })} id="usage_project_ledger" testID="ledger" />);
    const text = screen.getTextContent();
    expect(text).toContain(`${t('usage.board.work.commit')} 027cb70`);
    expect(text).toContain('+1 / −0');
    expect(text.split('027cb70')).toHaveLength(2);
  });

  it('on the Tokens lens the Session cost basis is said once; the Cost over time caption keeps only the currency (acceptance 1122 #58)', async () => {
    const sessionQuery = normalizeUsageQuery({ ...query, metric: 'tokens', session: 's1', costBasis: 'api_equivalent' });
    const cost = (usd: number) => ({ reportedUsd: 0, estimatedUsd: 0, apiEquivalentUsd: usd, currency: 'USD' });
    const rows = [5, 3, 1].map((usd, index) => ({ ...contribution(`turn-${index}`, 's1', `t${index}`),
      observedAtMs: 1 + index * 60_000, cost: cost(usd / 1000) }));
    const screen = await renderScreen(<UsageSessionValueWidget {...props} query={sessionQuery}
      slice={withFixtureWorkAccounting({ ...slice, shownQuery: sessionQuery,
        accounting: { ...slice.accounting!, totals: { ...slice.accounting!.totals, eventCount: 3, cost: cost(0.009) }, contributions: rows },
        work: allocateFixtureWork({ contributions: rows, evidence: [] }) })}
      id="usage_session_value" testID="value" />);
    const costFact = screen.findAllByType(HappierDataMetric).find(node => node.props.label === t('usage.cost'));
    expect(costFact?.props.caption).toContain(usageCostKindPhrase('api_equivalent'));
    const timeline = screen.findAllByType(UsageWorkSectionTitle).find(node => node.props.children === t('usage.board.work.costOverTime'));
    expect(timeline?.props.caption).toBe('USD');
  });
});
