import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { createCliConnectedServiceAction } from './connectedServiceActionDeps';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import axios from 'axios';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['current', 'retired', 'mode-denied', 'first-row'] as const)('writes entered monthly price through captured keyless Account authority while %s', async lifetime => {
  const credentials = { token: 'subscription-requester', encryption: null };
  const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'personal' };
  let current = true;
  let written: unknown;
  const rows = new Map<string, unknown>();
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
    serverHttpBaseUrl: 'https://subscription.test', isCurrent: async () => current,
    snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
  });
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    expect(options?.headers).toMatchObject({ 'X-Captured-Requester': 'price-authority' });
    if (lifetime === 'retired') current = false;
    const path = new URL(String(url)).pathname;
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'price-owner', connectedAccountsV4: [{ ref: account,
      status: 'connected', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
      revisionSemantics: 'legacy_unfenced', credentialRevision: null }] }) };
    if (path.startsWith('/v1/account/entity-rows/connected-metadata/')) {
      if (lifetime === 'first-row') return { status: 200, data: rows.get(path) ?? { status: 'absent' } };
      return { status: 200, data: {
      status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } },
      } };
    }
    return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    const path = new URL(String(url)).pathname;
    expect(path).toMatch(/^\/v1\/account\/entity-rows\/connected-metadata\/(presentation|acknowledgements)$/);
    expect(options?.headers).toMatchObject({ 'X-Captured-Requester': 'price-authority' });
    if (path.endsWith('/presentation')) written = body;
    if (lifetime === 'first-row') {
      const mutation = body as { content: unknown };
      const revision = rows.has(path) ? 2 : 1;
      rows.set(path, { status: 'present', revision, content: mutation.content });
      return { status: 200, data: { status: 'updated', revision, cursor: revision } };
    }
    return lifetime === 'mode-denied' ? { status: 409, data: { status: 'account-mode-mismatch' } }
      : { status: 200, data: { status: 'updated', revision: 2, cursor: 2 } };
  });
  const action = createCliConnectedServiceAction({ credentials, serverHttpBaseUrl: 'https://subscription.test',
    operationContext,
    isCredentialCurrent: async () => current, resolveHeaders: () => ({ 'X-Captured-Requester': 'price-authority' }),
    callMachineAction: async () => { throw new Error('A subscription price is not machine control'); },
  });
  const result = action({ actionId: 'connectedServices.subscription.price.set', input: { account, price: { amount: 17, currency: 'EUR' } }, context });
  if (lifetime === 'retired') { await expect(result).rejects.toMatchObject({ code: 'scope-retired' }); expect(written).toBeUndefined(); }
  else if (lifetime === 'mode-denied') await expect(result).rejects.toMatchObject({ code: 'account-mode-mismatch' });
  else { await expect(result).resolves.toEqual({ applied: true }); expect(written).toMatchObject({ expectedRevision: 1,
    content: { t: 'plain', v: { entries: [{ subject: { kind: 'account', account }, subscriptionMonthlyPrice: { amount: 17, currency: 'EUR' } }] } } }); }
});

const input = { machineId: 'work-machine', group: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'work' } };
const context = { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };

it('reads a cold quota subscription with its exact-account catalog price without borrowing daemon settings', async () => {
  const credentials = { token: 'cold-price-reader', encryption: null };
  const source = { bindingKind: 'account' as const, ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } };
  const recordKey = { providerId: 'test', accountSubjectId: 'subject', subjectKind: 'account' as const, quotaScope: 'account' as const };
  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test',
    accountSubject: { kind: 'providerSubject', id: 'subject' }, observedAtMs: 100, fetchedAtMs: 100, staleAfterMs: 1000,
    source: 'providerHttp', confidence: 'confirmed', meters: [], subscription: { status: 'subscribed', renewal: 'on', observedAtMs: 100, staleAfterMs: 1000 } });
  const price = { amount: 17, currency: 'EUR', enteredAtMs: 100 };
  const boundary = async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path.endsWith('/sources/resolve')) return { status: 200, data: { source, recordId: snapshot.recordId, providerAccountId: 'subject', fetchedAt: 100, staleAfterMs: 1000 } };
    if (path.endsWith('/record')) return { status: 200, data: { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 100, staleAfterMs: 1000, status: 'ok' }, sources: [source] } };
    if (path.endsWith('/presentation')) return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [
      { v: 1, subject: { kind: 'account', account: source.ref }, label: '', subscriptionMonthlyPrice: price },
    ] } } } };
    if (path.endsWith('/acknowledgements')) return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } } };
    if (path === '/v2/pending/reset-starts/read') return { status: 200, data: { entries: [] } };
    throw new Error(`Unexpected cold price read ${path}`);
  };
  vi.spyOn(axios, 'get').mockImplementation(async url => boundary(url));
  vi.spyOn(axios, 'post').mockImplementation(async url => boundary(url));
  vi.spyOn(axios, 'request').mockImplementation(async request => boundary(request.url));
  const action = createCliConnectedServiceAction({ credentials, serverHttpBaseUrl: 'https://cold-price.test',
    isCredentialCurrent: async () => true, resolveHeaders: () => ({ 'X-Captured-Requester': 'price-reader' }),
    callMachineAction: async () => { throw new Error('No machine read'); } });
  expect(await action({ actionId: 'connectedServices.quota.get', input: { source }, context })).toMatchObject({
    current: { subscription: { enteredMonthlyPrice: price } },
  });
});

