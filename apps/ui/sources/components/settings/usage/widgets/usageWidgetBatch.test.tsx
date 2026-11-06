import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageAnalyticsQueryBatchRequestSchema, type UsageAnalyticsQueryBatchResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery, repriceUsageAnalyticsResponse } from '@happier-dev/protocol/usage/usageCost';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { invalidateHomeAccountReadJoins } from '@/sync/runtime/orchestration/homeAccountChange';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import {
  UsageWidgetBatchProvider,
  useUsageWidgetBatchSlices,
  useUsageWidgetBatchInventorySlice,
  useUsageWidgetModel,
  useUsageWidgetPageHasCoverageDetail,
  buildUsageWidgetQueryPlan,
} from './usageWidgetBatch';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { readUsageWidgetQueryOverrides, resolveUsageWidgetPageInitialQuery } from '../usageWidgetPageContext';
import { resolveUsagePageInitialFilters } from '../usageRouteParams';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { UsageWidgetBody } from './UsageWidgetBody';
import { UsageBreakdownsWidget } from './UsageBreakdownsWidget';
import { storage } from '@/sync/domains/state/storage';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { HappierDataMetric, HappierDataRows, RankedRows, StackedSeriesChart, UsageBreakdownsBody } from '@happier-dev/plugin-ui/presentation';
import { useUsageAnalyticsView } from './usageBodyKit';

const accounting: UsageAnalyticsQueryResponse = {
  v: 1,
  totals: {
    eventCount: 1,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 15,
    },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' },
  },
};
const scope = {
  period: { startMs: 1000 },
  agents: [],
  machines: [],
  projects: [],
  sources: [],
  session: null,
  costBasis: 'auto',
} as const;
const clauses = readUsageWidgetQueryOverrides(normalizeUsageQuery({ granularity: 'day', timeZoneOffsetMinutes: 0 }));

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  await home?.dispose();
  home = undefined;
  vi.restoreAllMocks();
});

/** The page chrome's view of the batch: one decoded Resource value for every mounted body. */
function BatchProbe(props: Readonly<{ batches: string[][] }>) {
  props.batches.push(useUsageWidgetBatchSlices().map((slice) => slice.key));
  return null;
}

function Body(
  props: Readonly<{
    name: string;
    metric: 'tokens' | 'cost';
    seen: Map<string, UsageWidgetBodyModel>;
    agent?: string;
  }>,
) {
  const { model } = useUsageWidgetModel({
    ...scope,
    agents: props.agent ? [props.agent] : [],
    metric: props.metric,
    breakdown: [],
  }, 'usage_daily');
  props.seen.set(props.name, model);
  return null;
}

