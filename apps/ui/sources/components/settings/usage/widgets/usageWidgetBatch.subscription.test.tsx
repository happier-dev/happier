import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryBatchRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery } from '@happier-dev/protocol/usage/usageCost';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { storage } from '@/sync/domains/state/storage';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { readUsageWidgetQueryOverrides } from '../usageWidgetPageContext';
import { UsageWidgetBatchProvider, useUsageWidgetBatchCostBasisOptions, useUsageWidgetBatchInventorySlice, useUsageWidgetModel } from './usageWidgetBatch';
import * as usageWidgetBatch from './usageWidgetBatch';
import { UsageWidgetBody } from './UsageWidgetBody';
import { WidgetFrameDemandContext, WidgetFrameInstanceIdContext } from '@/components/widgets/frame/widgetFrameDemand';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { createUsageWidgetPresets } from '../usageWidgetPresets';
import { flattenWidgetLayoutWidgetsV1, type UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { QualifiedConnectedServiceUsageSourceResolveV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { USAGE_COACH_DETECTOR_IDS } from '@happier-dev/protocol/usage/coach/coachDetectorIds';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  await home?.dispose();
  home = undefined;
  vi.restoreAllMocks();
});

it('keeps real How bodies quiet while unrelated current quota answers and Coach preferences arrive', async () => {
  const nowMs = Date.UTC(2026, 10, 7, 12);
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  const originalCoachPreferences = storage.getState().settings.usageCoachPreferencesV1;
  const { ProviderAccountUsageSnapshotV1Schema, buildProviderAccountUsageRecordId } = await import('@happier-dev/protocol/connect/account-usage-primitives');
  const { UsageSessionEvidenceRequestSchema, USAGE_SESSION_EVIDENCE_PATH } = await import('@happier-dev/protocol/usage/usageSessionEvidence');
  const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
  const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
  let eventCount = 1;
  let failAccounting = false;
  const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
  const quotas = ['first', 'second'].map(accountId => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId };
    const recordKey = { providerId: 'codex', accountSubjectId: accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: accountId }, observedAtMs: nowMs,
      fetchedAtMs: nowMs, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] });
    return { ref, snapshot, held: createDeferred<void>(), issued: false };
  });
  const profile = AccountProfileSchema.parse({ id: 'account-a', connectedAccountsV4: quotas.map(({ ref }) => ({ ref,
    status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
    credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) });
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-real-body-quota.test', accountId: 'account-a', profile }],
    route: async request => {
      if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') return failAccounting ? Response.json({ error: 'accounting_refused' }, { status: 403 })
        : Response.json({ ...accounting, totals: { ...accounting.totals, eventCount } });
      if (request.path === '/v2/usage/query-batch') {
        if (failAccounting) return Response.json({ error: 'accounting_refused' }, { status: 403 });
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        return Response.json(collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
          results: input.queries.map(query => ({ query, value: { ...accounting, totals: { ...accounting.totals, eventCount } } })),
        }, input, false)));
      }
      if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
        const input = UsageSessionEvidenceRequestSchema.parse(request.body);
        return Response.json({ requests: input.requests.map(row => ({ query: row.query, sessionIds: [] })), results: [] });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        const source = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedServiceUsageSourceResolveV4Schema, request.url.searchParams.get('source'));
        const quota = source.bindingKind === 'account' ? quotas.find(row => row.ref.accountId === source.ref.accountId) : undefined;
        if (!quota) throw new Error('Unexpected quota source');
        return Response.json({ source, recordId: quota.snapshot.recordId, providerAccountId: quota.ref.accountId,
          fetchedAt: nowMs, staleAfterMs: 60_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        const quota = quotas.find(row => row.snapshot.recordId === request.url.searchParams.get('recordId'))!;
        quota.issued = true;
        await quota.held.promise;
        return Response.json({ content: { t: 'plain', v: quota.snapshot }, metadata: { fetchedAt: nowMs, staleAfterMs: 60_000, status: 'ok' },
          sources: [{ bindingKind: 'account', ref: quota.ref }] });
      }
      if (request.path === '/v1/account/entity-rows/connected-metadata/presentation'
        || request.path === '/v1/account/entity-rows/connected-metadata/acknowledgements')
        return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } });
      return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
    } });
  const server = home.homes.a!;
  const { sync } = await import('@/sync/sync');
  await sync.awaitBootstrapForegroundAcquisition();
  await sync.refreshSessions();
  await sync.refreshMachines();
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
    profile });
  await getServerFeaturesSnapshot({ serverId: server.id, force: true });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl);
  const models = new Map<string, UsageWidgetBodyModel>();
  const executions = new Map<string, number>();
  const changes = new Map<string, string[]>();
  const readModel = usageWidgetBatch.useUsageWidgetModel;
  // Observe the real body's hook entry, retaining every hook, source and presentation decision.
  vi.spyOn(usageWidgetBatch, 'useUsageWidgetModel').mockImplementation((input, widgetId) => {
    const id = React.useContext(WidgetFrameInstanceIdContext)!;
    const result = readModel(input, widgetId);
    const previous = models.get(id);
    executions.set(id, (executions.get(id) ?? 0) + 1);
    changes.set(id, previous ? [...new Set([
      ...Object.keys(result.model).filter(key => result.model[key as keyof UsageWidgetBodyModel] !== previous[key as keyof UsageWidgetBodyModel]),
      ...Object.keys(result.model.slice ?? {}).filter(key => result.model.slice?.[key as keyof NonNullable<UsageWidgetBodyModel['slice']>] !== previous.slice?.[key as keyof NonNullable<UsageWidgetBodyModel['slice']>]).map(key => `slice.${key}`),
    ])] : []);
    models.set(id, result.model);
    return result;
  });
  const presetWidgets = flattenWidgetLayoutWidgetsV1(createUsageWidgetPresets().find(row => row.id === 'how-you-work')!.items);
  // The same sky presentation also has admitted accounting-only measures.
  const widgets = [...presetWidgets, ...['tokens', 'cost'].map(metric => ({ ...presetWidgets[0]!, instance: {
    ...presetWidgets[0]!.instance, id: `accounting-${metric}`, bindings: { ...presetWidgets[0]!.instance.bindings,
      metric: { kind: 'value' as const, value: metric } },
  } }))];
  const clauses = readUsageWidgetQueryOverrides(normalizeUsageQuery({ granularity: 'day', timeZoneOffsetMinutes: 0 }));
  function QuotaReader() { useConnectedServiceQuotaSnapshots(quotas.map(({ ref }) => ({ ref })), { fetchPolicy: 'once' }); return null; }
  let rawSlices: readonly UsageQueryResultSlice[] = [];
  function SourceObserver() { rawSlices = usageWidgetBatch.useUsageWidgetBatchSlices(); return null; }
  function PlacedBody(props: React.ComponentProps<typeof UsageWidgetBody> & Readonly<{ instanceId: string }>) {
    const demand = React.useContext(WidgetFrameDemandContext);
    React.useLayoutEffect(() => demand?.place(props.instanceId, props.id, true), [demand, props.instanceId, props.id]);
    return <UsageWidgetBody {...props} />;
  }
  const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
    <QuotaReader />
    <UsageWidgetBatchProvider clauses={clauses} queryWidgetIds={widgets.map(row => row.instance.id)}>
      <SourceObserver />
      {widgets.map(({ instance }) => {
        if (instance.definition.kind !== 'builtin') throw new Error('Expected builtin Usage preset');
        return <WidgetFrameInstanceIdContext.Provider key={instance.id} value={instance.id}>
          <PlacedBody instanceId={instance.id} id={instance.definition.id as UsageBuiltinWidgetIdV1} input={{ period: { relative: '90days' },
            ...Object.fromEntries(Object.entries(instance.bindings).flatMap(([key, binding]) => binding.kind === 'value' ? [[key, binding.value]] : [])) }}
            serverId={server.id} testID={instance.id} />
        </WidgetFrameInstanceIdContext.Provider>;
      })}
    </UsageWidgetBatchProvider></CoreCollectionScope></InjectedAuthProvider>);
  try {
    await expect.poll(() => quotas.every(row => row.issued)).toBe(true);
    await expect.poll(() => models.size === widgets.length && [...models.values()].every(model => model.slice?.accounting
      && (!model.slice.shownQuery.includeSessionEvidence
        || model.slice.sources.some(source => source.source === 'how_you_work' && source.status !== 'pending')))).toBe(true);
    for (const metric of ['tokens', 'cost']) expect(models.get(`accounting-${metric}`)?.pending,
      `${metric}: accounting-only chart settles while unused private and quota sources are outstanding`).toBe(false);
    await flushHookEffects({ cycles: 30 });
    for (const quota of quotas) {
      const before = new Map(executions);
      changes.clear();
      await act(async () => { quota.held.resolve(); });
      await expect.poll(() => rawSlices.some(slice => slice.quota?.some(read => read.current?.recordId === quota.snapshot.recordId))).toBe(true);
      await flushHookEffects({ cycles: 50 });
      const rendered = Object.fromEntries([...executions].map(([id, count]) => [id, count - before.get(id)!]));
      console.info('USAGE-REAL-BODY-QUOTA', JSON.stringify({ source: quota.ref.accountId, rendered, changes: Object.fromEntries(changes) }));
      for (const [id, count] of Object.entries(rendered)) expect.soft(count, `${id}: quota publication does not execute a How body`).toBe(0);
    }
    const beforeCoachPreferences = new Map(executions);
    const priorSlices = new Map(rawSlices.map(slice => [slice.key, slice]));
    const detectorId = USAGE_COACH_DETECTOR_IDS.find(id => !originalCoachPreferences.disabledChecks.includes(id))!;
    changes.clear();
    await act(async () => { storage.getState().applySettingsLocal({ usageCoachPreferencesV1: { ...originalCoachPreferences,
      disabledChecks: [...originalCoachPreferences.disabledChecks, detectorId] } }); });
    await expect.poll(() => rawSlices.some(slice => slice.shownQuery.includeSessionEvidence) && rawSlices
      .filter(slice => slice.shownQuery.includeSessionEvidence).every(slice =>
        slice.coach?.evaluations.some(row => row.detectorId === detectorId && row.status === 'disabled'))).toBe(true);
    await flushHookEffects({ cycles: 30 });
    for (const slice of rawSlices) expect(slice.howYouWork, 'Coach-only preference retains the real private projection').toBe(priorSlices.get(slice.key)?.howYouWork);
    const preferenceRenders = Object.fromEntries([...executions].map(([id, count]) => [id, count - beforeCoachPreferences.get(id)!]));
    console.info('USAGE-REAL-BODY-COACH-PREFERENCE', JSON.stringify({ rendered: preferenceRenders, changes: Object.fromEntries(changes) }));
    for (const [id, count] of Object.entries(preferenceRenders)) expect.soft(count, `${id}: Coach-only preferences do not execute a How body`).toBe(0);
    const beforeAccounting = new Map(executions);
    eventCount = 2;
    await act(async () => { await models.values().next().value!.refresh(); });
    await expect.poll(() => [...models.values()].every(model => model.slice?.accounting?.totals.eventCount === 2)).toBe(true);
    for (const [id, count] of executions) expect(count - beforeAccounting.get(id)!, `${id}: real accounting still executes its body`).toBeGreaterThan(0);
    failAccounting = true;
    await act(async () => { await models.values().next().value!.refresh(); });
    await expect.poll(() => [...models.values()].every(model => model.error !== null)).toBe(true);
  } finally {
    storage.setState(state => ({ settings: { ...state.settings, usageCoachPreferencesV1: originalCoachPreferences } }));
    for (const quota of quotas) quota.held.resolve(); await screen.unmount();
  }
});

