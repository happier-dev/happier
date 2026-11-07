import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountCredentialStore, ConnectedAccountMutationContext, ConnectedAccountReadContext, PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { derivePluginAccountContributionRegistrationRights } from '../../../../protocol/src/plugins/contributions/catalog.js';
import { createPluginRegistrationScope } from '../../../../plugin-sdk/src/registration/scope.js';
import { invokeConnectedAccountAuthenticationRuntime } from '../../../../cli-common/src/connectedAccounts/authenticationRuntimeDispatcher.js';

const accountId = 'a'.repeat(32);
const callbackUrl = 'https://app.happier.dev/oauth/connected-account/callback';
const service = { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' };
const kits: PluginTestkit[] = [];
afterEach(async () => { await Promise.all(kits.splice(0).map(kit => kit.dispose())); vi.useRealTimers(); });

function credentials() {
  const values = new Map<string, string>();
  const store: ConnectedAccountCredentialStore = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value, options) { options?.signal?.throwIfAborted(); values.set(key, value); },
    async delete(key, options) { options?.signal?.throwIfAborted(); values.delete(key); },
  };
  return { values, store };
}

async function harness(product: 'workers' | 'pages' = 'workers', options?: { byo?: 'none' | 'client-only' | 'scopes-only'; publicClient?: boolean; withoutAccount?: boolean }) {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry }); kits.push(kit);
  const runtime = kit.registration('connectedAccountDescriptors', 'cloudflare');
  if (!runtime) throw new Error('Missing activated runtime');
  const mode = runtime.authentication.modes['oauth'];
  expect(mode?.kind).toBe('oauthAuthorizationCode');
  if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Missing activated OAuth mode');
  // Constructed catalog/token vectors from Cloudflare's documented schemas,
  // not tenant captures or assertions about undeployed registered scope IDs.
  // https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/
  // https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list/
  const catalog = [
    { id: 'account-settings.read', name: 'Account Settings Read', scopes: ['com.cloudflare.api.account'] },
    ...(product === 'workers' ? [
      { id: 'workers-scripts.write', name: 'Workers Scripts Write', scopes: ['com.cloudflare.api.account'] },
      { id: 'workers-ci.write', name: 'Workers CI Write', scopes: ['com.cloudflare.api.account'] },
    ] : [{ id: 'page.write', name: 'Pages Write', scopes: ['com.cloudflare.api.account'] }]),
  ];
  const registeredScopes = catalog.map(item => item.id).join(' ');
  const scopes = `openid offline_access ${registeredScopes}`;
  let publicClient: Readonly<{ clientId: string; scopes: readonly string[] }> | null = options?.publicClient
    ? { clientId: 'happier-public-client', scopes: registeredScopes.split(' ') } : null;
  // The Home configuration boundary supplies admitted non-secret metadata; the
  // daemon persistence and feature-snapshot composition is covered by its suite.
  const getPublicOAuthClient = vi.fn(async () => publicClient);
  const values: Record<string, string> = { ...(options?.withoutAccount ? {} : { accountId }),
    ...(!options?.byo || options.byo === 'client-only' ? { clientId: 'registered-client' } : {}),
    ...(!options?.byo || options.byo === 'scopes-only' ? { registeredScopes } : {}) };
  const configuration = {
    target: { kind: 'service' as const, service, modeId: 'oauth' }, revision: 'config-1',
    values,
    async getSecret() { return null; }, getPublicOAuthClient,
  };
  let token: unknown = { token_type: 'Bearer', access_token: 'access-private', refresh_token: 'refresh-private', expires_in: 3600, scope: scopes };
  let identity: unknown = { sub: 'user-identity' };
  let account: unknown = { success: true, result: { id: accountId, name: 'Test account', role: 'read-only' } };
  let accountPages: readonly unknown[] = [{ success: true, result: [{ id: accountId, name: 'Test account' }], result_info: { page: 1, per_page: 20, total_count: 1 } }];
  const staged = credentials(); const retained = credentials();
  const controller = new AbortController();
  const request = vi.fn(async (input: HttpRequest) => {
    const body = input.url.endsWith('/oauth2/token') ? token : input.url.endsWith('/oauth2/userinfo') ? identity
      : input.url.endsWith('/oauth/scopes') ? { success: true, result: catalog }
      : input.url.endsWith('/oauth2/revoke') ? undefined
      : new URL(input.url).pathname === '/client/v4/accounts' ? accountPages[Number(new URL(input.url).searchParams.get('page') ?? '1') - 1] : account;
    return { status: 200, finalUrl: input.url, headers: {}, body: body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body)) };
  });
  const context: ConnectedAccountAuthenticationContext = {
    plugin: { id: service.pluginId, version: '0.0.0' }, contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
    surface: 'ui', invokedAtMs: Date.now(), service, attempt: { kind: 'connect', attemptId: 'oauth-attempt' },
    configuration,
    async stageAccountConfiguration(input) { Object.assign(configuration.values, input.values); },
    signal: controller.signal, attemptCredentials: staged.store,
    services: { http: createPluginHttpFixture({ request }) } as ConnectedAccountAuthenticationContext['services'],
  };
  const read: ConnectedAccountReadContext = { ...context, account: { service, accountId: 'host-account' }, credentials: retained.store };
  const mutation: ConnectedAccountMutationContext = { ...read, stagedCredentials: staged.store, operation: { operationId: 'refresh', configurationRevision: 'config-1' } };
  return { runtime, mode, context, configuration, read, mutation, staged, retained, request, controller, scopes, catalog, getPublicOAuthClient,
    publicClient(value: typeof publicClient) { publicClient = value; },
    token(value: unknown) { token = value; }, identity(value: unknown) { identity = value; }, account(value: unknown) { account = value; },
    accounts(pages: readonly unknown[]) { accountPages = pages; } };
}

