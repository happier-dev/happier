import { afterEach, expect, it, vi } from 'vitest';
import { Linking } from 'react-native';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { AccountProfileSchema } from '@happier-dev/protocol';
import { CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { createUiConnectedServiceAction } from './connectedServiceActionDeps';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import * as machineRpc from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { ConnectedPresentationRowMutationV1Schema, type ConnectedPresentationRecordV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

installDisconnectedServerSocketBoundary();
afterEach(() => { vi.restoreAllMocks(); });

it.each(['ready', 'first-row'] as const)('sets and clears a monthly subscription price through the captured keyless Account transport from %s', async initial => {
  const bridge = await loadSyncSingletonForTests();
  const previous = storage.getState();
  const accountId = 'subscription-price';
  const http = createHomeHubArtifactHttpBoundary(accountId);
  const connectedAccount = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'personal' };
  const bodies: unknown[] = [];
  let record: ConnectedPresentationRecordV1 = { v: 1, entries: [] };
  let revision = initial === 'first-row' ? 0 : 1;
  const connection = await restoreServerAccountForTest({ accountId, serverUrl: 'https://subscription-price.test', request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: accountId, connectedAccountsV4: [{ ref: connectedAccount,
      status: 'connected', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
      revisionSemantics: 'legacy_unfenced', credentialRevision: null }] }));
    if (path === '/v1/account/entity-rows/connected-metadata/presentation') {
      if (init?.method !== 'POST') return Response.json(revision === 0 ? { status: 'absent' }
        : { status: 'present', revision, content: { t: 'plain', v: record } });
      const body = ConnectedPresentationRowMutationV1Schema.parse(JSON.parse(String(init.body)));
      expect(body.expectedRevision).toBe(revision === 0 ? 'absent' : revision);
      expect(body.content?.t).toBe('plain');
      if (body.content?.t !== 'plain') throw new Error('Expected keyless personal metadata');
      record = body.content.v;
      bodies.push(body);
      revision += 1;
      return Response.json({ status: 'updated', revision, cursor: revision });
    }
    if (path === '/v1/account/entity-rows/connected-metadata/acknowledgements') return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } });
    expect(path).not.toContain('/provider-account-usage/');
    return http.request(url, init);
  } });
  const scope = { serverId: connection.home.id, accountId };
  storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: accountId }) });
  const account = await captureLazyActionAccountContext(connection.home.id);
  const action = createUiConnectedServiceAction(account);
  try {
    expect(await action({ actionId: 'connectedServices.subscription.price.set', input: { account: connectedAccount, price: { amount: 17, currency: 'EUR' } },
      context: { surface: 'ui', authority: 'present_user' } })).toEqual({ applied: true });
    expect(bodies.at(-1)).toMatchObject({ expectedRevision: 1, content: { t: 'plain', v: { entries: [{ subject: { kind: 'account', account: connectedAccount },
      subscriptionMonthlyPrice: { amount: 17, currency: 'EUR' } }] } } });
    expect(await action({ actionId: 'connectedServices.subscription.price.set', input: { account: connectedAccount, price: null },
      context: { surface: 'ui', authority: 'present_user' } })).toEqual({ applied: true });
    expect(bodies.at(-1)).toMatchObject({ expectedRevision: 2, content: { t: 'plain', v: { entries: [] } } });
    expect(account.credentials).not.toHaveProperty('secret');
  } finally { account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});

it.each(['current', 'retired'] as const)('opens provider billing locally only for the %s captured Account', async lifetime => {
  const bridge = await loadSyncSingletonForTests();
  const previous = storage.getState();
  const accountId = `billing-${lifetime}`;
  const http = createHomeHubArtifactHttpBoundary(accountId);
  const connection = await restoreServerAccountForTest({ accountId, serverUrl: `https://${accountId}.test`, request: http.request });
  const scope = { serverId: connection.home.id, accountId };
  storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: accountId }) });
  const captured = await captureLazyActionAccountContext(connection.home.id);
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const account = { service, accountId: 'work' };
  const input = { machineId: 'catalog-machine', account };
  const destination = 'https://claude.ai/settings/billing';
  const opened = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  // Only the daemon transport and OS navigation are replaced; admission and Account custody stay real.
  vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockImplementation(async <R, A>(request: ServerScopedMachineRpcParams<A>) => {
    expect(request).toMatchObject({ serverId: scope.serverId, machineId: input.machineId,
      method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, payload: { v: 1, machineId: input.machineId,
        command: { operation: 'describeService', service } } });
    request.onIssued?.();
    if (lifetime === 'retired') storage.setState({ profileScope: { ...scope, accountId: 'successor' }, profile: AccountProfileSchema.parse({ id: 'successor' }) });
    return { status: 'described', service, occurrenceId: 'runtime',
      sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-1' } },
      descriptor: { id: service.localId, title: 'Claude', billingUrl: destination, authentication: { defaultModeId: 'oauth', modes: [
        { id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none' },
      ] } }, accounts: [{ ref: account, status: 'connected', authenticationModeId: 'oauth', configurationReady: true,
        configurationRevision: null, scopes: [], revisionSemantics: 'legacy_unfenced', credentialRevision: null }] } as R;
  });
  try {
    const result = createUiConnectedServiceAction(captured)({ actionId: 'connectedServices.billing.open', input,
      context: { surface: 'ui', authority: 'present_user' } });
    if (lifetime === 'current') { await expect(result).resolves.toEqual({ opened: true }); expect(opened).toHaveBeenCalledWith(destination); }
    else { await expect(result).rejects.toBeInstanceOf(Error); expect(opened).not.toHaveBeenCalled(); }
  } finally { captured.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});

