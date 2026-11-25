import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { buildProviderAccountUsageMaterialChangesV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { buildProviderAccountUsagePageProjectionV1, PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { sealProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { UsageAnalyticsQueryBatchRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { flattenWidgetLayoutWidgetsV1, WidgetLayoutItemsV1Schema, type UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { WidgetFrameDemandContext, WidgetFrameInstanceIdContext } from '@/components/widgets/frame/widgetFrameDemand';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { buildUsageWidgetPageInventoryQuery, readUsageWidgetPageContext, readUsageWidgetPageScope,
  readUsageWidgetQueryOverrides, resolveUsageWidgetPageInitialQuery } from '../usageWidgetPageContext';
import { createUsageWidgetPresets } from '../usageWidgetPresets';
import { UsageWidgetBody } from './UsageWidgetBody';
import { UsageWidgetBatchProvider, useUsageWidgetBatchSlices } from './usageWidgetBatch';
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

it.each(['Profile', 'descriptor catalog', 'late range', 'two cold ranges', 'late range after midnight'] as const)(
  'settles Plans quota without redundant admission: %s', async producer => {
    const crossesMidnight = producer === 'late range after midnight';
    const openedAtMs = crossesMidnight ? Date.UTC(2026, 10, 25, 23, 59, 50) : Date.UTC(2026, 10, 25, 12);
    let nowMs = openedAtMs;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const usesDescriptors = producer === 'descriptor catalog';
    const changesRange = producer === 'late range' || producer === 'two cold ranges' || crossesMidnight;
    const addedPeriod = { startMs: openedAtMs - 4 * 3600_000, endMs: openedAtMs + 3600_000 };
    const records = Array.from({ length: 18 }, (_, index) => {
      const accountId = `fixture-${index}`;
      const service = index >= 16 && usesDescriptors
        ? { pluginId: 'test.quota.provider', localId: 'delayed-provider' }
        : { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
      const ref = { service, accountId };
      const source = { bindingKind: 'account' as const, ref };
      const recordKey = { providerId: 'codex', accountSubjectId: accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
      const snapshot = index === 3 || index === 6 ? null : ProviderAccountUsageSnapshotV1Schema.parse({ v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: accountId },
        observedAtMs: nowMs - 100, fetchedAtMs: nowMs - 100, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed',
        state: 'loaded_data', meters: [{ meterId: 'weekly', label: 'Weekly', used: 20, limit: 100, utilizationPct: 20,
          unit: 'requests', resetsAt: nowMs + 360000, windowDurationMs: 3600000, status: 'ok', details: {} }] });
      const row = { ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] };
      const record = snapshot && { content: { t: 'plain', v: snapshot }, metadata: {
        fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' }, sources: [source] };
      return { source, snapshot, record, row };
    });
    const profile = (all: boolean) => AccountProfileSchema.parse({ id: 'account-a',
      connectedAccountsV4: records.slice(0, all ? 18 : 16).map(row => row.row) });
    let servedProfile = profile(usesDescriptors || changesRange);
    const held = createDeferred<void>();
    let accountingStarts = 0;
    const traffic: Array<{ route: string; recordId?: string; range?: unknown }> = [];
    const costs = () => ['resolve', 'record', 'day-summaries', 'history'].map(route => traffic.filter(row => row.route === route).length);
    const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
      tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
      cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://plans-replay.test', accountId: 'account-a',
      get profile() { return servedProfile; },
    }], route: async request => {
      if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path.startsWith('/v2/usage/query')) {
        accountingStarts++;
        await held.promise;
        if (request.path.endsWith('/query-batch')) {
          const batch = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
          return Response.json({ v: 1, results: batch.queries.map(query => ({ query, value: accounting })) });
        }
        return Response.json(accounting);
      }
      if (request.path.includes('/provider-account-usage/')) {
        const route = request.path.split('/').at(-1)!;
        const query = JSON.parse(request.url.searchParams.get('query') ?? 'null');
        const recordId = query?.recordId ?? request.url.searchParams.get('recordId') ?? undefined;
        if (request.method === 'GET') traffic.push({ route, recordId, range: query?.history?.range ?? query?.projection?.range });
        if (route === 'resolve') {
          const source = JSON.parse(request.url.searchParams.get('source')!);
          const row = records.find(record => record.source.ref.accountId === source.ref.accountId);
          if (!row?.snapshot) return Response.json(null);
          return Response.json({ source, recordId: row.snapshot.recordId,
            providerAccountId: row.source.ref.accountId, fetchedAt: nowMs - 100, staleAfterMs: 60_000 });
        }
        const row = records.find(row => row.snapshot?.recordId === recordId);
        if (route === 'record') return Response.json(row!.record);
        if (route === 'day-summaries') return Response.json({ summaries: [], missingDays: [] });
        if (route === 'history' && row?.snapshot) {
          const { snapshot, record } = row;
          if (query.projection) {
            const { range } = query.projection;
            const entries = snapshot.observedAtMs >= range.startAtMs && snapshot.observedAtMs < range.endAtMs
              ? [{ id: 'observation', observedAtMs: snapshot.observedAtMs, snapshot }] : [];
            const last = entries.at(-1);
            const projection = buildProviderAccountUsagePageProjectionV1({ recordId, range, history: { entries, nextCursor: null } });
            return Response.json({ complete: true, projection: { recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING,
              demand: query.projection, observationCount: entries.length, frontier: last ? { id: last.id, observedAtMs: last.observedAtMs } : null,
              content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection }) } });
          }
          return Response.json({ entries: [{ id: 'observation', observedAtMs: snapshot.observedAtMs, record }], nextCursor: null });
        }
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
    const scope = { serverId: server.id, accountId: 'account-a' };
    storage.setState({ profileScope: scope, profile: servedProfile });
    await getServerFeaturesSnapshot({ serverId: server.id, force: true });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl);
    const initial = resolveUsageWidgetPageInitialQuery({ initialFilters: { period: 'today', focus: null, costMode: 'auto', layoutId: 'plans' },
      nowMs, timeZoneOffsetMinutes: 0 });
    const pageScope = readUsageWidgetPageScope(initial);
    const clauses = readUsageWidgetQueryOverrides(initial);
    const inventoryQuery = buildUsageWidgetPageInventoryQuery(clauses, readUsageWidgetPageContext(pageScope));
    const widgets = flattenWidgetLayoutWidgetsV1(WidgetLayoutItemsV1Schema.parse(createUsageWidgetPresets().find(row => row.id === 'plans')!.items));
    let slices: readonly UsageQueryResultSlice[] = [];
    function Observe() { slices = useUsageWidgetBatchSlices(); return null; }
    function Body(props: React.ComponentProps<typeof UsageWidgetBody> & Readonly<{ instanceId: string }>) {
      const demand = React.useContext(WidgetFrameDemandContext);
      React.useLayoutEffect(() => demand?.place(props.instanceId, props.id, true), [demand, props.instanceId, props.id]);
      return <UsageWidgetBody {...props} />;
    }
    const page = (showAdditionalRange: boolean) => <InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
      <UsageWidgetBatchProvider clauses={clauses} inventoryQuery={inventoryQuery}
        queryWidgetIds={[...widgets.map(({ instance }) => instance.id), ...(showAdditionalRange ? ['additional-projections'] : [])]}>
        <Observe />
        {widgets.map(({ instance }) => {
          if (instance.definition.kind !== 'builtin') throw new Error('Expected builtin Plans preset');
          return <WidgetFrameInstanceIdContext.Provider key={instance.id} value={instance.id}>
            <Body instanceId={instance.id} id={instance.definition.id as UsageBuiltinWidgetIdV1} input={{ ...pageScope,
              ...Object.fromEntries(Object.entries(instance.bindings).flatMap(([key, value]) => value.kind === 'value' ? [[key, value.value]] : [])) }}
              serverId={server.id} testID={instance.id} />
          </WidgetFrameInstanceIdContext.Provider>;
        })}
        {showAdditionalRange && <WidgetFrameInstanceIdContext.Provider value="additional-projections">
          <Body instanceId="additional-projections" id="usage_projections" input={{ ...pageScope, period: addedPeriod }}
            serverId={server.id} testID="additional-projections" />
        </WidgetFrameInstanceIdContext.Provider>}
      </UsageWidgetBatchProvider>
    </CoreCollectionScope></InjectedAuthProvider>;
    if (changesRange) held.resolve();
    const screen = await renderScreen(page(producer === 'two cold ranges'));
    const refreshProfile = async () => {
      servedProfile = profile(true);
      const { fetchAndApplyProfile } = await import('@/sync/engine/account/syncAccount');
      await fetchAndApplyProfile({ credentials: credentials!, applyProfile: value => storage.getState().applyProfile(value) });
    };
    try {
      if (changesRange) {
        const settledRanges = () => new Set(slices.filter(slice => !slice.pending
          && slice.quota?.filter(row => row.pageFacts?.historyStatus === 'complete').length === 16)
          .map(slice => JSON.stringify(slice.requestedQuery.period))).size;
        await expect.poll(settledRanges).toBe(producer === 'two cold ranges' ? 2 : 1);
        await flushHookEffects({ cycles: 30 });
        if (producer !== 'two cold ranges') {
          expect(costs(), 'stock Plans').toEqual([18, 16, 16, 16]);
          const initialCosts = costs();
          if (crossesMidnight) nowMs += 20_000;
          await screen.update(page(true));
          await expect.poll(settledRanges).toBe(2);
          await flushHookEffects({ cycles: 30 });
          if (crossesMidnight) {
            const afterMidnight = traffic.filter(row => row.route === 'history'
              && JSON.stringify(row.range) === JSON.stringify({ startAtMs: Date.UTC(2026, 10, 26), endAtMs: nowMs }));
            expect(afterMidnight, "Today's old history must not settle the new day").toHaveLength(16);
            return;
          }
          expect(costs().map((count, index) => count - initialCosts[index]!),
            'additional range: resolves, current records, day summaries, history').toEqual([0, 0, 0, 16]);
        } else {
          expect(costs(), 'cold two-range view: resolves, current records, day summaries, history').toEqual([18, 16, 16, 32]);
        }
        const ranges = traffic.filter(row => row.route === 'history');
        expect(new Set(ranges.map(row => JSON.stringify(row.range))).size).toBe(2);
        expect(new Set(ranges.map(row => JSON.stringify([row.recordId, row.range]))).size).toBe(32);
        return;
      }
      await expect.poll(() => accountingStarts).toBeGreaterThan(0);
      await expect.poll(() => costs().slice(0, 3)).toEqual([16, 14, 14]);
      await expect.poll(() => slices.some(slice => slice.quota?.filter(q => q.current).length === 14)).toBe(true);
      expect(costs()).toEqual([16, 14, 14, 14]);
      nowMs += 13_200;
      // App shell qualification can publish after the first wave while the
      // page's long accounting response still owns the active Resource read.
      if (usesDescriptors) {
        const service = records.at(-1)!.source.ref.service;
        const descriptor = ConnectedAccountUiProjectionEntryV1Schema.parse({
          id: service.localId, serviceId: service.localId, pluginId: service.pluginId, title: service.localId,
          provenance: 'external', sourceKind: 'installed', diagnostics: [],
          authentication: { defaultModeId: 'api-key', modes: [{ id: 'api-key', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] },
          capabilities: ['usage'], availability: { state: 'available', reason: 'resolved' },
        });
        await act(async () => {
          installConnectedAccountDescriptorProjection({ scopeKey: server.id, status: 'ready',
            conflicts: [], errorReason: null, descriptors: [descriptor] }, captureActiveServerAccountScopeLifetime());
        });
      } else {
        await act(async () => refreshProfile());
      }
      await flushHookEffects({ cycles: 20 });
      expect(costs(), 'qualification is queued behind the active Plans read').toEqual([16, 14, 14, 14]);

      await act(async () => { held.resolve(); });
      await expect.poll(() => slices.some(slice => slice.accounting?.totals.eventCount === 1)
        && slices.every(slice => !slice.pending)
        && slices.some(slice => slice.quota?.filter(q => q.current).length === 16)).toBe(true);
      await flushHookEffects({ cycles: 30 });
      expect(costs(), 'resolve, head, summary and exact history each admit each source only once').toEqual([18, 16, 16, 16]);
      const history = traffic.filter(row => row.route === 'history');
      expect(new Set(history.map(row => JSON.stringify([row.recordId, row.range]))).size).toBe(16);
      expect(new Set(history.map(row => row.recordId)).size).toBe(16);
      expect(new Set(traffic.filter(row => row.route === 'record').map(row => row.recordId)).size).toBe(16);

      const recordId = records[0]!.snapshot!.recordId;
      const mark = traffic.length;
      await act(async () => {
        publishHomeAccountChange(server.id, buildProviderAccountUsageMaterialChangesV1(recordId).map(row => row.entityId),
          { changeKinds: ['account'], usageQueryAffects: true, usageAccountingAffects: false,
            providerAccountUsageRecordIds: [recordId] });
      });
      await expect.poll(() => costs()[1]).toBe(17);
      await flushHookEffects({ cycles: 30 });
      const wake = traffic.slice(mark);
      expect(wake.filter(row => row.route === 'resolve')).toEqual([]);
      expect(wake.filter(row => row.route === 'record')).toEqual([{ route: 'record', recordId, range: undefined }]);
      expect(wake.every(row => row.recordId === recordId)).toBe(true);
    } finally {
      held.resolve();
      await screen.unmount();
    }
  },
);