it.each(['captured', 'cold', 'retired'] as const)('reads keyless plain quota with requester authorization only while the %s requester is current', async lifetime => {
  const credentials = { token: 'captured-quota-requester', encryption: null };
  let current = true;
  const source = { bindingKind: 'account' as const, ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } };
  const targets = [{ id: 'personal-pace', scope: { kind: 'personal' as const }, utilizationFraction: 0.75 }];
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
    serverHttpBaseUrl: 'https://work-quota.test', isCurrent: async () => true,
    snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
  });
  const requests: string[] = [];
  const readBoundary = async (url: unknown, headers: unknown, method = 'GET', body?: unknown) => {
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe('https://work-quota.test');
    expect(headers).toMatchObject({ 'X-Captured-Requester': 'read-authority' });
    requests.push(parsed.pathname);
    if (parsed.pathname === '/v2/pending/reset-starts/read') {
      expect(method).toBe('POST'); expect(body).toEqual({ source });
      return { status: 200, data: { entries: [] } };
    }
    if (parsed.pathname === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (parsed.pathname === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: { usagePacingTargetsV1: targets } }, version: 1 } };
    if (parsed.pathname === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
      if (lifetime === 'retired') current = false;
      return { status: 404, data: { error: 'not_found' } };
    }
    throw new Error(`Unexpected quota read: ${parsed.pathname}`);
  };
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => readBoundary(url, options?.headers));
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => readBoundary(url, options?.headers, 'POST', body));
  vi.spyOn(axios, 'request').mockImplementation(async options => readBoundary(options.url, options.headers, options.method?.toUpperCase(), options.data));
  const action = createCliConnectedServiceAction({ credentials, serverHttpBaseUrl: 'https://work-quota.test', serverId: 'work-home',
    ...(lifetime === 'captured' ? { operationContext } : {}), ...{ isCredentialCurrent: async () => current },
    resolveHeaders(caller, actionId, request) {
      expect(caller).toBe(context); expect(actionId).toBe('connectedServices.quota.get');
      if (request.method === 'POST') expect(request).toEqual({ method: 'POST', path: '/v2/pending/reset-starts/read', body: { source } });
      else expect(request.method).toBe('GET');
      return { 'X-Captured-Requester': 'read-authority' };
    }, callMachineAction: async () => { throw new Error('Quota read is not machine control'); },
  });
  const result = action({ actionId: 'connectedServices.quota.get', input: { source }, context });
  if (lifetime === 'retired') await expect(result).rejects.toMatchObject({ code: 'scope-retired' });
  else await expect(result).resolves.toEqual({ source, current: null, pace: [], targets,
    waitingWork: { status: 'available', entries: [] },
    unusedCapacity: { historyStatus: 'not_loaded', windows: [] } });
  expect(requests).toContain('/v4/connect/qualified/provider-account-usage/sources/resolve');
});

it.each(['current', 'retired'] as const)('reads cold selector evidence without settings only while credentials are %s', async lifetime => {
  resetActiveAccountSettingsSnapshotForTests();
  let current = true;
  const response = { status: 'unavailable' as const, code: 'connected_account_daemon_runtime_unavailable' as const };
  const action = createCliConnectedServiceAction({ credentials: { token: 'cold-requester', encryption: null }, serverId: 'cold-home',
    ...{ isCredentialCurrent: async () => current },
    resolveHeaders() { throw new Error('Selector does not read Account settings'); },
    async callMachineAction(request) {
      expect(request).toMatchObject({ serverId: 'cold-home', machineId: input.machineId,
        method: CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD, request: input });
      if (lifetime === 'retired') current = false;
      return response;
    },
  });
  const result = action({ actionId: 'connectedServices.pools.selection.get', input, context });
  if (lifetime === 'current') await expect(result).resolves.toEqual(response);
  else await expect(result).rejects.toMatchObject({ code: 'scope-retired' });
});

it.each(['current', 'retired', 'cancelled'] as const)('returns selection evidence only to the %s captured Account', async lifetime => {
  const credentials = { token: 'captured-requester', encryption: null };
  let current = true;
  const controller = new AbortController();
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
    serverHttpBaseUrl: 'https://work-selection.test', isCurrent: async () => current,
    snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
  });
  const selected = { profileId: 'work-member', priority: 1, createdAtMs: 1, enabled: true, leastLimitedScore: 80 };
  const response = { group: input.group, observedAtMs: 100, selection: { selected, reason: 'selected', excluded: [],
    decisionTrace: { activeProfileId: selected.profileId, reason: 'selected', strategy: 'priority',
      selectionBasis: 'active_stickiness', sticky: true, orderedEligibleCandidates: [selected],
      candidates: [{ profileId: selected.profileId, decision: 'selected', quotaEvidence: { status: 'fresh', remainingPercent: 80 } }] },
  } };
  const action = createCliConnectedServiceAction({ credentials, operationContext, serverId: 'work-home',
    resolveHeaders() { throw new Error('Selection is a machine read'); },
    // Machine transport is the external boundary; scope admission and Action parsing stay real.
    async callMachineAction(request) {
      expect(request).toEqual({ machineId: input.machineId, serverId: 'work-home',
        method: CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD, request: input, signal: controller.signal });
      if (lifetime === 'retired') current = false;
      if (lifetime === 'cancelled') controller.abort();
      return response;
    },
  });
  const result = action({ actionId: 'connectedServices.pools.selection.get', input, context, signal: controller.signal });
  if (lifetime === 'current') await expect(result).resolves.toEqual(response);
  else await expect(result).rejects.toBeInstanceOf(Error);
});