it('reads keyless plain quota and pacing targets from the captured Home without refreshing the provider', async () => {
  const bridge = await loadSyncSingletonForTests();
  const previous = storage.getState();
  const accountId = 'quota-read';
  const http = createHomeHubArtifactHttpBoundary(accountId);
  const source = { bindingKind: 'account' as const, ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } };
  const targets = [{ id: 'personal-pace', scope: { kind: 'personal' as const }, utilizationFraction: 0.75 }];
  const requests: string[] = [];
  const connection = await restoreServerAccountForTest({ accountId, serverUrl: 'https://quota-read.test', request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/pending/reset-starts/read') {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ source });
      return Response.json({ entries: [] });
    }
    if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { usagePacingTargetsV1: targets } }, version: 1 });
    if (path.startsWith('/v4/connect/qualified/provider-account-usage/')) {
      expect(init?.method).toBe('GET');
      requests.push(path);
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    return http.request(url, init);
  } });
  const scope = { serverId: connection.home.id, accountId };
  // Captured settings reads use the real mounted Account projection when available.
  storage.setState({ profileScope: scope, settingsScope: scope, profile: AccountProfileSchema.parse({ id: accountId }),
    settings: settingsParse({ usagePacingTargetsV1: targets }) });
  const account = await captureLazyActionAccountContext(connection.home.id);
  try {
    expect(await createUiConnectedServiceAction(account)({ actionId: 'connectedServices.quota.get', input: { source },
      context: { surface: 'ui', authority: 'present_user' } })).toEqual({ source, current: null, pace: [], targets,
        waitingWork: { status: 'available', entries: [] },
        unusedCapacity: { historyStatus: 'not_loaded', windows: [] } });
    expect(requests).toEqual(['/v4/connect/qualified/provider-account-usage/sources/resolve']);
    expect(account.credentials).not.toHaveProperty('secret');
  } finally { account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});

it.each(['current', 'retired', 'cancelled'] as const)('returns selection evidence only to the %s captured Account', async lifetime => {
  const bridge = await loadSyncSingletonForTests();
  const previous = storage.getState();
  const accountId = `selection-${lifetime}`;
  const http = createHomeHubArtifactHttpBoundary(accountId);
  const connection = await restoreServerAccountForTest({ accountId, serverUrl: `https://${accountId}.test`, request: http.request });
  const scope = { serverId: connection.home.id, accountId };
  storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: accountId }) });
  const controller = new AbortController();
  const account = await captureLazyActionAccountContext(connection.home.id, controller.signal);
  const input = { machineId: 'work-machine', group: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'work' } };
  const selected = { profileId: 'work-member', priority: 1, createdAtMs: 1, enabled: true, leastLimitedScore: 80 };
  const response = { group: input.group, observedAtMs: 100, selection: { selected, reason: 'selected', excluded: [],
    decisionTrace: { activeProfileId: selected.profileId, reason: 'selected', strategy: 'priority',
      selectionBasis: 'active_stickiness', sticky: true, orderedEligibleCandidates: [selected],
      candidates: [{ profileId: selected.profileId, decision: 'selected', quotaEvidence: { status: 'fresh', remainingPercent: 80 } }] },
  } };
  // Only the machine transport is substituted; Account custody and Action execution stay real.
  vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockImplementation(async <R, A>(request: ServerScopedMachineRpcParams<A>) => {
    expect(request).toMatchObject({ serverId: scope.serverId, accountId, machineId: input.machineId,
      method: CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD, payload: input, signal: controller.signal });
    request.onIssued?.();
    if (lifetime === 'retired') storage.setState({ profileScope: { ...scope, accountId: 'successor' }, profile: AccountProfileSchema.parse({ id: 'successor' }) });
    if (lifetime === 'cancelled') controller.abort();
    // The external transport's generic reply is validated by the real Action schema.
    return response as R;
  });
  try {
    const result = createUiConnectedServiceAction(account)({ actionId: 'connectedServices.pools.selection.get', input,
      context: { surface: 'ui', authority: 'present_user' }, signal: controller.signal });
    if (lifetime === 'current') await expect(result).resolves.toEqual(response);
    else if (lifetime === 'cancelled') await expect(result).resolves.toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    else await expect(result).rejects.toBeInstanceOf(Error);
  } finally { account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});
