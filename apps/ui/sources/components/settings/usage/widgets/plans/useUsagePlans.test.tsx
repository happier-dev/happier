import { afterEach, expect, it } from 'vitest';
import * as React from 'react';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDeferred, renderHook, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { useUsagePlans, useUsagePoolSelections, useUsageSelectorMachineId } from './useUsagePlans';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { act } from 'react-test-renderer';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { QualifiedConnectedServiceUsageSourceV4Schema, QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { refreshConnectedMetadataCatalog } from '@/sync/engine/settings/connectedMetadataCatalogEngine';
import { CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, CONNECTED_PRESENTATION_ROWS_ROUTE_V1, ConnectedPresentationRecordV1Schema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { ConnectedServiceQuotaGetResultV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { createAppShellPluginUiProjectionPublication } from '@/components/appShell/plugins/appShellPluginUiProjectionPublication';
import { createPluginAccountAvailabilityReaderStore } from '@/sync/domains/plugins/availability/reader';
import { PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { advanceConnectedAccountDescriptorProjectionState, createConnectedAccountDescriptorProjectionLoadingState } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { getConnectedServiceRegistrySnapshot, isConnectedServiceUsageCapable } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); clearMachineRequestReachabilityForTest(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

it.each([
  ['plan fit', true, false], ['quota only', false, false], ['admitted first mount', true, true],
] as const)('reads a persisted personal price on a fresh Plans Resource (%s) without label-driven quota demand', async (_surface, includeAccounting, admittedFirstMount) => {
  const { useUsageWidgetResource, useUsageWidgetBodyModel } = await import('../../useUsageWidgetResource');
  const { getUsageQueryKey, getUsageQueryBatchKey } = await import('@happier-dev/protocol/inputs/usageQuery');
  const { ProviderAccountUsageSnapshotV1Schema } = await import('@happier-dev/protocol/connect/account-usage-primitives');
  const { ProviderAccountUsagePageProjectionWriteV1Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageHistory');
  const now = Date.now();
  const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'priced-plan' };
  const source = { bindingKind: 'account' as const, ref };
  const profile = AccountProfileSchema.parse({ id: 'priced-plans', connectedAccountsV4: [{ ref, status: 'connected',
    authenticationModeId: 'manual', revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
    configurationReady: false, configurationRevision: null, scopes: [], displayName: 'Personal plan' }] });
  const recordKey = { providerId: 'openai-codex', accountSubjectId: ref.accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
    providerId: 'openai-codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
    staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] });
  const enteredPrice = { amount: 17, currency: 'USD', enteredAtMs: now };
  let label = 'Saved plan';
  let revision = 1;
  let projection: ReturnType<typeof ProviderAccountUsagePageProjectionWriteV1Schema.parse> | null = null;
  const allowance = createDeferred<void>();
  let holdAllowance = false;
  let failAllowance = false;
  const resolution = { source, recordId: snapshot.recordId, providerAccountId: ref.accountId, fetchedAt: now, staleAfterMs: 60_000 };
  home = await serveAccountHomes({ homes: [{ key: 'price', serverUrl: 'https://persisted-plan-price.test', accountId: profile.id, profile }],
    route: async request => {
      if (holdAllowance && request.path.startsWith('/v4/connect/qualified/provider-account-usage/')) await allowance.promise;
      if (failAllowance && (request.path.includes('/provider-account-usage/') || request.path.endsWith('/quotas'))) {
        return Response.json({ error: 'unavailable' }, { status: 503 });
      }
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
      if (request.path === '/v4/connect/qualified/quotas') return Response.json({ ref, sourceResolution: resolution,
        content: { t: 'plain', v: { v: 1, ref, activeAccountId: ref.accountId, fetchedAt: now, staleAfterMs: 60_000,
          planLabel: null, accountLabel: null, meters: [] } }, metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' } });
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json(resolution);
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        if (request.method === 'PUT') {
          projection = ProviderAccountUsagePageProjectionWriteV1Schema.parse(request.body);
          return Response.json({ success: true });
        }
        const query: unknown = JSON.parse(request.url.searchParams.get('query') ?? 'null');
        return Response.json(query && typeof query === 'object' && 'projection' in query
          ? { projection, complete: projection !== null } : { entries: [], nextCursor: null });
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      if (request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision,
        content: { t: 'plain', v: { v: 1, entries: [{ v: 1, subject: { kind: 'account', account: ref }, label,
          subscriptionMonthlyPrice: enteredPrice }] } } });
      if (request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, entries: [] } } });
      return undefined;
    } });
  const server = home.homes.price!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  const scope = { serverId: server.id, accountId: profile.id };
  storage.setState({ profileScope: scope, settingsScope: scope, profile });
  const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
  await getServerFeaturesSnapshot({ serverId: server.id, force: true });
  if (admittedFirstMount) {
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { resolveAuthCredentialsScopeKey } = await import('@/auth/storage/resolveAuthCredentialsScopeKey');
    const { buildQualifiedQuotaSnapshotScopeKey, getQualifiedQuotaSnapshotEntry, loadQualifiedQuotaSnapshotOnce } =
      await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
    const { getProviderAccountUsageSnapshotPlain } = await import('@/sync/api/account/apiProviderAccountUsage');
    const { buildProviderAccountUsageScopeKey } = await import('@/sync/domains/connectedServices/accountUsage/providerAccountUsageLoadRoute');
    const { updateProviderAccountUsageCacheEntries } = await import('@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache');
    const basis = getActiveServerSnapshot();
    const credentialsKey = resolveAuthCredentialsScopeKey(credentials);
    const serverBasis = { serverId: server.id, generation: basis.generation };
    const readContext = { credentials, ref, serverBasis,
      credentialScope: [server.id, String(basis.generation), credentialsKey].join('\u0000') };
    const key = buildQualifiedQuotaSnapshotScopeKey(readContext);
    loadQualifiedQuotaSnapshotOnce(key, readContext);
    await expect.poll(() => getQualifiedQuotaSnapshotEntry(key).usageRecordId).toBe(snapshot.recordId);
    const opened = await getProviderAccountUsageSnapshotPlain(credentials, { recordId: snapshot.recordId }, { expectedActiveServer: serverBasis });
    updateProviderAccountUsageCacheEntries(buildProviderAccountUsageScopeKey({ serverId: server.id, generation: basis.generation,
      credentialScope: credentialsKey }), () => ({ [snapshot.recordId]: { snapshot: opened, loading: false, hadError: false, nextFetchAtMs: now + 60_000 } }));
    // The real Home readers admitted provider-only B before Plans mounted. Its
    // personal metadata is already available; a fresh allowance is independent.
    await refreshConnectedMetadataCatalog(scope);
    holdAllowance = true;
  }
  const query = normalizeUsageQuery({ period: { startMs: now - 1000, endMs: now + 1000 }, includeAccounting,
    includeQuotaHistory: includeAccounting, includeSessionEvidence: false, includeWorkEvidence: false });
  const queries = includeAccounting ? [query] : [query, normalizeUsageQuery({ ...query, includeAccounting: true })];
  const plan = { scope, input: { queries }, batchKey: getUsageQueryBatchKey({ queries }), widgets: new Map([['plans', {
    query, key: getUsageQueryKey(query), resolution: { status: 'ready' as const, input: {} },
  }]]) };
  let renders = 0;
  const hook = await renderHook(() => {
    renders++;
    const resource = useUsageWidgetResource({ credentials, enabled: true, plan });
    const model = useUsageWidgetBodyModel(resource, 'plans');
    const empty = resolveUsagePageAggregation({ queries: [query] }).results[0]!;
    return { ...useUsagePlans(model.slice ?? empty, model.refresh), pending: model.pending,
      refreshing: model.refreshing, freshness: model.freshness, error: model.error, refresh: model.refresh };
  }, { wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }) });
  try {
    await expect.poll(() => getConnectedMetadataCatalog(scope).presentation.status).toBe('ready');
    expect(getConnectedMetadataCatalog(scope).presentation).toMatchObject({ entries: [{ subscriptionMonthlyPrice: enteredPrice }] });
    await expect.poll(() => hook.getCurrent().projection.accounts[0]?.read?.current?.recordId).toBe(snapshot.recordId);
    await expect.poll(() => hook.getCurrent().projection.accounts[0]?.subscription?.enteredMonthlyPrice).toEqual(enteredPrice);
    if (!admittedFirstMount) await expect.poll(() => hook.getCurrent().pending).toBe(false);
    // A personal price is not evidence of a provider-reported paid period.
    expect(hook.getCurrent().projection.accounts[0]?.prices.entered).toBeNull();
    const reads = () => home!.requests.filter(request => request.path === '/v2/usage/query'
      || request.path.includes('/provider-account-usage') || request.path.includes('/quotas')).length;
    const beforeLabel = reads();
    label = 'Renamed personal plan'; revision++;
    await act(async () => { await refreshConnectedMetadataCatalog(scope); });
    await expect.poll(() => hook.getCurrent().nameOf(hook.getCurrent().projection.accounts[0]!).title).toBe(label);
    await flushHookEffects({ cycles: 20 });
    expect(reads(), 'A label-only metadata publication does not acquire accounting or quota').toBe(beforeLabel);
    expect(hook.getCurrent().projection.accounts[0]?.subscription?.enteredMonthlyPrice).toEqual(enteredPrice);
    if (!includeAccounting) {
      const beforePush = reads();
      const beforeRenders = renders;
      await act(async () => { publishHomeAccountChange(server.id, [], { changeKinds: ['account'], usageQueryAffects: true,
        usageAccountingChange: { sessionId: null, observedFromMs: now } }); });
      await expect.poll(reads).toBeGreaterThan(beforePush);
      await flushHookEffects({ cycles: 30 });
      expect(renders - beforeRenders, 'a real accounting refresh does not change settled allowance freshness or activity').toBe(0);
    }
    if (!includeAccounting) {
      const beforeRefresh = reads();
      const retained = hook.getCurrent().projection.accounts[0]?.read;
      holdAllowance = true;
      let refreshing: Promise<void> | undefined;
      await act(async () => { refreshing = hook.getCurrent().refresh(); });
      await expect.poll(reads).toBeGreaterThan(beforeRefresh);
      await expect.poll(() => hook.getCurrent().refreshing).toBe(true);
      expect(hook.getCurrent().projection.accounts[0]?.read).toBe(retained);
      holdAllowance = false;
      await act(async () => { allowance.resolve(); await refreshing; });
      await expect.poll(() => hook.getCurrent().refreshing).toBe(false);
      failAllowance = true;
      await act(async () => { await hook.getCurrent().refresh(); });
      await expect.poll(() => hook.getCurrent().error !== null).toBe(true);
      expect(hook.getCurrent().freshness).toBe('stale');
      expect(hook.getCurrent().refreshing).toBe(false);
      expect(hook.getCurrent().pending).toBe(false);
      expect(hook.getCurrent().projection.accounts[0]?.read?.current?.recordId).toBe(snapshot.recordId);
    }
  } finally { holdAllowance = false; allowance.resolve(); await hook.unmount(); }
});

