import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { buildProviderAccountUsageMaterialChangesV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import { buildConnectedServicesAccountChangeV1, CHANGES_AFTER_CURSOR_HTTP_HEADER } from '@happier-dev/protocol/changes';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
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
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
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

it.each(['Profile', 'descriptor catalog'])(
  'settles stock Plans without re-admitting unchanged quota when the %s qualifies two late sources', async producer => {
    const openedAtMs = Date.UTC(2026, 10, 25, 12);
    let nowMs = openedAtMs;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const usesDescriptors = producer === 'descriptor catalog';
    const records = Array.from({ length: 18 }, (_, index) => {
      const accountId = `fixture-${index}`;
      const service = index >= 16
        ? usesDescriptors ? { pluginId: 'test.quota.provider', localId: 'delayed-provider' }
          : { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }
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
    let servedProfile = profile(usesDescriptors);
    const held = createDeferred<void>();
    let accountingHold = held;
    let changes: ApiChangeEntry[] = [];
    let cursor = 0;
    const machineId = 'fixture-machine';
    let machine = createMachineFixture({ id: machineId, active: false, activeAt: nowMs, presenceProtocolVersion: 1 });
    const machineRow = () => createPlainMachineRowFixture({ id: machineId, accountId: 'account-a', machine });
    let accountingStarts = 0;
    const traffic: Array<{ route: string; recordId?: string; range?: unknown; ref?: unknown }> = [];
    const costs = () => ['resolve', 'record', 'day-summaries', 'history'].map(route => traffic.filter(row => row.route === route).length);
    const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
      tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
      cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://plans-replay.test', accountId: 'account-a',
      get profile() { return servedProfile; },
    }], route: async request => {
      if (request.path === '/v2/cursor') return Response.json({ cursor, changesFloor: 0 });
      if (request.path === '/v2/changes') {
        const header = request.headers.get(CHANGES_AFTER_CURSOR_HTTP_HEADER);
        const after = Number(header ?? request.url.searchParams.get('after'));
        return Response.json({ changes: changes.filter(row => row.cursor > after), nextCursor: cursor }, {
          headers: header === null ? {} : { [CHANGES_AFTER_CURSOR_HTTP_HEADER]: header },
        });
      }
      if (request.path === '/v1/machines') return Response.json([machineRow()]);
      if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
        id => id === machineId ? machineRow() : null);
      if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path.startsWith('/v2/usage/query')) {
        accountingStarts++;
        await accountingHold.promise;
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
        if (route === 'resolve') {
          const source = JSON.parse(request.url.searchParams.get('source')!);
          traffic.push({ route, recordId, range: query?.history?.range, ref: source.ref });
          const row = records.find(record => record.source.ref.accountId === source.ref.accountId);
          if (!row?.snapshot) return Response.json(null);
          return Response.json({ source, recordId: row.snapshot.recordId,
            providerAccountId: row.snapshot.recordKey.accountSubjectId, fetchedAt: nowMs - 100, staleAfterMs: 60_000 });
        }
        traffic.push({ route, recordId, range: query?.history?.range });
        const row = records.find(row => row.snapshot?.recordId === recordId);
        if (route === 'record') return Response.json(row!.record);
        if (route === 'day-summaries') return Response.json({ summaries: [], missingDays: [] });
        if (route === 'history') return Response.json({ entries: row?.snapshot ? [{ id: 'observation',
          observedAtMs: row.snapshot.observedAtMs, record: row.record }] : [], nextCursor: null });
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
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
      <UsageWidgetBatchProvider clauses={clauses} inventoryQuery={inventoryQuery}
        queryWidgetIds={widgets.map(({ instance }) => instance.id)}>
        <Observe />
        {widgets.map(({ instance }) => {
          if (instance.definition.kind !== 'builtin') throw new Error('Expected builtin Plans preset');
          return <WidgetFrameInstanceIdContext.Provider key={instance.id} value={instance.id}>
            <Body instanceId={instance.id} id={instance.definition.id as UsageBuiltinWidgetIdV1} input={{ ...pageScope,
              ...Object.fromEntries(Object.entries(instance.bindings).flatMap(([key, value]) => value.kind === 'value' ? [[key, value.value]] : [])) }}
              serverId={server.id} testID={instance.id} />
          </WidgetFrameInstanceIdContext.Provider>;
        })}
      </UsageWidgetBatchProvider>
    </CoreCollectionScope></InjectedAuthProvider>);
    const refreshProfile = async () => {
      servedProfile = profile(true);
      const { fetchAndApplyProfile } = await import('@/sync/engine/account/syncAccount');
      await fetchAndApplyProfile({ credentials: credentials!, applyProfile: value => storage.getState().applyProfile(value) });
    };
    try {
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
      expect(new Set(history.map(row => JSON.stringify(row.range))).size).toBe(1);
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

      const named = [0, 1, 2, 4].map(index => records[index]!.snapshot!.recordId);
      const [global, exact] = buildProviderAccountUsageMaterialChangesV1(named[3]!, {
        dayStartAtMs: openedAtMs - 12 * 3600_000, afterCursor: 1, publication: { kind: 'summary', afterCursor: 1 },
      });
      const mixedPage = [
        { kind: 'session', entityId: 'fixture-session' },
        ...named.slice(0, 3).map(id => buildProviderAccountUsageMaterialChangesV1(id)[1]),
        { kind: 'machine', entityId: machineId },
        global, exact,
      ];
      const consume = async (rows: readonly Pick<ApiChangeEntry, 'kind' | 'entityId' | 'hint'>[]) => {
        changes = rows.map(row => ({ ...row, cursor: ++cursor, changedAt: nowMs }));
        await act(async () => { await sync.resumeSync('socket-reconnect'); });
      };
      const bindingTargets = records.slice(16);
      const beforeProfile = structuredClone(servedProfile.connectedAccountsV4);
      const originalBindings = bindingTargets.map(row => row.snapshot!.recordId);
      const rebound = bindingTargets[0]!;
      for (const cause of ['equal profile', 'equal binding', 'changed binding'] as const) {
        nowMs++;
        accountingHold = createDeferred<void>();
        const before = traffic.length;
        const beforeAccounting = accountingStarts;
        await consume([{ kind: 'session', entityId: 'fixture-session' }]);
        await expect.poll(() => accountingStarts).toBeGreaterThan(beforeAccounting);
        if (cause === 'equal profile') {
          // An unchanged Profile may be materialized while an accounting read is still outstanding.
          await act(async () => refreshProfile());
        } else {
          if (cause === 'changed binding') {
            const previous = rebound.snapshot!;
            const recordKey = { ...previous.recordKey, accountSubjectId: 'fixture-rebound' };
            rebound.snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ ...previous, recordKey,
              recordId: buildProviderAccountUsageRecordId(recordKey), accountSubject: { kind: 'providerSubject', id: 'fixture-rebound' } });
            rebound.record = { ...rebound.record!, content: { t: 'plain', v: rebound.snapshot } };
          }
          await consume([buildConnectedServicesAccountChangeV1(rebound.source.ref.service)]);
        }
        machine = { ...machine, active: !machine.active, activeAt: nowMs, updatedAt: nowMs };
        await consume(mixedPage);
        await act(async () => accountingHold.resolve());
        await expect.poll(() => traffic.slice(before).filter(row => row.route === 'record').length).toBeGreaterThanOrEqual(named.length);
        await expect.poll(() => slices.every(slice => !slice.pending)).toBe(true);
        await flushHookEffects({ cycles: 30 });
        const mixed = traffic.slice(before);
        console.info('M68 fixture costs', { producer, cause, costs: ['resolve', 'record', 'day-summaries', 'history']
          .map(route => mixed.filter(row => row.route === route).length) });
        expect(servedProfile.connectedAccountsV4).toEqual(beforeProfile);
        expect(storage.getState().profile.connectedAccountsV4).toEqual(beforeProfile);
        const bindings = bindingTargets.map(row => row.snapshot!.recordId);
        expect(bindings).toEqual(cause === 'changed binding' ? [rebound.snapshot!.recordId, originalBindings[1]] : originalBindings);
        const expected = cause === 'changed binding' ? [...named, rebound.snapshot!.recordId] : named;
        expect.soft(mixed.filter(row => row.route === 'resolve').map(row => JSON.stringify(row.ref)).sort()).toEqual(
          cause === 'equal profile' ? [] : bindingTargets.map(row => JSON.stringify(row.source.ref)).sort());
        for (const route of ['record', 'day-summaries', 'history']) {
          expect.soft(mixed.filter(row => row.route === route).map(row => row.recordId).sort(), `${cause}: ${route}`)
            .toEqual([...expected].sort());
        }
        expect(slices.some(slice => slice.quota?.some(quota => quota.current?.recordId === rebound.snapshot!.recordId))).toBe(true);
      }
    } finally {
      held.resolve();
      accountingHold.resolve();
      await screen.unmount();
    }
  },
);