it('updates filter inventory without rendering an unchanged visible widget', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(2_000);
  const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
  const scope = { period: { startMs: 1_000, endMs: 2_000 }, agents: [], machines: [], projects: [],
    sources: [], session: null, costBasis: 'auto' } as const;
  const clauses = readUsageWidgetQueryOverrides(normalizeUsageQuery({ granularity: 'day', timeZoneOffsetMinutes: 0 }));
  const inventoryRead = createDeferred<Response>();
  const heldRead = createDeferred<Response>();
  let eventCount = 1;
  let estimatedUsd = 0;
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-inventory-render.test', accountId: 'account-a' }],
    route: request => {
      if (request.path !== '/v2/usage/query') return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
      const input = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return input.filters?.agentIds?.some(id => id === 'claude' || id === 'codex')
        ? Response.json({ ...accounting, totals: { ...accounting.totals, eventCount,
          cost: { ...accounting.totals.cost, estimatedUsd } } })
        : (input.filters?.agentIds?.includes('held') ? heldRead : inventoryRead).promise.then(response => response.clone());
    } });
  const server = home.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
    profile: AccountProfileSchema.parse({ id: 'account-a' }) });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl);
  const inventoryQuery = normalizeUsageQuery({ ...scope, includeComparison: false });
  const renders = new Map<string, number>();
  const models = new Map<string, UsageWidgetBodyModel>();
  let inventory: ReturnType<typeof useUsageWidgetBatchInventorySlice>;
  let costChoices: ReturnType<typeof useUsageWidgetBatchCostBasisOptions> = [];
  let costChoiceRenders = 0;
  function CostChoices() { costChoiceRenders++; costChoices = useUsageWidgetBatchCostBasisOptions(); return null; }
  function Widget(props: Readonly<{ agent: string }>) {
    renders.set(props.agent, (renders.get(props.agent) ?? 0) + 1);
    models.set(props.agent, useUsageWidgetModel({ ...scope, agents: [props.agent], metric: 'tokens', breakdown: [] }, 'usage_daily').model);
    return null;
  }
  function Inventory() { inventory = useUsageWidgetBatchInventorySlice(); return null; }
  function Held() { useUsageWidgetModel({ ...scope, agents: ['held'], metric: 'tokens', breakdown: [] }, 'usage_daily'); return null; }
  const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
    <UsageWidgetBatchProvider clauses={clauses} inventoryQuery={inventoryQuery}><Widget agent="claude" /><Widget agent="codex" /><Inventory /><CostChoices /><Held /></UsageWidgetBatchProvider>
  </InjectedAuthProvider>);
  try {
    await expect.poll(() => [...models.values()].every(model => model.slice?.accounting?.totals.eventCount === 1)).toBe(true);
    await flushHookEffects({ cycles: 20 });
    const before = new Map(renders);
    const slices = new Map([...models].map(([id, model]) => [id, model.slice]));
    await act(async () => { inventoryRead.resolve(Response.json({ ...accounting, totals: { ...accounting.totals, eventCount: 3_423 } })); });
    await expect.poll(() => inventory?.accounting?.totals.eventCount).toBe(3_423);
    await flushHookEffects({ cycles: 20 });
    for (const [id, model] of models) {
      expect(model.slice).toBe(slices.get(id));
      expect(renders.get(id)! - before.get(id)!, `${id}: inventory progress renders zero unchanged widgets while a sibling is still reading`).toBe(0);
    }
    const inventoryRendersByWidget = Object.fromEntries([...renders].map(([id, count]) => [id, count - before.get(id)!]));
    // The quiet path must still carry an actual changed accounting result to both consumers.
    heldRead.resolve(Response.json(accounting));
    await flushHookEffects({ cycles: 20 });
    eventCount = 2;
    const beforeChange = new Map(renders);
    const beforeCostChoiceChange = costChoiceRenders;
    await act(async () => { await models.get('claude')!.refresh(); });
    await expect.poll(() => [...models.values()].every(model => model.slice?.accounting?.totals.eventCount === 2)).toBe(true);
    for (const [id, model] of models) {
      expect(model.slice).not.toBe(slices.get(id));
      expect(renders.get(id)! - beforeChange.get(id)!, `${id}: changed accounting renders its consumer`).toBeGreaterThan(0);
    }
    expect.soft(costChoiceRenders - beforeCostChoiceChange, 'unchanged cost choices do not execute chrome for changed accounting counts').toBe(0);
    console.info('USAGE-INVENTORY-SUBSCRIPTION', JSON.stringify({ inventoryRendersByWidget,
      unchangedCostChoiceRenders: costChoiceRenders - beforeCostChoiceChange,
      changedRendersByWidget: Object.fromEntries([...renders].map(([id, count]) => [id, count - beforeChange.get(id)!])) }));
    estimatedUsd = 2;
    const beforeCostModeChange = costChoiceRenders;
    await act(async () => { await models.get('claude')!.refresh(); });
    await expect.poll(() => costChoices.includes('estimated')).toBe(true);
    expect(costChoiceRenders - beforeCostModeChange, 'a newly available cost mode reaches its choice consumer').toBeGreaterThan(0);
  } finally { inventoryRead.resolve(Response.json(accounting)); heldRead.resolve(Response.json(accounting)); await screen.unmount(); }
});