it('keeps external usage rows on a first Plans mount after every Machine sleeps', async () => {
  const service = { pluginId: 'acme.sleeping', localId: 'usage' };
  const ref = { service, accountId: 'work' };
  const profile = AccountProfileSchema.parse({ id: 'sleeping-plans', connectedAccountsV4: [{ ref,
    status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
    credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false,
    configurationRevision: null, scopes: [] }] });
  home = await serveAccountHomes({ homes: [{ key: 'sleep', serverUrl: 'https://sleeping-plans.test', accountId: profile.id, profile }],
    route: () => undefined });
  const server = home.homes.sleep!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  const scope = { serverId: server.id, accountId: profile.id };
  storage.setState({ profileScope: scope, settingsScope: scope, profile });
  const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
  const lifetime = captureActiveServerAccountScopeLifetime()!;
  const availability = createPluginAccountAvailabilityReaderStore();
  const materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId: 'srv_test', machineId: 'machine',
    materializationId: 'sleeping', pluginId: service.pluginId, version: '1.0.0', sourceClass: 'localPath',
    portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 });
  availability.replace({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [materialization],
    snapshots: [{ serverIdentityId: 'srv_test', machineId: 'machine', materializations: [materialization] }] } });
  const owner = createAppShellPluginUiProjectionPublication();
  const sources = { accountLifetime: lifetime, availabilityInputs: availability.bind(scope).readUiProjectionInputs(),
    hostBundledUiEnabled: false, activeServerId: server.id, serverProfilesGeneration: 0, activeInventoryLoaded: true };
  const descriptor = ConnectedAccountUiProjectionEntryV1Schema.parse({ id: service.localId, serviceId: service.localId,
    pluginId: service.pluginId, title: 'Sleeping service', provenance: 'external', sourceKind: 'installed',
    authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] },
    capabilities: ['usage'], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] });
  const report = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
    phase: 'current' as const, interactionEnabled: true, machineId: 'machine', serverId: server.id,
    platform: 'web' as const, accountLifetime: lifetime,
    connectedAccountProjection: { kind: 'ready' as const, descriptors: [descriptor] } };
  try {
    owner.publishSources({ ...sources, onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] });
    owner.publishMachineCurrentness('machine', lifetime, report);
    owner.publishMachineCurrentness('machine', lifetime, { ...report, phase: 'retainedOffline', interactionEnabled: false });
    owner.publishSources({ ...sources, onlineMachineIds: [], selectableMachineIds: [] });
    const resolution = owner.getSnapshot().connectedAccountResolution;
    expect.soft(resolution.kind).toBe('ready');
    installConnectedAccountDescriptorProjection(advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('sleeping'), resolution), lifetime);
    const registry = getConnectedServiceRegistrySnapshot();
    expect.soft(registry.status).toBe('ready');
    // Sleeping Machines withdraw native declarations; admitted Usage facts remain readable.
    expect(isConnectedServiceUsageCapable(service, registry)).toBe(false);
    expect(registry.entries.find(entry => entry.service?.pluginId === service.pluginId)).toBeUndefined();
    const source = QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account', ref });
    const slice = resolveUsagePageAggregation({ queries: [normalizeUsageQuery({})],
      sources: [{ source: `quota:${JSON.stringify(source)}`, status: 'pending' }] }).results[0]!;
    const hook = await renderHook(() => useUsagePlans(slice, async () => {}), {
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
    });
    expect(hook.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
    // A saved qualified identity keeps its humanized name without a live declaration.
    expect(hook.getCurrent().nameOf(hook.getCurrent().projection.accounts[0]!).serviceLabel).toBe('Usage');
    await hook.unmount();
    owner.publishSources({ ...sources, onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] });
    owner.publishMachineCurrentness('machine', lifetime, { ...report, connectedAccountProjection: { kind: 'ready', descriptors: [] } });
    expect(owner.getSnapshot().connectedAccountResolution.descriptors).toEqual([]);
    retireActiveServerAccountScopeLifetime();
    expect(owner.getSnapshot().connectedAccountResolution.descriptors).toEqual([]);
    expect(home.requests.filter(request => request.path.includes('/quotas'))).toEqual([]);
  } finally { owner.dispose(); }
});

