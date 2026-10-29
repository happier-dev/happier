import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import {
  UsageWidgetBatchProvider,
  useUsageWidgetBatchSlices,
  useUsageWidgetModel,
  useUsageWidgetPageHasCoverageDetail,
  buildUsageWidgetQueryPlan,
} from './usageWidgetBatch';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { readUsageWidgetQueryOverrides, resolveUsageWidgetPageInitialQuery } from '../usageWidgetPageContext';
import { resolveUsagePageInitialFilters } from '../usageRouteParams';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { UsageWidgetBody } from './UsageWidgetBody';
import { storage } from '@/sync/domains/state/storage';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { HappierDataMetric, HappierDataRows } from '@happier-dev/plugin-ui/presentation';
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
  }>,
) {
  const { model } = useUsageWidgetModel({
    ...scope,
    metric: props.metric,
    breakdown: [],
  }, 'usage_daily');
  props.seen.set(props.name, model);
  return null;
}

describe('Usage page batch', () => {
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
    type ChartWidget = 'usage_rhythm' | 'usage_orbit' | 'usage_atmosphere' | 'usage_machines' | 'usage_projects';
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
    } finally { await screen.unmount(); }
  });
  it('keeps a Project setup preview out of the mounted Account page batch', async () => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-preview-isolation.test', accountId: 'account-a' }],
      route: request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined });
    const serverId = home.homes.a!.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { WidgetSetupPreview } = await import('@/components/widgets/surface/WidgetSetupPreview');
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { readWidgetDescriptor } = await import('@/components/widgets/widgetCatalog');
    const candidate = readWidgetDescriptor(null, { kind: 'builtin', id: 'usage_daily' })!;
    const seen = new Map<string, UsageWidgetBodyModel>();
    let slices: ReturnType<typeof useUsageWidgetBatchSlices> = [];
    function Probe() { slices = useUsageWidgetBatchSlices(); return <Body name="account" metric="tokens" seen={seen} />; }
    const input = { ...scope, projects: ['destination-project'], metric: 'tokens' };
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
      await expect.poll(() => home!.requests.filter(request => request.path === '/v2/usage/query').some(request =>
        UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.projectKeys?.includes('destination-project'))).toBe(true);
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
      route: request => request.path === '/v2/usage/query' ? Response.json(value) : undefined });
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
    function Probe() { observed = useUsageWidgetModel(input, 'usage_daily'); return null; }
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
        if (request.path !== '/v2/usage/query') return undefined;
        return Response.json(accounting);
      },
    });
    publishAppliedActiveServerSnapshot({
      serverId: home.homes.a!.id,
      serverUrl: home.homes.a!.serverUrl,
      generation: 0,
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(
      home.homes.a!.serverUrl,
    ))!;
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
  });
});