describe('Usage page batch', () => {
  it('admits one cold visible batch, adds only a deferred delta and still explicitly refreshes', async () => {
    const release = createDeferred<void>();
    const requests: ReturnType<typeof UsageAnalyticsQueryBatchRequestSchema.parse>[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-mount-delta.test', accountId: 'account-a' }],
      route: async request => {
        if (request.path !== '/v2/usage/query-batch') return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        requests.push(input);
        signals.push(request.signal);
        await release.promise;
        return Response.json(collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
          results: input.queries.map(query => ({ query, value: accounting })),
        }, input, false)));
      } });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
    storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
      settingsScope: { serverId: server.id, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const seen = new Map<string, UsageWidgetBodyModel>();
    const inventoryQuery = normalizeUsageQuery({ ...scope, metric: 'tokens', breakdown: ['agent'] });
    function Inventory() { useUsageWidgetBatchInventorySlice(); return null; }
    const page = (phase: 'shell' | 'visible' | 'contracted' | 'scrolled') => <InjectedAuthProvider credentials={credentials}>
      <UsageWidgetBatchProvider clauses={clauses} inventoryQuery={inventoryQuery}>
        <Inventory />
        {(phase === 'visible' || phase === 'contracted') && <Body name="visible" metric="tokens" seen={seen} />}
        {phase === 'visible' && <Body name="leaving" metric="tokens" agent="leaving-agent" seen={seen} />}
        {phase === 'scrolled' && <Body name="deferred" metric="cost" agent="new-agent" seen={seen} />}
      </UsageWidgetBatchProvider>
    </InjectedAuthProvider>;
    const screen = await renderScreen(page('shell'));
    try {
      await flushHookEffects({ cycles: 10 });
      expect(requests, 'inventory waits for visible widget demand').toHaveLength(0);
      await screen.update(page('visible'));
      await expect.poll(() => requests.length).toBe(1);
      await flushHookEffects({ cycles: 10 });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.queries).toHaveLength(3);
      // Unrelated Home traffic withdraws generic raw joins, while the Usage
      // Account owner still admits this same pending accounting acquisition.
      invalidateHomeAccountReadJoins(server.id);
      await screen.update(page('contracted'));
      await flushHookEffects({ cycles: 10 });
      expect(requests, 'deferring a row does not reissue the admitted visible subset').toHaveLength(1);
      await screen.update(page('scrolled'));
      await expect.poll(() => requests.length).toBe(2);
      expect(requests[1]!.queries).toHaveLength(1);
      expect(requests[1]!.queries[0]!.filters?.agentIds).toEqual(['new-agent']);
      expect(signals.filter(signal => signal?.aborted), 'mount and scroll do not cancel admitted batches').toHaveLength(0);
      release.resolve();
      await expect.poll(() => seen.get('deferred')?.slice?.accounting?.totals.tokens.total).toBe(15);
      await flushHookEffects({ cycles: 10 });
      expect(requests).toHaveLength(2);
      await seen.get('deferred')!.refresh();
      expect(requests, 'explicit Refresh still replaces accounting through its Account owner').toHaveLength(3);
      expect(requests[2]!.queries).toHaveLength(2);
      await screen.update(page('shell'));
      await flushHookEffects({ cycles: 10 });
      expect(requests, 'an empty layout admits no follow-up read').toHaveLength(3);
    } finally { release.resolve(); await screen.unmount(); }
  });
  it('reuses settled Costs models when mounted widgets leave and rejoin the page, and renders a real cost change', async () => {
    // QA reload88 held 6,933 accounting events. Their mounted summary stays
    // bounded while leaving and revisiting a view must not rebuild its model.
    const eventCount = 6_933;
    let amount = 1;
    let historyAsOf = 90_000;
    const response = (): UsageAnalyticsQueryResponse => {
      const totals = { eventCount,
        tokens: { ...accounting.totals.tokens, input: 10 * eventCount, output: 5 * eventCount, total: 15 * eventCount },
        cost: { reportedUsd: amount, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const } };
      return { v: 1, totals, breakdowns: { agent: [{ key: 'codex', ...totals }] },
        activity: { calendarDays: [{ date: '1970-01-01', eventCount }] },
        coverage: { status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], ranked: [],
          range: { startMs: 1_000, endMs: historyAsOf, complete: false },
          sources: [{ source: 'runtime', path: 'runtime', status: 'partial', eventCount, asOfMs: historyAsOf, historyComplete: false }] },
        contributions: [{
          id: 'recorded-events', eventCount, sessionId: null, turnId: null, observedAtMs: 1_500,
          agentId: 'codex', modelId: null, machineId: null, projectKey: null, workspaceId: null,
          source: 'runtime', tokens: totals.tokens, cost: totals.cost,
        }] };
    };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-warm-model.test', accountId: 'account-a' }],
      route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
        ? Response.json(createRootLayoutFeaturesResponse())
        : request.path === '/v2/usage/query-batch' ? (() => {
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        return Response.json(collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
          results: input.queries.map(query => ({ query, value: repriceUsageAnalyticsResponse(response(), undefined, {}, query.costMode) })),
        }, input, false)));
      })() : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
      settingsScope: { serverId: server.id, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
    const views = new Set<NonNullable<ReturnType<typeof useUsageAnalyticsView>>>();
    let selectedModel: UsageWidgetBodyModel | null = null;
    let selectedView: ReturnType<typeof useUsageAnalyticsView> = null;
    const warmScope = { ...scope, period: { startMs: 1_000, endMs: 100_000 } };
    const costsInput = { ...warmScope, metric: 'cost', breakdown: ['agent'] };
    function Projection(props: Readonly<{ model: UsageWidgetBodyModel; query: NonNullable<ReturnType<typeof useUsageWidgetModel>['query']> }>) {
      const view = useUsageAnalyticsView(props.model.slice!, props.query);
      if (view) views.add(view);
      selectedView = view;
      return null;
    }
    function CostObserver() {
      const selected = useUsageWidgetModel(costsInput, 'usage_breakdowns');
      selectedModel = selected.model;
      return selected.query && selected.model.slice ? <Projection model={selected.model} query={selected.query} /> : null;
    }
    const inventoryQuery = normalizeUsageQuery({ ...warmScope, metric: 'tokens', breakdown: ['agent'] });
    const page = (costs: boolean, mount = 0) => <InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
      <UsageWidgetBatchProvider key={mount} clauses={clauses} inventoryQuery={inventoryQuery}>
        {costs ? <><UsageWidgetBody id="usage_breakdowns" input={costsInput} serverId={server.id} testID="warm-costs" /><CostObserver /></>
          : <UsageWidgetBody id="usage_breakdowns" input={{ ...warmScope, metric: 'tokens', breakdown: ['agent'] }} serverId={server.id} testID="warm-usage" />}
      </UsageWidgetBatchProvider>
    </CoreCollectionScope></InjectedAuthProvider>;
    const screen = await renderScreen(page(true));
    const visibleCost = () => screen.findAllByType(RankedRows).find(row => row.props.rows.some((entry: { id: string }) => entry.id === 'codex'))?.props.rows[0]?.value;
    try {
      await expect.poll(() => selectedModel?.requestedQuery).not.toBeNull();
      await expect.poll(() => selectedModel?.slice?.accounting?.totals.eventCount).toBe(eventCount);
      await expect.poll(visibleCost).toBeCloseTo(1);
      await expect.poll(() => selectedModel?.pending).toBe(false);
      await flushHookEffects({ cycles: 20 });
      const retainedAccounting = selectedModel!.slice!.accounting;
      const retainedView = selectedView;
      const builtViews = views.size;
      const reads = home.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
      await screen.update(page(false));
      await flushHookEffects({ cycles: 20 });
      await screen.update(page(true, 1));
      await expect.poll(visibleCost).toBeCloseTo(1);
      await expect.poll(() => selectedModel?.pending).toBe(false);
      await flushHookEffects({ cycles: 20 });
      expect(home.httpRequests.filter(request => request.path === '/v2/usage/query-batch')).toHaveLength(reads);
      expect(views.size - builtViews, 'unchanged reopen builds no new Costs analytics model').toBe(0);
      expect(selectedModel!.slice!.accounting).toBe(retainedAccounting);
      expect(selectedView).toBe(retainedView);
      historyAsOf++;
      await act(async () => { await selectedModel!.refresh(); });
      await expect.poll(() => selectedModel?.slice?.accounting?.coverage?.sources[0]?.asOfMs).toBe(historyAsOf);
      await expect.poll(() => selectedModel?.pending).toBe(false);
      expect(visibleCost()).toBeCloseTo(1);
      expect(views.size - builtViews, 'history-only provenance leaves displayed Costs equal and rebuilds zero models').toBe(0);
      expect(selectedView).toBe(retainedView);
      expect(selectedView!.insights.activeDays).toBe(1);
      await screen.update(page(false));
      await flushHookEffects({ cycles: 20 });
      await screen.update(page(true, 2));
      await expect.poll(visibleCost).toBeCloseTo(1);
      await expect.poll(() => selectedModel?.pending).toBe(false);
      expect(views.size - builtViews, 'reopening after history-only refresh also reuses the Costs model').toBe(0);
      amount = 2;
      await act(async () => { await selectedModel!.refresh(); });
      await expect.poll(visibleCost).toBeCloseTo(2);
      await expect.poll(() => selectedModel?.pending).toBe(false);
      await flushHookEffects({ cycles: 20 });
      expect(views.size - builtViews, 'a real accounting change builds exactly one new Costs analytics model').toBe(1);
      expect(selectedView).not.toBe(retainedView);
    } finally { await screen.unmount(); }
  });
  it.each([false, true])('preserves best-available money across HTTP summary delivery and every Costs body (unpriced=%s)', async unpriced => {
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
    const rawCost = { reportedUsd: 0.0548, estimatedUsd: 2.4, currency: 'USD', costSource: 'none' as const };
    const zeroTokens = { ...tokens, input: 0, total: 0 };
    const pricedCost = { reportedUsd: 0, estimatedUsd: 2.4, currency: 'USD', costSource: 'pricing_estimate' as const };
    const reportedCost = { reportedUsd: 0.0548, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const };
    const unknownCost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
    const known = { eventCount: 2, tokens, cost: rawCost };
    const unknown = { eventCount: 1, tokens, cost: unknownCost };
    const entries = [
      { eventCount: 1, tokens, cost: pricedCost, key: 'codex' },
      { eventCount: 1, tokens: zeroTokens, cost: reportedCost, key: 'claude' },
    ];
    const totals = { ...known, eventCount: unpriced ? 3 : 2,
      tokens: { ...tokens, input: unpriced ? 2_000_000 : 1_000_000, total: unpriced ? 2_000_000 : 1_000_000 } };
    const value: UsageAnalyticsQueryResponse = { v: 1, totals,
      contributions: [
        { id: 'priced', sessionId: null, turnId: null, observedAtMs: 100, eventCount: 1,
          agentId: 'codex', modelId: 'gpt-5', machineId: null, projectKey: null, workspaceId: null,
          source: 'native', tokens, tokenCategories: tokens,
          cost: pricedCost },
        { id: 'reported', sessionId: null, turnId: null, observedAtMs: 200, eventCount: 1,
          agentId: 'claude', modelId: null, machineId: null, projectKey: null, workspaceId: null,
          source: 'runtime', tokens: zeroTokens, cost: reportedCost },
        ...(unpriced ? [{ id: 'unknown', sessionId: null, turnId: null, observedAtMs: 86_400_100, eventCount: 1,
          agentId: 'unknown-agent', modelId: 'unpriced-model', machineId: null, projectKey: null, workspaceId: null,
          source: 'native', tokens, tokenCategories: tokens, cost: unknownCost }] : []),
      ],
      series: [{ ...known, bucketStartMs: 0, bucketEndMs: 86_400_000 },
        ...(unpriced ? [{ ...unknown, bucketStartMs: 86_400_000, bucketEndMs: 172_800_000 }] : [])],
      breakdowns: { agent: [...entries, ...(unpriced ? [{ ...unknown, key: 'unknown-agent' }] : [])] },
      engineTimeline: [{ bucketStartMs: 0, bucketEndMs: 86_400_000, leaders: entries },
        ...(unpriced ? [{ bucketStartMs: 86_400_000, bucketEndMs: 172_800_000, leaders: [{ ...unknown, key: 'unknown-agent' }] }] : [])],
    };
    const deliveries: UsageAnalyticsQueryBatchResponse[] = [];
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-cost-consistency.test', accountId: 'account-a' }],
      route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
        ? Response.json(createRootLayoutFeaturesResponse())
        : request.path === '/v2/usage/query-batch' ? (() => {
          const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
          const delivery = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
            results: input.queries.map(query => ({ query, value: repriceUsageAnalyticsResponse(value, undefined, {}, query.costMode) })),
          }, input, false));
          deliveries.push(delivery);
          return Response.json(delivery);
        })() : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const serverId = home.homes.a!.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
      <UsageWidgetBatchProvider clauses={clauses}>{(['usage_period_summary', 'usage_cost_facts', 'usage_daily', 'usage_breakdowns', 'usage_efficiency'] as const).map(id =>
        <UsageWidgetBody key={id} id={id} input={{ ...scope, metric: 'cost', breakdown: ['agent'], period: { startMs: 0, endMs: 172_800_000 } }} serverId={serverId} testID={id} />)}
      </UsageWidgetBatchProvider></CoreCollectionScope></InjectedAuthProvider>);
    try {
      await expect.poll(() => screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'usage_cost_facts.fact.estimated')?.props.value).toBe(2.4);
      expect(deliveries.length).toBeGreaterThan(0);
      for (const result of deliveries.flatMap(delivery => delivery.results)) {
        if ('error' in result) throw new Error(`Expected a successful accounting delivery: ${result.error}`);
        expect(result.value.contributions).toBeUndefined();
        expect(result.value.summary).toBeDefined();
      }
      const metrics = screen.findAllByType(HappierDataMetric);
      expect(metrics.find(metric => metric.props.testID === 'usage_period_summary.hero')?.props.value).toBe(unpriced ? '—' : 1.3048);
      expect(metrics.find(metric => metric.props.testID === 'usage_efficiency.perMtok')?.props.value).toBe(unpriced ? '—' : 1.3048);
      const rows = screen.findByType(RankedRows).props.rows as { id: string; value: number | null }[];
      expect(rows.find(row => row.id === 'codex')?.value).toBe(1.25);
      expect(rows.find(row => row.id === 'claude')?.value).toBe(0.0548);
      expect(rows.reduce((sum, row) => sum + (row.value ?? 0), 0)).toBe(1.3048);
      const chart = screen.findByType(StackedSeriesChart);
      const points = chart.props.series.flatMap((series: { points: { y: number | null }[] }) => series.points) as { y: number | null }[];
      expect(points.reduce((sum, point) => sum + (point.y ?? 0), 0)).toBe(1.3048);
    } finally { await screen.unmount(); }
  });
  it('strips chart own inputs from queries and selects only the metric evidence it needs', async () => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-chart-inputs.test', accountId: 'account-a' }],
      route: request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    let query: ReturnType<typeof useUsageWidgetModel>['query'] = null;
    let accountingViewAvailable: boolean | undefined;
    function AccountingProjection(props: { slice: NonNullable<UsageWidgetBodyModel['slice']>; query: NonNullable<ReturnType<typeof useUsageWidgetModel>['query']> }) {
      accountingViewAvailable = useUsageAnalyticsView(props.slice, props.query) !== null;
      return null;
    }
    type ChartWidget = 'usage_rhythm' | 'usage_orbit' | 'usage_atmosphere' | 'usage_machines' | 'usage_projects' | 'usage_breakdowns';
    function Probe(props: { metric: 'tokens' | 'busy'; style: string; widgetId: ChartWidget }) {
      const selected = useUsageWidgetModel({ ...scope, metric: props.metric, style: props.style, colourBy: 'intensity', day: '2026-10-21' }, props.widgetId);
      query = selected.query;
      return selected.query && selected.model.slice ? <AccountingProjection slice={selected.model.slice} query={selected.query} /> : null;
    }
    const view = (metric: 'tokens' | 'busy', style = 'sky', widgetId: ChartWidget = 'usage_rhythm') => <InjectedAuthProvider credentials={credentials}><UsageWidgetBatchProvider clauses={clauses}>
      <Probe metric={metric} style={style} widgetId={widgetId} /></UsageWidgetBatchProvider></InjectedAuthProvider>;
    const screen = await renderScreen(view('tokens'));
    try {
      await expect.poll(() => query?.metric).toBe('tokens');
      expect(query).toMatchObject({ includeSessionEvidence: false, includeTranscriptEvidence: false });
      await expect.poll(() => accountingViewAvailable).toBe(true);
      for (const key of ['style', 'colourBy', 'day']) expect(query).not.toHaveProperty(key);
      await screen.update(view('busy'));
      await expect.poll(() => query?.metric).toBe('busy');
      expect(query).toMatchObject({ includeSessionEvidence: true, includeTranscriptEvidence: false });
      await expect.poll(() => accountingViewAvailable).toBe(false);
      await screen.update(view('busy', 'heatmap'));
      await expect.poll(() => query?.includeSessionEvidence).toBe(false);
      await screen.update(view('busy', 'ninetyPlanets'));
      expect(query).toMatchObject({ includeSessionEvidence: false, includeTranscriptEvidence: false });
      await screen.update(view('tokens', 'moons', 'usage_orbit'));
      expect(query).toMatchObject({ includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
      await screen.update(view('tokens', '', 'usage_atmosphere'));
      expect(query).toMatchObject({ includeSessionEvidence: true, includeTranscriptEvidence: false, includeWorkEvidence: false });
      for (const widgetId of ['usage_machines', 'usage_projects'] as const) {
        await screen.update(view('tokens', '', widgetId));
        expect(query).toMatchObject({ includeAccounting: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
      }
      await screen.update(view('tokens', 'crew', 'usage_breakdowns'));
      expect(query).toMatchObject({ includeActivity: true, activityResolution: 'both', includeSeries: false,
        includeInsights: false, includeLeaders: false, includeModelTimeline: false, includeMessageStats: false, includeQuotaHistory: false });
      await screen.update(view('tokens', 'breakdowns', 'usage_breakdowns'));
      expect(query).toMatchObject({ includeActivity: false, includeQuotaHistory: false });
    } finally { await screen.unmount(); }
  });
  it.each([
    { metric: 'tokens', days: 7 }, { metric: 'cost', days: 7 },
    { metric: 'tokens', days: 14 }, { metric: 'cost', days: 14 },
  ] as const)('settles an accounting-only Agent river ($metric, $days days) without reading Session evidence', async ({ metric, days }) => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-river-settlement.test', accountId: 'account-a' }],
      route: request => request.path === '/v2/usage/query' ? Response.json(accounting)
        : request.path === '/v1/features' || request.path === '/v1/features/authenticated'
          ? Response.json(createRootLayoutFeaturesResponse())
          : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method, headers: request.headers }) ?? undefined });
    const serverId = home.homes.a!.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.resumeSync('server-reachable');
    // Account restoration has its own Session-list acquisition. The contract
    // below measures the subsequent accounting-only widget mount.
    await sync.refreshSessions({ awaitSessionListHydration: true });
    const beforeMount = home.requests.length;
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><UsageWidgetBatchProvider clauses={clauses}>
      <UsageWidgetBody id="usage_flow" serverId={serverId} testID="river" input={{ ...scope, metric, style: 'agentRiver',
        period: { startMs: Date.UTC(2026, 9, 26), endMs: Date.UTC(2026, 9, 26) + days * 86_400_000 }, breakdown: [] }} />
    </UsageWidgetBatchProvider></InjectedAuthProvider>);
    try {
      await flushHookEffects({ cycles: 30 });
      const mountRequests = home.requests.slice(beforeMount);
      expect(mountRequests.filter(request => request.path === '/v2/usage/query')).toHaveLength(1);
      expect(mountRequests.filter(request => request.path.includes('/sessions')),
        JSON.stringify(mountRequests.map(request => ({ method: request.method, path: request.path })))).toHaveLength(0);
      expect(screen.findByTestId('river.loading')).toBeNull();
      expect(screen.findByTestId(days === 7 ? 'river.needsData' : 'river.river')).not.toBeNull();
    } finally { await screen.unmount(); }
  });
  it('requests only the output sections consumed by mounted Usage bodies and their chart styles', async () => {
    type WidgetId = Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'>;
    const outputs = ['includeSeries', 'includeInsights', 'includeActivity', 'includeLeaders', 'includeModelTimeline', 'includeMessageStats', 'includeQuotaHistory', 'includeComparison'] as const;
    type Output = typeof outputs[number];
    const defaults = {
      usage_daily: ['includeSeries', 'includeModelTimeline'],
      usage_period_summary: ['includeInsights', 'includeMessageStats', 'includeComparison'],
      usage_cost_facts: [],
      usage_flow: ['includeSeries', 'includeModelTimeline'],
      usage_efficiency: ['includeInsights', 'includeComparison'],
      usage_breakdowns: [],
      usage_capacity: [],
      usage_projections: ['includeQuotaHistory'],
      usage_resets: ['includeQuotaHistory'],
      usage_plan_fit: ['includeActivity', 'includeQuotaHistory'],
      usage_project_ledger: [],
      usage_session_value: [],
      usage_outcomes: [],
      usage_coach: [],
      usage_rhythm: ['includeActivity', 'includeInsights'],
      usage_parallel: ['includeActivity'],
      usage_human_loop: [],
      usage_night_shift: ['includeActivity'],
      usage_recap: ['includeActivity', 'includeInsights', 'includeLeaders'],
      usage_footprint: [],
      usage_source_coverage: [],
      usage_unpriced: [],
      usage_score: ['includeActivity'],
      usage_orbit: ['includeActivity'],
      usage_constellation: ['includeActivity'],
      usage_planet: ['includeActivity'],
      usage_run_length: [],
      usage_atmosphere: ['includeActivity'],
      usage_machines: [],
      usage_projects: [],
    } satisfies Record<WidgetId, readonly Output[]>;
    const cases: readonly Readonly<{ id: WidgetId; style?: string; session?: string | string[]; reads: readonly Output[] }>[] = [
      ...Object.entries(defaults).map(([id, reads]) => ({ id: id as WidgetId, reads })),
      { id: 'usage_flow', style: 'agentRiver', reads: ['includeActivity'] },
      { id: 'usage_breakdowns', style: 'crew', reads: ['includeActivity'] },
      { id: 'usage_rhythm', style: 'sky', reads: ['includeActivity'] },
      { id: 'usage_rhythm', style: 'weekdayHour', reads: ['includeActivity', 'includeInsights'] },
      { id: 'usage_rhythm', style: 'ninetyPlanets', reads: ['includeActivity'] },
      { id: 'usage_parallel', style: 'timeline', reads: [] },
      { id: 'usage_recap', style: 'personalRecords', reads: ['includeActivity'] },
      { id: 'usage_recap', session: 'selected-session', reads: defaults.usage_recap },
      { id: 'usage_recap', session: ['selected-session'], reads: defaults.usage_recap },
      { id: 'usage_recap', session: ['first-session', 'second-session'], reads: defaults.usage_recap },
      { id: 'usage_recap', style: 'personalRecords', session: 'selected-session', reads: ['includeActivity'] },
      { id: 'usage_run_length', style: 'galaxy', reads: ['includeActivity'] },
    ];
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-rendered-output.test', accountId: 'account-a' }],
      route: request => request.path === '/v2/usage/query' ? Response.json(accounting)
        : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const serverId = home.homes.a!.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const runtime = { pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current' as const, interactionEnabled: true,
      machineId: null, serverId, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(),
      reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {} };
    let slices: ReturnType<typeof useUsageWidgetBatchSlices> = [];
    let inventory: ReturnType<typeof useUsageWidgetBatchInventorySlice>;
    function DemandProbe() { slices = useUsageWidgetBatchSlices(); inventory = useUsageWidgetBatchInventorySlice(); return null; }
    const pageQuery = resolveUsageWidgetPageInitialQuery({ nowMs: 1000, timeZoneOffsetMinutes: 0 });
    const inventoryQuery = normalizeUsageQuery({ ...pageQuery, period: { startMs: 0, endMs: 1000 }, breakdown: ['agent', 'machine', 'project', 'source'] });
    const view = (entry?: typeof cases[number]) => <InjectedAuthProvider credentials={credentials}><AppShellPluginUiProjectionValueProvider value={runtime}><CoreCollectionScope>
      <UsageWidgetBatchProvider clauses={readUsageWidgetQueryOverrides(pageQuery)} inventoryQuery={entry ? undefined : inventoryQuery} inventoryOnly={!entry}>
        <DemandProbe />{entry ? <UsageWidgetBody id={entry.id} input={{ ...scope, period: { startMs: 0, endMs: 1000 }, metric: 'tokens',
          ...(entry.style ? { style: entry.style } : {}), ...(entry.session ? { session: entry.session } : {}) }} serverId={serverId} testID="output-demand" /> : null}
      </UsageWidgetBatchProvider></CoreCollectionScope></AppShellPluginUiProjectionValueProvider></InjectedAuthProvider>;
    const screen = await renderScreen(view(cases[0]!));
    const allowanceOnly = new Set<WidgetId>(['usage_capacity', 'usage_projections', 'usage_resets', 'usage_atmosphere', 'usage_machines', 'usage_projects']);
    try {
      for (const entry of cases) {
        await screen.update(view(entry));
        await expect.poll(() => slices.map(slice => ({ ...Object.fromEntries(outputs.map(output => [output, slice.requestedQuery[output]])),
          includeAccounting: slice.requestedQuery.includeAccounting })),
          { message: `${entry.id} ${entry.style ?? 'default'} consumes only its declared output sections` })
          .toEqual([{ ...Object.fromEntries(outputs.map(output => [output, entry.reads.includes(output)])), includeAccounting: !allowanceOnly.has(entry.id) }]);
        if (entry.id === 'usage_period_summary') expect(slices[0]?.requestedQuery).toMatchObject({
          workProjection: 'summary', includeWorkEvidence: true, includeSessionEvidence: true, includeTranscriptEvidence: false,
        });
        if (entry.id === 'usage_recap') {
          const records = entry.style === 'personalRecords';
          const autopsy = !records && (typeof entry.session === 'string' || entry.session?.length === 1);
          expect(slices[0]?.requestedQuery).toMatchObject({ includeWorkEvidence: autopsy,
            includeSessionEvidence: records || autopsy, includeTranscriptEvidence: autopsy });
        }
      }
      await screen.update(view());
      await expect.poll(() => inventory?.requestedQuery).toMatchObject({
        ...Object.fromEntries(outputs.map(output => [output, false])), includeAccounting: true,
        includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
        breakdown: ['agent', 'machine', 'project', 'source'], period: { startMs: 0, endMs: 1000 },
      });
    } finally { await screen.unmount(); }
  });
  it('populates a Project Breakdowns preview with bounded facts outside the mounted Account page batch', async () => {
    // The reported Account has 32,975 usage events. The HTTP boundary owns the
    // raw rows; opening a ranked preview must deliver only its aggregate facts.
    const eventCount = 32_975;
    const totals = { ...accounting.totals, eventCount,
      tokens: { ...accounting.totals.tokens, input: eventCount * 10, output: eventCount * 5, total: eventCount * 15 },
      cost: { ...accounting.totals.cost, reportedUsd: eventCount } };
    const ranked: UsageAnalyticsQueryResponse = { ...accounting, totals,
      breakdowns: { agent: [{ key: 'codex', label: 'Codex', ...totals }] },
      contributions: Array.from({ length: eventCount }, (_, index) => ({ id: `preview-event-${index}`,
        observedAtMs: 1000, sessionId: null, turnId: null, agentId: 'codex', modelId: null,
        machineId: null, projectKey: 'destination-project', workspaceId: null, source: 'codex-native-accounting',
        tokens: accounting.totals.tokens, cost: accounting.totals.cost })) };
    const deliveries: UsageAnalyticsQueryBatchResponse[] = [];
    const features = createRootLayoutFeaturesResponse();
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-preview-isolation.test', accountId: 'account-a' }],
      route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated' ? Response.json(features)
        : request.path === '/v2/usage/query-batch' ? (() => {
        // Capability discovery and request selection stay real. This HTTP peer
        // serves exactly the projection the mounted preview actually requested.
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        const delivered = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
          results: input.queries.map(query => ({ query, value: repriceUsageAnalyticsResponse(
            query.filters?.projectKeys?.includes('destination-project') ? ranked : accounting) })),
        }, input, false));
        deliveries.push(delivered);
        return Response.json(delivered);
      })() : request.path === '/v2/usage/query' ? Response.json(
        UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.projectKeys?.includes('destination-project') ? ranked : accounting)
        : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const serverId = home.homes.a!.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { WidgetSetupPreview } = await import('@/components/widgets/surface/WidgetSetupPreview');
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { readWidgetDescriptor } = await import('@/components/widgets/widgetCatalog');
    const candidate = readWidgetDescriptor(null, { kind: 'builtin', id: 'usage_breakdowns' })!;
    const seen = new Map<string, UsageWidgetBodyModel>();
    let slices: ReturnType<typeof useUsageWidgetBatchSlices> = [];
    function Probe() { slices = useUsageWidgetBatchSlices(); return <Body name="account" metric="tokens" seen={seen} />; }
    const input = { ...scope, projects: ['destination-project'], metric: 'tokens', breakdown: ['agent'], style: 'breakdowns' };
    const runtime = { pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current' as const, interactionEnabled: true,
      machineId: null, serverId, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(),
      reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {} };
    const view = (preview: boolean) => <InjectedAuthProvider credentials={credentials}><AppShellPluginUiProjectionValueProvider value={runtime}><CoreCollectionScope>
      <UsageWidgetBatchProvider clauses={clauses}><Probe />{preview ? <WidgetSetupPreview candidate={candidate}
        scope={{ serverId, accountId: 'account-a', owner: { kind: 'project', projectId: 'destination-project' } }}
        providedContext={{ projects: [['destination-project']] }} draft={{ bindings: {
          ...Object.fromEntries(Object.entries(input).map(([path, value]) => [path, { kind: 'value' as const, value }])),
          projects: { kind: 'context', slot: 'projects' },
        } }} testID="project-preview" /> : null}</UsageWidgetBatchProvider>
    </CoreCollectionScope></AppShellPluginUiProjectionValueProvider></InjectedAuthProvider>;
    const screen = await renderScreen(view(false));
    try {
      await expect.poll(() => seen.get('account')?.slice?.accounting?.totals.eventCount).toBe(1);
      const entry = seen.get('account')!.slice!.key;
      await screen.update(view(true));
      await expect.poll(() => deliveries.some(delivery => delivery.results.some(result =>
        result.query.filters?.projectKeys?.includes('destination-project')))).toBe(true);
      const previewRequests = home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch')
        .map(request => UsageAnalyticsQueryBatchRequestSchema.parse(request.body))
        .filter(request => request.queries.some(query => query.filters?.projectKeys?.includes('destination-project')));
      expect(previewRequests.length).toBeGreaterThan(0);
      for (const request of previewRequests) {
        expect(request).toMatchObject({ includeContributions: false, contributionQueries: [] });
        for (const query of request.queries) expect(query).toMatchObject({ includeSeries: false, includeInsights: false,
          includeLeaders: false, includeModelTimeline: false, includeMessageStats: false, includeActivity: false });
      }
      for (const delivery of deliveries) {
        for (const result of delivery.results) if ('value' in result) expect(result.value).not.toHaveProperty('contributions');
        expect(delivery.contributionPages?.flatMap(page => page.rows) ?? []).toEqual([]);
      }
      await expect.poll(() => screen.findAllByType(UsageBreakdownsBody)[0]?.props.model.blocks)
        .toMatchObject([{ id: 'agent', rows: [{ id: 'codex', value: totals.tokens.total }] }]);
      expect(screen.findByType(UsageBreakdownsWidget).props.query.includeQuotaHistory).toBe(false);
      expect(slices.map(slice => slice.key)).toEqual([entry]);
      expect(slices[0]?.requestedQuery.projects).toEqual([]);
      await screen.update(view(false));
      expect(slices.map(slice => slice.key)).toEqual([entry]);
    } finally { await screen.unmount(); }
  });
  it('feeds Sources panels from one admitted accounting Resource through their real builtin dispatch', async () => {
    const value: UsageAnalyticsQueryResponse = { ...accounting,
      totals: { ...accounting.totals, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' } },
      contributions: [{ id: 'unpriced', sessionId: null, turnId: null, observedAtMs: 1, eventCount: 1,
        agentId: 'codex', modelId: null, machineId: null, projectKey: null, workspaceId: null,
        source: 'codex-native-accounting', sourceContext: { path: 'native', execution: 'outside' },
        tokens: accounting.totals.tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' } }],
      coverage: { status: 'partial', reasons: ['unpriced_tokens'], missingDimensions: [], range: { complete: false }, ranked: [],
        sources: [{ source: 'codex-native-accounting', path: 'native', status: 'partial', eventCount: 1, captureKind: 'from_logs' }] } };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-source-panels.test', accountId: 'account-a' }],
      route: request => request.path === '/v2/usage/query' ? Response.json(repriceUsageAnalyticsResponse(value)) : undefined });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
      <UsageWidgetBatchProvider clauses={clauses}>{(['usage_source_coverage', 'usage_unpriced'] as const).map(id =>
        <UsageWidgetBody key={id} id={id} input={{ ...scope, period: { startMs: 0, endMs: 1000 } }} serverId={home!.homes.a!.id} testID={id} />)}
      </UsageWidgetBatchProvider></CoreCollectionScope></InjectedAuthProvider>);
    await expect.poll(() => screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'usage_unpriced.tokens')?.props.value).toBe(15);
    expect(screen.findByType(HappierDataRows).props.rows).toHaveLength(1);
    expect(home.requests.filter(request => request.path === '/v2/sessions/read-batch'
      || request.path.endsWith('/messages') || request.path.endsWith('/turns'))).toEqual([]);
    await screen.unmount();
  });
  it('owns coverage from the first frame, before the inventory has answered', async () => {
    const seen: boolean[] = [];
    function CoverageProbe() { seen.push(useUsageWidgetPageHasCoverageDetail()); return null; }
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <UsageWidgetBatchProvider clauses={clauses}><CoverageProbe /></UsageWidgetBatchProvider>
    </InjectedAuthProvider>);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    await screen.update(<CoverageProbe />);
    expect(seen.at(-1)).toBe(false);
  });
  it.each(['usage_daily', 'usage_outcomes', 'usage_footprint', 'usage_source_coverage', 'usage_unpriced'] as const)('admits private evidence through the real %s body only when its projection consumes it', async narrowId => {
    const sessionReads = createSessionReadBatchHttpBoundary(request => {
        if (request.path === '/v2/usage/query') return Response.json(accounting);
        if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (request.path === '/v2/sessions/work') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'work',
          createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
          metadataVersion: 1, metadata: { path: '', host: '', name: 'work' }, agentStateVersion: 1 }) });
        if (request.path === '/v1/sessions/work/turns') return Response.json({ v: 1, sessionId: 'work', updatedAt: 900,
          turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
        if (request.path === '/v1/sessions/work/messages') return Response.json({ messages: [], hasMore: false });
        return undefined;
      });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-widget-demand.test', accountId: 'account-a' }],
      route: sessionReads.handle });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' },
      profile: AccountProfileSchema.parse({ id: 'account-a' }),
      sessions: { work: createSessionFixture({ id: 'work', serverId: home.homes.a!.id, encryptionMode: 'plain' }) } });
    let slices: ReturnType<typeof useUsageWidgetBatchSlices> = [];
    function EvidenceProbe() { slices = useUsageWidgetBatchSlices(); return null; }
    const body = (id: typeof narrowId | 'usage_period_summary' | 'usage_coach') => <InjectedAuthProvider credentials={credentials}>
      <CoreCollectionScope><UsageWidgetBatchProvider clauses={clauses}><EvidenceProbe /><UsageWidgetBody id={id}
        input={{ ...scope, period: { startMs: 0, endMs: 1000 }, metric: 'tokens', breakdown: [] }}
        serverId={home!.homes.a!.id} testID="widget-demand" /></UsageWidgetBatchProvider></CoreCollectionScope>
    </InjectedAuthProvider>;
    const screen = await renderScreen(body(narrowId));
    await expect.poll(() => home!.requests.filter(request => request.path === '/v2/usage/query').length).toBeGreaterThan(0);
    await flushHookEffects({ cycles: 30 });
    expect(home.requests.filter(request => request.method === 'POST' && request.path === '/v2/sessions/read-batch'
      || request.method === 'GET' && (request.path === '/v2/sessions/work' || request.path.startsWith('/v1/sessions/work/')))).toEqual([]);
    await screen.update(body('usage_period_summary'));
    await expect.poll(() => sessionReads.componentRequests.filter(request => request.method === 'GET' && request.path === '/v1/sessions/work/turns').length).toBe(1);
    await flushHookEffects({ cycles: 30 });
    expect(sessionReads.componentRequests.filter(request => request.method === 'GET' && request.path === '/v1/sessions/work/messages')).toHaveLength(0);
    expect(home.requests.filter(request => request.method === 'POST' && request.path === '/v2/sessions/read-batch').map(request => [request.method, request.body]))
      .toEqual([['POST', expect.objectContaining({ sessionIds: ['work'], includeSnapshot: true, includeMessages: false })]]);
    await expect.poll(() => slices.find(slice => slice.howYouWork)?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    expect(slices.find(slice => slice.howYouWork)?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: 'not_loaded' });
    await screen.update(body('usage_coach'));
    await expect.poll(() => sessionReads.componentRequests.filter(request => request.method === 'GET' && request.path === '/v1/sessions/work/messages').length).toBe(1);
    await flushHookEffects({ cycles: 30 });
    expect(sessionReads.componentRequests.filter(request => request.method === 'GET' && request.path === '/v2/sessions/work')).toHaveLength(1);
    expect(home.requests.filter(request => request.method === 'POST' && request.path === '/v2/sessions/read-batch').map(request => [request.method, request.body]))
      .toEqual([
        ['POST', expect.objectContaining({ sessionIds: ['work'], includeSnapshot: true, includeMessages: false })],
        ['POST', expect.objectContaining({ sessionIds: ['work'], includeSnapshot: false, includeMessages: true })],
      ]);
    expect(home.requests.filter(request => request.method === 'GET'
      && (request.path === '/v2/sessions/work' || request.path.startsWith('/v1/sessions/work/')))).toEqual([]);
    await expect.poll(() => slices.find(slice => slice.howYouWork)?.sources)
      .toContainEqual({ source: 'how_you_work:transcripts', status: 'available' });
  });

  it.each([false, true])('requests both consumed activity sections despite route includeActivity=%s and partial resolution, preserving independently pinned scope', async includeActivity => {
    const days = [{ date: '2026-10-08', eventCount: 1 }, { date: '2026-10-09', eventCount: 2 }, { date: '2026-10-10', eventCount: 1 }];
    const page = resolveUsageWidgetPageInitialQuery({ nowMs: Date.UTC(2026, 9, 11), timeZoneOffsetMinutes: 120,
      initialFilters: resolveUsagePageInitialFilters({ queryOverrides: JSON.stringify(readUsageWidgetQueryOverrides(normalizeUsageQuery({ includeActivity, activityResolution: 'weekdayHour' }))) }) });
    const input = { ...scope, period: { startMs: Date.UTC(2026, 9, 8), endMs: Date.UTC(2026, 9, 11) }, machines: ['pinned'], metric: 'tokens' as const, breakdown: [] };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-activity.test', accountId: 'account-a' }], route: request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return Response.json({ ...accounting, insights: { activeDays: 3, longestStreakDays: 3, sessionsUsed: 1,
        messagesUsed: 4, modelsTried: 0, favoriteModelChangeCount: 0 }, series: days.map((day, index) => ({ bucketStartMs: input.period.startMs + index * 86_400_000,
        bucketEndMs: input.period.startMs + (index + 1) * 86_400_000, eventCount: day.eventCount,
        tokens: accounting.totals.tokens, cost: accounting.totals.cost })), activity: query.includeActivity ? {
        calendarDays: query.activityResolution === 'weekdayHour' ? undefined : days,
        weekdayHourBuckets: query.activityResolution === 'calendar' ? undefined : [{ weekday: 4, hour: 12, eventCount: 4 }],
      } : undefined });
    } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    let observed: ReturnType<typeof useUsageWidgetModel> | undefined;
    function Probe() { observed = useUsageWidgetModel(input, 'usage_rhythm'); return null; }
    await renderScreen(<InjectedAuthProvider credentials={credentials}><UsageWidgetBatchProvider clauses={readUsageWidgetQueryOverrides(page)}>
      <Probe />
    </UsageWidgetBatchProvider></InjectedAuthProvider>);
    await flushHookEffects({ cycles: 30 });
    expect(observed?.query).toMatchObject({ includeActivity: true, activityResolution: 'both', includeSessionEvidence: false,
      machines: ['pinned'], period: input.period });
    expect(observed?.model.slice?.accounting?.activity).toEqual({ calendarDays: days,
      weekdayHourBuckets: [{ weekday: 4, hour: 12, eventCount: 4 }] });
    const view = buildUsageAnalyticsViewModel(observed!.model.slice!.accounting!, { period: 'all', metric: 'tokens', costMode: 'auto', focus: null });
    expect(view.overview.activeDays).toBe(view.activity.calendarDays.length);
    expect(view.overview.activeDays).toBe(3);
    expect(view.insights.activeDays).toBe(view.activity.calendarDays.length);
    expect(view.insights.activeDays).toBe(3);
  });
  it('keeps the period-qualified unfiltered scope inventory in the same batch as narrowed widgets', () => {
    const query = normalizeUsageQuery({ ...scope, agents: ['claude'], sources: ['runtime'], breakdown: ['model'] });
    const inventory = normalizeUsageQuery({ ...query, agents: [], sources: [], machines: [], projects: [], breakdown: ['agent', 'machine', 'project', 'source'] });
    const plan = buildUsageWidgetQueryPlan({ serverId: 'home', accountId: 'account' }, new Map(), inventory);
    expect(plan.input?.queries).toEqual([inventory]);
    expect(plan.widgets.size).toBe(0);
  });
  it('serves every mounted body from one batched read: equal queries share a slice, distinct ones stay keyed apart', async () => {
    const batches: string[][] = [];
    home = await serveAccountHomes({
      homes: [
        {
          key: 'a',
          serverUrl: 'https://usage-batch.test',
          accountId: 'account-a',
        },
      ],
      route: (request) => {
        if (request.path !== '/v2/usage/query') return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
        return Response.json(accounting);
      },
    });
    // This count is the mounted page's demand, not unrelated Home bootstrap.
    // Cold hydration/re-POST policy is covered by the Account stability owner.
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.refreshSessions();
    await sync.refreshMachines();
    publishAppliedActiveServerSnapshot({
      serverId: home.homes.a!.id,
      serverUrl: home.homes.a!.serverUrl,
      generation: 0,
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(
      home.homes.a!.serverUrl,
    ))!;
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' },
      settingsScope: { serverId: home.homes.a!.id, accountId: 'account-a' },
      profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const seen = new Map<string, UsageWidgetBodyModel>();
    await renderScreen(
      <InjectedAuthProvider credentials={credentials}>
        <UsageWidgetBatchProvider clauses={clauses as never}>
          <Body name="daily" metric="tokens" seen={seen} />
          <Body name="summary" metric="tokens" seen={seen} />
          <Body name="costs" metric="cost" seen={seen} />
          <BatchProbe batches={batches} />
        </UsageWidgetBatchProvider>
      </InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 30 });
    const daily = seen.get('daily')!;
    const summary = seen.get('summary')!;
    const costs = seen.get('costs')!;
    expect(daily.slice?.accounting?.totals.tokens.total).toBe(15);
    // Equal resolved requests are one keyed slice; a different own metric is its own slice.
    expect(summary.slice).toBe(daily.slice);
    expect(costs.slice).not.toBeNull();
    expect(costs.slice?.key).not.toBe(daily.slice?.key);
    // Both keyed slices are members of the one page batch value (one `usage.query`), not two reads.
    expect(new Set(batches.at(-1))).toEqual(new Set([daily.slice!.key, costs.slice!.key]));
    expect(home.httpRequests.filter(request => request.path === '/v2/usage/query-batch'),
      `one physical accounting batch serves this page view: ${JSON.stringify(home.httpRequests
        .filter(request => request.path === '/v2/usage/query-batch').map(request => request.body))}`).toHaveLength(1);
    expect(home.httpRequests.filter(request => request.path === '/v2/usage/query'
      || request.path === '/v2/sessions/read-batch' || request.path.endsWith('/messages'))).toHaveLength(0);
  });
});