it('keeps connected-account names distinct when every account has the same plan', async () => {
  const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
  const accounts = [
    { accountId: 'work', displayName: 'Work', email: 'work@example.com' },
    { accountId: 'personal', displayName: 'Personal', email: 'personal@example.com' },
    { accountId: 'unnamed-a' },
    { accountId: 'unnamed-b' },
  ];
  const profile = AccountProfileSchema.parse({ id: 'named-plans', connectedAccountsV4: accounts.map(account => ({
    ref: { service, accountId: account.accountId }, status: 'connected', authenticationModeId: 'manual',
    revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
    configurationReady: false, configurationRevision: null, scopes: [],
    displayName: account.displayName, providerIdentity: { email: account.email },
  })) });
  home = await serveAccountHomes({ homes: [{ key: 'names', serverUrl: 'https://usage-names.test', accountId: profile.id, profile }],
    route: () => undefined });
  const server = home.homes.names!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  const scope = { serverId: server.id, accountId: profile.id };
  storage.setState({ profileScope: scope, settingsScope: scope, profile });
  const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
  const quota = accounts.map(account => {
    const recordKey = { providerId: 'openai', accountSubjectId: account.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    return ConnectedServiceQuotaGetResultV1Schema.parse({
      source: { bindingKind: 'account', ref: { service, accountId: account.accountId } },
      current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'openai',
        accountSubject: { kind: 'providerSubject', id: account.accountId }, observedAtMs: Date.now(), fetchedAtMs: Date.now(),
        staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', planLabel: 'pro', meters: [] },
      pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
    });
  });
  const query = normalizeUsageQuery({});
  const slice = resolveUsagePageAggregation({ queries: [query], quota: { status: 'available', value: quota } }).results[0]!;
  const refresh = async () => {};
  const hook = await renderHook(() => useUsagePlans(slice, refresh), {
    wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
  });
  const model = hook.getCurrent();
  const names = new Map(model.projection.accounts.map(account => [account.accountId, model.nameOf(account)]));
  expect(names.get('work')).toMatchObject({ title: 'Work', qualifier: 'pro · work@example.com' });
  expect(names.get('personal')).toMatchObject({ title: 'Personal', qualifier: 'pro · personal@example.com' });
  const serviceLabel = names.get('unnamed-a')!.serviceLabel;
  expect(names.get('unnamed-a')).toMatchObject({ title: t('connectedServicesCollection.accountLabel', { service: serviceLabel }), qualifier: 'pro' });
  expect(names.get('unnamed-b')).toMatchObject({ title: t('connectedServicesCollection.accountLabelNumbered', { service: serviceLabel, number: 2 }), qualifier: 'pro' });
  expect(new Set([...names.values()].map(name => name.title)).size).toBe(accounts.length);
  expect(home.requests.filter(request => request.path.includes('/quotas') || request.path.includes('/provider-account-usage'))).toEqual([]);
});

it('retains the answered pool order during refresh and failed reads, but not after selector identity or authority changes', async () => {
  home = await serveAccountHomes({ homes: [{ key: 'order', serverUrl: 'https://usage-order.test', accountId: 'order-account' }],
    route: () => undefined });
  const server = home.homes.order!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  const scope = { serverId: server.id, accountId: 'order-account' };
  storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
  const group = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'pool' };
  const answer = (observedAtMs: number) => {
    const response = ConnectedServicePoolSelectionGetResponseV1Schema.parse({ group, observedAtMs,
    selection: { selected: null, reason: 'manual_strategy', excluded: [], decisionTrace: {
      activeProfileId: null, reason: 'manual_strategy', strategy: 'manual', selectionBasis: 'manual_strategy',
      sticky: false, orderedEligibleCandidates: [], candidates: [],
    } } });
    if ('status' in response) throw new Error('Expected a selector answer');
    return response;
  };
  const query = normalizeUsageQuery({});
  const pool = { group, memberAccountIds: ['work'], activeAccountId: null,
    selection: { status: 'error' as const, machineId: 'machine', errorCode: 'MACHINE_RPC_TIMEOUT' } };
  // The hook projects the Resource's admitted slice; retaining an answered pool order across a
  // refresh, a failed read or a re-batch is the aggregation's (`previous`), so the slices come from it.
  type Selection = NonNullable<ReturnType<typeof resolveUsagePageAggregation>['results'][number]['pools']>[number]['selection'];
  let aggregation: ReturnType<typeof resolveUsagePageAggregation> | undefined;
  const aggregate = (selection: Selection, members = ['work'], previous: typeof aggregation | null = aggregation) => {
    aggregation = resolveUsagePageAggregation({ queries: [query],
      pools: [{ query, value: [{ ...pool, memberAccountIds: members, selection }] }], previous: previous ?? undefined });
    return aggregation.results[0]!;
  };
  let slice = aggregate(pool.selection, ['work'], null);
  let hook = await renderHook(() => useUsagePoolSelections(slice));
  const key = `${group.service.pluginId}/${group.service.localId}:${group.groupId}`;
  const update = async (selection: Selection, members = ['work']) => {
    slice = aggregate(selection, members);
    await hook.rerender();
  };
  expect(hook.getCurrent().get(key)).toBe('failed');
  await update({ status: 'available', machineId: 'machine', value: answer(1) });
  expect(hook.getCurrent().get(key)).toMatchObject({ observedAtMs: 1 });
  expect(hook.getCurrent().get(key)).not.toHaveProperty('refreshError');
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ memberStatus: 'none_known' });
  const excluded = answer(1);
  excluded.selection.excluded = [{ profileId: 'work', reason: 'disabled' }];
  await update({ status: 'available', machineId: 'machine', value: excluded });
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ memberStatus: 'all_excluded' });
  const manual = answer(1);
  manual.selection.decisionTrace.candidates = [{ profileId: 'work', decision: 'eligible', quotaEvidence: { status: 'stale_or_missing' } }];
  await update({ status: 'available', machineId: 'machine', value: manual });
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ memberStatus: 'known' });
  await update({ status: 'available', machineId: 'machine', value: answer(1) });
  await update({ status: 'pending', machineId: 'machine' });
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ observedAtMs: 1 });
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ memberStatus: 'none_known' });
  expect.soft(hook.getCurrent().get(key)).not.toHaveProperty('refreshError');
  await update({ status: 'error', machineId: 'machine', errorCode: 'connected_service_request_failed' });
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ observedAtMs: 1, refreshError: 'failed' });
  await update({ status: 'available', machineId: 'machine', value: answer(2) });
  expect(hook.getCurrent().get(key)).toMatchObject({ observedAtMs: 2 });
  expect(hook.getCurrent().get(key)).not.toHaveProperty('refreshError');
  await update({ status: 'unsupported', errorCode: 'no_machine' });
  expect(hook.getCurrent().get(key)).toMatchObject({ observedAtMs: 2, refreshError: 'no_machine' });
  await update({ status: 'available', machineId: 'machine', value: answer(2) });
  await hook.unmount();
  // A newly mounted reader of the same Resource sees the retained answer too.
  const warmSlice = resolveUsagePageAggregation({ queries: [query], previous: aggregation,
    pools: [{ query, value: [{ ...pool, selection: { status: 'pending', machineId: 'machine' } }] }] }).results[0]!;
  const warm = await renderHook(() => useUsagePoolSelections(warmSlice));
  expect.soft(warm.getCurrent().get(key)).toMatchObject({ observedAtMs: 2 });
  await warm.unmount();
  hook = await renderHook(() => useUsagePoolSelections(slice));
  await update({ status: 'pending', machineId: 'other-machine' });
  expect(hook.getCurrent().get(key)).toBe('loading');
  await update({ status: 'available', machineId: 'machine', value: answer(2) });
  await update({ status: 'pending', machineId: 'machine' }, ['other-account']);
  expect(hook.getCurrent().get(key)).toBe('loading');
  await update({ status: 'available', machineId: 'machine', value: answer(2) });
  await update({ status: 'error', machineId: 'machine', errorCode: 'denied' });
  expect(hook.getCurrent().get(key)).toBe('failed');
  await update({ status: 'pending', machineId: 'machine' });
  expect(hook.getCurrent().get(key)).toBe('loading');
  await update({ status: 'available', machineId: 'machine', value: answer(3) });
  await update({ status: 'unsupported', machineId: 'machine', errorCode: 'unsupported' });
  await update({ status: 'pending', machineId: 'machine' });
  expect(hook.getCurrent().get(key)).toBe('loading');
  await update({ status: 'available', machineId: 'machine', value: answer(4) });
  // A Resource opened for another authority starts without the retired one's answer.
  slice = aggregate({ status: 'pending', machineId: 'machine' }, ['work'], null);
  await hook.rerender();
  expect(hook.getCurrent().get(key)).toBe('loading');
});