const completion = { code: 'code-private', callbackUrl, state: 'oauth-attempt.nonce', pkceVerifier: 'host-verifier' };
describe('portable Cloudflare authentication through Account registration and the shared dispatcher', () => {
  async function portable() {
    const target = { artifactId: 'connected-account-authentication', exportName: 'activate' };
    const descriptor = entry.manifest.contributes.connectedAccountDescriptors![0]!;
    expect(descriptor.authentication.account).toEqual(target);
    const artifactPath = './portableAuthentication.js';
    const artifact = await import(artifactPath) as { activate(api: PluginAccountApi): void };
    const scope = createPluginRegistrationScope({ pluginId: entry.manifest.id, target: { realm: 'account', ...target },
      rights: derivePluginAccountContributionRegistrationRights(entry.manifest.contributes, target) });
    artifact.activate(scope.api);
    const [registration] = scope.commit();
    if (registration?.family !== 'connectedAccountDescriptors') throw new Error('Cloudflare Account runtime was not registered');
    expect(Object.keys(registration.value.authentication.modes).sort()).toEqual(descriptor.authentication.modes.map(mode => mode.id).sort());
    return { runtime: registration.value, descriptor };
  }

  it.each(['workers', 'pages'] as const)('preserves registered %s callback/PKCE and stages a verified identity', async product => {
    const { runtime, descriptor } = await portable();
    const h = await harness(product);
    const modeId = 'oauth';
    const mode = descriptor.authentication.modes.find(mode => mode.id === modeId)!;
    const invoke = (operation: Parameters<typeof invokeConnectedAccountAuthenticationRuntime>[0]['operation']) =>
      invokeConnectedAccountAuthenticationRuntime({ mode: runtime.authentication.modes[modeId], descriptor: mode,
        operation, context: h.context, registerRawForRedaction() {}, async invokeCallback(work) { return work(); } });
    const begun = await invoke({ kind: 'beginOAuth', request: { callbackUrl, state: completion.state, pkce: { challenge: 'host-challenge', method: 'S256' } } });
    expect(begun).toMatchObject({ status: 'awaitingOAuthRedirect', issuer: 'https://dash.cloudflare.com' });
    expect(await invoke({ kind: 'completeOAuth', completion: { ...completion, callbackUrl: 'https://wrong.example/callback' } }))
      .toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_invalid_configuration' } });
    expect(h.request).not.toHaveBeenCalled();
    expect(await invoke({ kind: 'completeOAuth', completion })).toMatchObject({ status: 'connected', providerIdentity: { organizationId: accountId } });
    expect(h.staged.values.get('token')).toBe('access-private');
    const form = new URLSearchParams(new TextDecoder().decode(h.request.mock.calls[0]![0].body));
    expect(Object.fromEntries(form)).toMatchObject({ redirect_uri: callbackUrl, code: completion.code, code_verifier: completion.pkceVerifier });
  });

  it('preserves rejected, uncertain and cancelled exchange outcomes without staging credentials', async () => {
    const { runtime, descriptor } = await portable();
    const h = await harness();
    const mode = descriptor.authentication.modes.find(mode => mode.id === 'oauth')!;
    const invoke = () => invokeConnectedAccountAuthenticationRuntime({ mode: runtime.authentication.modes['oauth'], descriptor: mode,
      operation: { kind: 'completeOAuth', completion }, context: h.context, registerRawForRedaction() {}, async invokeCallback(work) { return work(); } });
    h.request.mockImplementationOnce(async input => ({ status: 400, finalUrl: input.url, headers: {}, body: new TextEncoder().encode('{"error":"invalid_grant"}') }));
    expect(await invoke()).toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_oauth_reconnect_required' } });
    h.request.mockRejectedValueOnce(new Error('lost response'));
    expect(await invoke()).toMatchObject({ status: 'outcomeUnknown', diagnostic: { code: 'cloudflare_oauth_exchange_unknown' } });
    h.controller.abort();
    await expect(invoke()).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.staged.values.size).toBe(0);
  });
});