it('changes the Usage selector when request reachability changes without a machine heartbeat', async () => {
  const { id: serverId } = await upsertAndActivateServer({ serverUrl: 'https://usage-selector.test', name: 'Usage Home' });
  publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://usage-selector.test', generation: 0 });
  const machines = ['first', 'second'].map(id => createMachineFixture({ id, activeAt: Date.now() }));
  const scope = { serverId, accountId: 'selector-account' };
  storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }), machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
    machineListByServerId: { [serverId]: machines } });
  const hook = await renderHook(() => useUsageSelectorMachineId());
  expect(hook.getCurrent()).toBe('first');
  await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'first' }));
  expect(hook.getCurrent()).toBe('second');
  await act(async () => recordMachineRequestSucceeded({ ...scope, machineId: 'first' }));
  expect(hook.getCurrent()).toBe('first');
});

it('refreshes the displayed Usage Resource and creates no independent quota polling demand', async () => {
  const features = createDeferred<Response>();
  let presentation = ConnectedPresentationRecordV1Schema.parse({ v: 1, entries: [] });
  let presentationRevision = 1;
  const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
  const email = { service: { pluginId: 'acme.email', localId: 'email' }, accountId: 'mail' };
  const poolRef = { service: ref.service, groupId: 'studio' };
  const profile = AccountProfileSchema.parse({ id: 'plans-account', connectedAccountsV4: [
    { ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [],
      displayName: 'Studio account', providerIdentity: { email: 'ai3@happier.dev' } },
    { ref: email, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] },
  ], connectedAccountGroupsV4: [QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: poolRef,
    displayName: 'Studio pool', incarnation: 'studio:1', policy: { strategy: 'priority' }, generation: 1,
    runtimeStateRevision: 1, state: {}, members: [], activeConnectedAccountId: null, createdAt: 1, updatedAt: 1 })] });
  home = await serveAccountHomes({ homes: [{ key: 'plans', serverUrl: 'https://usage-plans.test', accountId: 'plans-account', profile }],
    route: request => request.path === '/v1/features' ? features.promise.then(response => response.clone())
      : request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1 ? Response.json({ status: 'present', revision: presentationRevision,
        content: { t: 'plain', v: presentation } })
      : request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 ? Response.json({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, entries: [] } } }) : undefined });
  const featureResponse = () => Response.json(createRootLayoutFeaturesResponse({ features: {
      connectedServices: { enabled: true, quotas: { enabled: true } },
    }, capabilities: { connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } } } }));
  const serverId = home.homes.plans!.id;
  publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.plans!.serverUrl, generation: 0 });
  const scope = { serverId, accountId: 'plans-account' };
  storage.setState({ profileScope: scope, settingsScope: scope, profile });
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.plans!.serverUrl))!;
  const source = QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account', ref });
  let slice = resolveUsagePageAggregation({ queries: [normalizeUsageQuery({})], pools: [{ query: normalizeUsageQuery({}),
    value: [{ group: poolRef, memberAccountIds: ['work'], activeAccountId: null, selection: { status: 'pending' } }] }], sources: [
    { source: `quota:${JSON.stringify(source)}`, status: 'pending' },
  ] }).results[0]!;
  let refreshed = false;
  const refresh = async () => { refreshed = true; };
  const hook = await renderHook(() => useUsagePlans(slice, refresh), {
    wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
  });
  try {
    const cold = hook.getCurrent();
    expect.soft(cold.nameOf(cold.projection.accounts[0]!).title).toBe('Studio account');
    expect.soft(cold.projection.pools[0]).toMatchObject({ name: 'Studio pool' });
    expect(cold.projection.accounts.map(account => account.accountId)).toEqual(['work']);
    await act(async () => { installConnectedAccountDescriptorProjection({ scopeKey: 'plans', status: 'ready', conflicts: [], errorReason: null,
      descriptors: [{ id: 'email', serviceId: 'email', pluginId: 'acme.email', title: 'Email IMAP + SMTP', provenance: 'external',
        sourceKind: 'installed', authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
          outcomeReconciliation: 'none', fields: [] }] }, capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }] },
    captureActiveServerAccountScopeLifetime()!); });
    await hook.rerender();
    expect(hook.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
    expect(hook.getCurrent().projection.pools[0]).toMatchObject({ name: 'Studio pool' });
    // Catalog availability cannot add accounts absent from the admitted Usage slice.
    await act(async () => { installConnectedAccountDescriptorProjection({ scopeKey: 'plans-offline', status: 'loading',
      conflicts: [], errorReason: null, descriptors: [] }, captureActiveServerAccountScopeLifetime()!); });
    const offline = await renderHook(() => useUsagePlans(slice, refresh), {
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
    });
    expect.soft(offline.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
    await offline.unmount();
    await act(async () => { installConnectedAccountDescriptorProjection({ scopeKey: 'plans', status: 'ready', conflicts: [], errorReason: null,
      descriptors: [{ id: 'email', serviceId: 'email', pluginId: 'acme.email', title: 'Email IMAP + SMTP', provenance: 'external',
        sourceKind: 'installed', authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
          outcomeReconciliation: 'none', fields: [] }] }, capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }] },
    captureActiveServerAccountScopeLifetime()!); });
    await hook.unmount();
    // Starting a new batch must not turn a named Email account into Usage evidence.
    slice = { ...slice, sources: slice.sources.map(state => ({ ...state, status: 'pending' })) };
    const warm = await renderHook(() => useUsagePlans(slice, refresh), {
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
    });
    expect(warm.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
    expect(warm.getCurrent().projection.pools[0]).toMatchObject({ name: 'Studio pool' });
    await act(async () => {
      presentation = ConnectedPresentationRecordV1Schema.parse({ v: 1, entries: [
        { v: 1, subject: { kind: 'account', account: ref }, label: 'Work subscription' },
      ] });
      presentationRevision++;
      await refreshConnectedMetadataCatalog(scope);
    });
    expect(getConnectedMetadataCatalog(scope).presentation).toMatchObject({ status: 'ready', entries: presentation.entries });
    expect.soft(warm.getCurrent().nameOf(warm.getCurrent().projection.accounts[0]!).title).toBe('Work subscription');
    await act(async () => { features.resolve(featureResponse()); await getServerFeaturesSnapshot({ serverId }); });
    await flushHookEffects({ cycles: 20 });
    const projected = warm.getCurrent();
    expect(projected.nameOf(projected.projection.accounts[0]!).title).toBe('Work subscription');
    expect(home.requests.filter(request => request.path.includes('/quotas') || request.path.includes('/provider-account-usage'))).toEqual([]);
    await warm.getCurrent().refresh();
    expect(refreshed).toBe(true);
    slice = { ...slice, sources: slice.sources.map(state => ({ ...state, status: 'partial' })) };
    await act(async () => { installConnectedAccountDescriptorProjection({ scopeKey: 'plans-refresh', status: 'ready', conflicts: [],
      errorReason: null, descriptors: [] }, captureActiveServerAccountScopeLifetime()!); });
    await warm.rerender();
    expect(warm.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
    // A retained Resource snapshot can outlive the authoritative group definition.
    // A same-id group from another service must not keep the deleted pool alive.
    await act(async () => storage.setState({ profile: { ...profile, connectedAccountGroupsV4: [
      { ...profile.connectedAccountGroupsV4[0]!, ref: { service: email.service, groupId: poolRef.groupId } },
    ] } }));
    expect.soft(warm.getCurrent().projection.pools).toEqual([]);
    await act(async () => storage.setState({ profile }));
    expect(warm.getCurrent().projection.pools[0]).toMatchObject({ name: 'Studio pool' });
    await warm.unmount();
    retireActiveServerAccountScopeLifetime();
    slice = { ...slice, sources: slice.sources.map(state => ({ ...state, status: 'pending' })) };
    const retired = await renderHook(() => useUsagePlans(slice, refresh), {
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
    });
    expect(retired.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
  } finally { features.resolve(featureResponse()); }
});