describe('Cloudflare OAuth through real plugin activation', () => {
  it('signs in before asking for an account and selects the sole authorized account after consent', async () => {
    const h = await harness('workers', { withoutAccount: true });
    await expect(h.mode.begin({ callbackUrl, state: completion.state, pkce: { challenge: 'host-challenge', method: 'S256' } }, h.context))
      .resolves.toMatchObject({ status: 'awaitingOAuthRedirect' });
    expect(h.request).not.toHaveBeenCalled();
    await expect(h.mode.complete(completion, h.context)).resolves.toMatchObject({ status: 'connected', providerIdentity: { organizationId: accountId } });
    expect(h.staged.values.get('accountId')).toBe(accountId);
    expect(h.configuration.values.accountId).toBe(accountId);
    expect(h.request.mock.calls.some(([input]) => new URL(input.url).pathname === '/client/v4/accounts')).toBe(true);
  });

  it('offers all authorized accounts after consent and resumes the selected account without another code exchange', async () => {
    const h = await harness('workers', { withoutAccount: true });
    const secondId = 'b'.repeat(32);
    h.accounts([
      { success: true, result: [{ id: secondId, name: 'Second account' }], result_info: { page: 1, per_page: 1, total_count: 2 } },
      { success: true, result: [{ id: accountId, name: 'Test account' }], result_info: { page: 2, per_page: 1, total_count: 2 } },
    ]);
    const choice = await h.mode.complete(completion, h.context);
    expect(choice).toMatchObject({ status: 'configurationRequired', fields: [{ id: 'accountId', required: true,
      schema: { type: 'string', enum: [secondId, accountId] },
      presentation: { options: [{ value: secondId, title: 'Second account' }, { value: accountId, title: 'Test account' }] } }] });
    expect(h.staged.values.get('token')).toBe('access-private');
    h.configuration.values.accountId = accountId;
    if (!h.mode.reconcile) throw new Error('Cloudflare must resume account selection');
    await expect(h.mode.reconcile(h.context)).resolves.toMatchObject({ status: 'connected', providerIdentity: { organizationId: accountId } });
    expect(h.request.mock.calls.filter(([input]) => input.url.endsWith('/oauth2/token'))).toHaveLength(1);
  });

  it('rejects an empty authorized-account list without staging credentials', async () => {
    const h = await harness('workers', { withoutAccount: true });
    h.accounts([{ success: true, result: [], result_info: { page: 1, per_page: 20, total_count: 0 } }]);
    await expect(h.mode.complete(completion, h.context)).resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_missing_permissions' } });
    expect(h.staged.values.size).toBe(0);
  });

  it('keeps every authorized account when pagination metadata omits optional totals', async () => {
    const h = await harness('workers', { withoutAccount: true });
    const accounts = Array.from({ length: 51 }, (_, index) => ({ id: (index + 1).toString(16).padStart(32, '0'), name: `Account ${index + 1}` }));
    h.accounts([
      { success: true, result: accounts.slice(0, 50) },
      { success: true, result: accounts.slice(50), result_info: { page: 2, per_page: 50 } },
    ]);
    await expect(h.mode.complete(completion, h.context)).resolves.toMatchObject({ status: 'configurationRequired',
      fields: [{ schema: { enum: accounts.map(account => account.id) } }] });
  });
  it.each(['workers', 'pages'] as const)('retains the Home public %s client through callback, status, refresh and revoke after defaults change', async product => {
    const h = await harness(product, { byo: 'none', publicClient: true });
    const begun = await h.mode.begin({ callbackUrl, state: completion.state, pkce: { challenge: 'host-challenge', method: 'S256' } }, h.context);
    expect(begun.status).toBe('awaitingOAuthRedirect');
    if (begun.status !== 'awaitingOAuthRedirect') throw new Error('Expected public OAuth redirect');
    expect(new URL(begun.authorizationUrl).searchParams.get('client_id')).toBe('happier-public-client');
    expect(new URL(begun.authorizationUrl).searchParams.get('scope')).toBe(h.scopes);
    expect(h.staged.values.get('oauthClientId')).toBe('happier-public-client');
    expect(h.staged.values.get('oauthRegisteredScopes')).toBe(JSON.stringify(h.catalog.map(item => item.id)));
    expect(h.request).not.toHaveBeenCalled();
    h.publicClient({ clientId: 'replacement-public-client', scopes: ['different.write'] });
    expect(await h.mode.complete(completion, h.context)).toMatchObject({ status: 'connected', scopes: [product === 'workers' ? 'Workers' : 'Pages'] });
    for (const [key, value] of h.staged.values) await h.retained.store.set(key, value);
    h.staged.values.clear(); h.publicClient(null); h.request.mockClear();
    expect(await h.runtime.status(h.read)).toMatchObject({ status: 'connected' });
    h.token({ token_type: 'Bearer', access_token: 'refreshed-private', expires_in: 3600 });
    expect(await h.runtime.refresh(h.mutation)).toMatchObject({ status: 'connected', scopes: [product === 'workers' ? 'Workers' : 'Pages'] });
    expect(h.staged.values.get('oauthClientId')).toBe('happier-public-client');
    expect(h.staged.values.get('oauthRegisteredScopes')).toBe(JSON.stringify(h.catalog.map(item => item.id)));
    expect(await h.runtime.revoke(h.read)).toMatchObject({ status: 'remoteRevoked' });
    for (const [input] of h.request.mock.calls.filter(([request]) => /\/oauth2\/(token|revoke)$/u.test(request.url))) {
      expect(new URLSearchParams(new TextDecoder().decode(input.body)).get('client_id')).toBe('happier-public-client');
    }
    expect(h.getPublicOAuthClient).toHaveBeenCalledTimes(1);
  });

  it('leaves BYO and token recovery available when Home has no public OAuth client', async () => {
    const h = await harness('workers', { byo: 'none' });
    expect(await h.mode.begin({ callbackUrl, state: completion.state, pkce: { challenge: 'host-challenge', method: 'S256' } }, h.context))
      .toMatchObject({ status: 'unavailable', diagnostic: { code: 'cloudflare_oauth_public_client_unavailable' } });
    expect(h.request).not.toHaveBeenCalled(); expect(h.staged.values.size).toBe(0);
  });

  it('requires reconnect when Home public client custody is lost instead of selecting changed defaults at callback', async () => {
    const h = await harness('workers', { byo: 'none', publicClient: true });
    expect(await h.mode.begin({ callbackUrl, state: completion.state, pkce: { challenge: 'host-challenge', method: 'S256' } }, h.context))
      .toMatchObject({ status: 'awaitingOAuthRedirect' });
    h.staged.values.clear();
    h.publicClient({ clientId: 'replacement-public-client', scopes: h.catalog.map(item => item.id) });
    expect(await h.mode.complete(completion, h.context))
      .toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_oauth_reconnect_required' } });
    expect(h.getPublicOAuthClient).toHaveBeenCalledTimes(1);
    expect(h.request).not.toHaveBeenCalled(); expect(h.staged.values.size).toBe(0);
  });

  it.each(['client-only', 'scopes-only'] as const)('refuses partial BYO %s instead of silently using Home defaults', async byo => {
    const h = await harness('workers', { byo, publicClient: true });
    expect(await h.mode.begin({ callbackUrl, state: completion.state, pkce: { challenge: 'host-challenge', method: 'S256' } }, h.context))
      .toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_invalid_configuration' } });
    expect(h.getPublicOAuthClient).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled(); expect(h.staged.values.size).toBe(0);
  });

  it.each(['workers', 'pages'] as const)('connects %s with exact registered scopes and host PKCE, without claiming effective write rights', async product => {
    const h = await harness(product);
    const descriptor = entry.manifest.contributes?.connectedAccountDescriptors?.[0] as PluginConnectedAccountDescriptorContributionV2;
    expect(descriptor.authentication.modes.find(mode => mode.id === 'oauth')).toMatchObject({
      kind: 'oauthAuthorizationCode', callbackUrl, pkce: 'required', scopes: ['openid', 'offline_access'],
    });
    const begun = await h.mode.begin({ callbackUrl, state: completion.state, pkce: { challenge: 'host-challenge', method: 'S256' } }, h.context);
    expect(begun).toMatchObject({ status: 'awaitingOAuthRedirect', issuer: 'https://dash.cloudflare.com' });
    if (begun.status !== 'awaitingOAuthRedirect') throw new Error('Expected OAuth redirect');
    expect(Object.fromEntries(new URL(begun.authorizationUrl).searchParams)).toMatchObject({
      client_id: 'registered-client', redirect_uri: callbackUrl, scope: h.scopes, state: completion.state,
      code_challenge: 'host-challenge', code_challenge_method: 'S256', response_type: 'code',
    });
    expect(h.request).not.toHaveBeenCalled(); expect(h.staged.values.size).toBe(0);
    const result = await h.mode.complete(completion, h.context);
    expect(result).toMatchObject({ status: 'connected', providerIdentity: { accountId: 'user-identity', organizationId: accountId }, scopes: product === 'workers' ? ['Workers'] : ['Pages'] });
    expect(result).not.toHaveProperty('deploymentPermissions');
    expect(h.staged.values.get('token')).toBe('access-private');
    expect(h.staged.values.get('refreshToken')).toBe('refresh-private');
    const input = h.request.mock.calls[0]![0];
    expect(input).toMatchObject({ method: 'POST', url: 'https://dash.cloudflare.com/oauth2/token', redirect: 'error' });
    expect(new URLSearchParams(new TextDecoder().decode(input.body)).get('code_verifier')).toBe('host-verifier');
    expect(new TextDecoder().decode(input.body)).not.toContain('client_secret');
    expect(h.request.mock.calls.some(([input]) => /tokens\/|members|roles|checkPermissions/u.test(input.url))).toBe(false);
  });

  it('reports all granted features from one browser authorization and retains raw grants for refresh', async () => {
    const h = await harness();
    h.catalog.push({ id: 'page.write', name: 'Pages Write', scopes: ['com.cloudflare.api.account'] });
    h.catalog.push({ id: 'tunnel.write', name: 'Cloudflare Tunnel Write', scopes: ['com.cloudflare.api.account'] });
    h.catalog.push({ id: 'dns.write', name: 'DNS Write', scopes: ['com.cloudflare.api.account.zone'] });
    const scopes = `${h.scopes} page.write tunnel.write dns.write`;
    h.configuration.values.registeredScopes = h.catalog.map(item => item.id).join(' ');
    h.token({ token_type: 'Bearer', access_token: 'access-private', refresh_token: 'refresh-private', expires_in: 3600, scope: scopes });
    await expect(h.mode.complete(completion, h.context)).resolves.toMatchObject({ status: 'connected', scopes: ['Workers', 'Pages', 'Tunnel', 'DNS'] });
    expect(JSON.parse(h.staged.values.get('scopes')!)).toEqual(scopes.split(' '));
  });

  it('accepts an authorization where an optional unrelated feature scope was declined', async () => {
    const h = await harness();
    h.catalog.push({ id: 'page.write', name: 'Pages Write', scopes: ['com.cloudflare.api.account'] });
    h.configuration.values.registeredScopes = h.catalog.map(item => item.id).join(' ');
    await expect(h.mode.complete(completion, h.context)).resolves.toMatchObject({ status: 'connected', scopes: ['Workers'] });
  });

  it.each(['identity-only', 'partial', 'malformed', 'wrong-account', 'missing-identity'] as const)('refuses %s before staging, without treating the catalog as token grants', async failure => {
    const h = await harness();
    h.token({ token_type: 'Bearer', access_token: 'access-private', refresh_token: 'refresh-private', expires_in: 3600,
      scope: failure === 'identity-only' ? 'openid offline_access' : failure === 'partial' ? 'openid offline_access account-settings.read workers-scripts.write' : failure === 'malformed' ? [h.scopes] : h.scopes });
    if (failure === 'wrong-account') h.account({ success: true, result: { id: 'b'.repeat(32), name: 'Wrong account' } });
    if (failure === 'missing-identity') h.identity({ email: 'not-a-subject' });
    const result = await h.mode.complete(completion, h.context);
    expect(result.status).not.toBe('connected'); expect(h.staged.values.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain('access-private');
  });

  it('expires without idle requests, refreshes through staged custody and preserves an unrotated refresh token', async () => {
    const h = await harness();
    await h.mode.complete(completion, h.context);
    for (const [key, value] of h.staged.values) await h.retained.store.set(key, value);
    h.staged.values.clear(); h.request.mockClear(); vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(3_600_001);
    expect(h.request).not.toHaveBeenCalled();
    expect(await h.runtime.status(h.read)).toMatchObject({ status: 'expired' });
    await expect(h.runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.cloudflare.com', headerNames: ['authorization'] }, h.read)).rejects.toThrow();
    h.token({ token_type: 'Bearer', access_token: 'next-private', expires_in: 3600, scope: h.scopes });
    expect(await h.runtime.refresh(h.mutation)).toMatchObject({ status: 'connected' });
    expect(h.staged.values.get('token')).toBe('next-private');
    expect(h.staged.values.get('refreshToken')).toBe('refresh-private');
    expect(h.retained.values.get('token')).toBe('access-private');
    expect(new URLSearchParams(new TextDecoder().decode(h.request.mock.calls[0]![0].body))).toEqual(new URLSearchParams({ grant_type: 'refresh_token', client_id: 'registered-client', refresh_token: 'refresh-private' }));
  });

  it('settles revoked refresh and denied account access with typed reconnect/missing-permission, without retries or provider echoes', async () => {
    const h = await harness(); await h.retained.store.set('refreshToken', 'refresh-private');
    h.request.mockImplementationOnce(async input => ({ status: 400, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh-private' })) }));
    expect(await h.runtime.refresh(h.mutation)).toMatchObject({ status: 'reconnectRequired', diagnostic: { code: 'cloudflare_oauth_reconnect_required' } });
    expect(h.request).toHaveBeenCalledTimes(1); expect(h.staged.values.size).toBe(0);
    const send = h.request.getMockImplementation()!;
    h.request.mockImplementation(async input => input.url.includes(`/accounts/${accountId}`)
      ? { status: 403, finalUrl: input.url, headers: {}, body: new TextEncoder().encode('access-private') } : send(input));
    expect(await h.mode.complete(completion, h.context)).toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_missing_permissions' } });
    expect(h.staged.values.size).toBe(0);
  });

  it('revokes the refresh grant once and keeps an ambiguous response unknown', async () => {
    const h = await harness(); await h.retained.store.set('refreshToken', 'refresh-private');
    expect(await h.runtime.revoke(h.read)).toMatchObject({ status: 'remoteRevoked' });
    expect(h.request).toHaveBeenCalledTimes(1);
    const input = h.request.mock.calls[0]![0];
    expect(input.url).toBe('https://dash.cloudflare.com/oauth2/revoke');
    expect(new URLSearchParams(new TextDecoder().decode(input.body)).get('token_type_hint')).toBe('refresh_token');
    h.request.mockRejectedValueOnce(new Error('refresh-private'));
    const result = await h.runtime.revoke(h.read);
    expect(result.status).toBe('outcomeUnknown'); expect(JSON.stringify(result)).not.toContain('refresh-private');
    expect(h.request).toHaveBeenCalledTimes(2);
    h.request.mockImplementationOnce(async input => ({ status: 403, finalUrl: input.url, headers: {}, body: new TextEncoder().encode('refresh-private') }));
    expect(await h.runtime.revoke(h.read)).toMatchObject({ status: 'remoteUnsupported', diagnostic: { code: 'cloudflare_missing_permissions' } });
    expect(h.request).toHaveBeenCalledTimes(3);
  });

  it('does not extend token expiry by the time spent verifying identity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const h = await harness(); const send = h.request.getMockImplementation()!;
    h.request.mockImplementation(async input => {
      if (input.url.endsWith('/userinfo')) vi.setSystemTime(160_000);
      return send(input);
    });
    expect(await h.mode.complete(completion, h.context)).toMatchObject({ status: 'connected' });
    expect(h.staged.values.get('expiresAtMs')).toBe(String(100_000 + 3600_000));
  });

  it('stops cancelled exchange before identity reads or staging', async () => {
    const h = await harness();
    const send = h.request.getMockImplementation()!;
    h.request.mockImplementationOnce(async input => { h.controller.abort(); return send(input); });
    await expect(h.mode.complete(completion, h.context)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.request).toHaveBeenCalledTimes(1); expect(h.staged.values.size).toBe(0);
  });

  it('honors operation cancellation before refresh or revocation sends', async () => {
    const h = await harness(); const controller = new AbortController(); controller.abort();
    await expect(h.runtime.refresh(h.mutation, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(h.runtime.revoke(h.read, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.request).not.toHaveBeenCalled(); expect(h.staged.values.size).toBe(0);
  });
});
