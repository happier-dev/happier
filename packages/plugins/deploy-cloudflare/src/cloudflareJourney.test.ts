import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountCredentialStore, ConnectedAccountPortableRuntime, ConnectedAccountReadContext, PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { manifest } from './manifest.js';
import { activate, activateAccount } from './activate.js';
import { listConnectedAccountSecretCredentialKeysV1, PluginConnectedAccountDescriptorContributionV2Schema, resolveConnectedAccountAuthenticationModeMachineRequirement } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { PluginError, readActionOutputDiagnostic } from '@happier-dev/plugin-sdk/errors';

const accountId = 'a'.repeat(32);
const tokenId = 'b'.repeat(32);
const zoneId = 'd'.repeat(32);
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

async function harness(product: 'workers' | 'pages' | 'tunnel' = 'workers') {
  let accountRuntime: ConnectedAccountPortableRuntime | undefined;
  const kit = await createPluginTestkit({ manifest, module: { activate,
    activateAccount(api, account) {
      return activateAccount({ ...api, connectedAccounts: { register(localId, runtime) {
        if (localId === 'cloudflare') accountRuntime = runtime;
        return api.connectedAccounts.register(localId, runtime);
      } } }, account);
    },
  } });
  kits.push(kit);
  const runtime = kit.registration('connectedAccountDescriptors', 'cloudflare');
  expect(runtime, 'the real activation must register the Cloudflare Connected Account runtime').toBeDefined();
  if (!runtime) throw new Error('Missing Cloudflare Connected Account runtime');
  const modeId = 'token';
  const mode = runtime.authentication.modes[modeId];
  expect(mode, `the selected ${modeId} authentication mode must be registered`).toMatchObject({ kind: 'manual' });
  if (!mode || mode.kind !== 'manual') throw new Error('Missing Cloudflare token mode');
  const staged = credentials();
  const request = vi.fn(async (input: HttpRequest) => {
    expect(staged.values.size, 'the complete probe precedes every credential write').toBe(0);
    let result: unknown;
    if (input.url.endsWith('/verify')) result = { id: tokenId, status: 'active' };
    else if (input.url.endsWith(`/zones/${zoneId}`)) result = { id: zoneId, name: 'example.test', account: { id: accountId, name: 'Test account' } };
    else if (input.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${accountId}/`)
      && /\/(workers\/scripts|pages\/projects|cfd_tunnel)$/u.test(input.url)) result = [];
    else return { status: 403, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: false,
      errors: [{ code: 10000, message: 'Authentication error private-token-echo' }], result: null })) };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, errors: [], messages: [], result })) };
  });
  // Only the HTTP and credential-store boundaries are supplied; the runtime is
  // obtained from definePlugin's actual activation and executes its real logic.
  const services = new Proxy({ http: createPluginHttpFixture({ request }) } as ConnectedAccountReadContext['services'], {
    get(target, key) { if (key === 'http') return target.http; throw new Error('Unexpected host service'); },
  });
  const context: ConnectedAccountAuthenticationContext = {
    plugin: { id: service.pluginId, version: '0.0.0' },
    contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
    surface: 'ui', invokedAtMs: Date.now(),
    service, attempt: { kind: 'connect', attemptId: 'cloudflare-connect' },
    configuration: { target: { kind: 'service', service, modeId }, revision: 'config-1', values: { accountId, tokenOwner: product === 'pages' ? 'account' : 'user', features: product === 'workers' ? ['Workers'] : product === 'pages' ? ['Pages'] : ['Tunnel', 'DNS'], ...(product === 'tunnel' ? { zoneId } : {}) }, async getSecret() { return null; } },
    signal: new AbortController().signal, attemptCredentials: staged.store,
    services,
  };
  return { runtime, accountRuntime, mode, context, services, staged, request };
}

describe('Cloudflare Connected Account through plugin activation', () => {
  it('places browser verification on a Machine while native clients retain Account execution', () => {
    const modes = PluginConnectedAccountDescriptorContributionV2Schema.parse(manifest.contributes?.connectedAccountDescriptors?.[0]).authentication.modes;
    expect(modes.length).toBeGreaterThan(0);
    for (const mode of modes) {
      expect(resolveConnectedAccountAuthenticationModeMachineRequirement(mode, true)).toBe('browser_unreachable');
      expect(resolveConnectedAccountAuthenticationModeMachineRequirement(mode, false)).toBeNull();
    }
  });

  it('allows a saved Secret to supply the API token field', () => {
    const { authentication } = PluginConnectedAccountDescriptorContributionV2Schema.parse(
      manifest.contributes?.connectedAccountDescriptors?.[0],
    );
    const mode = authentication.modes.find(mode => mode.id === 'token');
    expect(listConnectedAccountSecretCredentialKeysV1(mode).get('token')).toBe('token');
  });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'plugin_fetch_redirect_refused'])('retains the typed %s cause without credential echoes', async code => {
    const h = await harness();
    h.request.mockRejectedValueOnce(code === 'plugin_fetch_redirect_refused'
      ? new PluginError({ code, message: 'private-token-echo' })
      : Object.assign(new Error('private-token-echo'), { code }));
    const result = await h.mode.complete({ fields: { token: 'private-token-echo' } }, h.context);
    expect(result).toMatchObject({ status: 'unavailable', diagnostic: { code,
      details: { failureCause: { errorCode: code } } } });
    expect(JSON.stringify(result)).not.toContain('private-token-echo');
    expect(h.staged.values.size).toBe(0);
  });

  it('retains credential acquisition failures during health checks', async () => {
    const h = await harness();
    const credentials = { ...h.staged.store, async get() { throw new PluginError({ code: 'credential_unavailable', message: 'private-token-echo' }); } };
    const result = await h.runtime.status({ ...h.context, credentials, account: { service, accountId: 'connected' } });
    expect(result).toMatchObject({ status: 'unavailable', diagnostic: { code: 'credential_unavailable',
      details: { failureCause: { errorCode: 'credential_unavailable' } } } });
    expect(JSON.stringify(result)).not.toContain('private-token-echo');
  });
  it.each(['workers', 'pages', 'tunnel'] as const)('connects %s without token inspection rights and probes only selected resources', async product => {
    const h = await harness(product);
    const scopes = product === 'workers' ? ['Workers'] : product === 'pages' ? ['Pages'] : ['Tunnel', 'DNS'];
    await expect(h.mode.complete({ fields: { token: 'least-privilege-test-token' } }, h.context))
      .resolves.toMatchObject({ status: 'connected', displayName: accountId, providerIdentity: { accountId }, scopes });
    expect(h.staged.values.get('token')).toBe('least-privilege-test-token');
    const base = 'https://api.cloudflare.com/client/v4';
    const tokenBase = product === 'pages' ? `accounts/${accountId}` : 'user';
    const resource = product === 'workers' ? 'workers/scripts' : product === 'pages' ? 'pages/projects' : 'cfd_tunnel';
    expect(h.request.mock.calls.map(([r]) => r.url)).toEqual([
      `${base}/${tokenBase}/tokens/verify`,
      `${base}/accounts/${accountId}/${resource}`, ...(product === 'tunnel' ? [`${base}/zones/${zoneId}`] : []),
    ]);
  });

  it('reads every explicitly selected feature without inferring write grants', async () => {
    const h = await harness('tunnel'); const features = ['Workers', 'Pages', 'Tunnel', 'DNS'];
    await expect(h.mode.complete({ fields: { token: 'multi-feature-test-token' } }, { ...h.context,
      configuration: { ...h.context.configuration, values: { accountId, zoneId, features } },
    })).resolves.toMatchObject({ status: 'connected', scopes: features });
    expect(h.request.mock.calls).toHaveLength(5);
  });

  it.each([{ values: { accountId }, scopes: [], reads: 1 }, { values: { accountId, zoneId }, scopes: ['DNS'], reads: 2 }])('keeps identity and an existing selected zone readable without feature configuration', async ({ values, scopes, reads }) => {
    const h = await harness();
    await expect(h.mode.complete({ fields: { token: 'identity-test-token' } }, { ...h.context,
      configuration: { ...h.context.configuration, values },
    })).resolves.toMatchObject({ status: 'connected', scopes });
    expect(h.request.mock.calls).toHaveLength(reads);
  });

  it('returns a typed refusal for a denied selected resource without staging or reflecting content', async () => {
    const h = await harness(); const send = h.request.getMockImplementation()!;
    h.request.mockImplementation(async input => input.url.endsWith('/workers/scripts')
      ? { status: 403, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: false,
        errors: [{ code: 10000, message: 'Authentication error private-token-echo' }], result: null })) } : send(input));
    const result = await h.mode.complete({ fields: { token: 'private-token-echo' } }, h.context);
    expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_missing_permissions' } });
    expect(JSON.stringify(result)).not.toContain('private-token-echo'); expect(h.staged.values.size).toBe(0);
  });

  it.each([{ status: 'disabled' }, { status: 'active', expires_on: '2000-01-01T00:00:00Z' },
    { status: 'active', not_before: '2999-01-01T00:00:00Z' }])('rejects inactive, expired and not-yet-active tokens before resource reads', async verified => {
    const h = await harness();
    h.request.mockImplementationOnce(async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: { id: tokenId, ...verified } })) }));
    await expect(h.mode.complete({ fields: { token: 'inactive-test-token' } }, h.context))
      .resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_token_rejected' } });
    expect(h.staged.values.size).toBe(0); expect(h.request.mock.calls).toHaveLength(1);
  });

  it('retains the verified token expiry for later materialization', async () => {
    const h = await harness(); const expires = '2999-01-01T00:00:00Z';
    h.request.mockImplementationOnce(async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { id: tokenId, status: 'active', expires_on: expires } })) }));
    await expect(h.mode.complete({ fields: { token: 'expiring-test-token' } }, h.context)).resolves.toMatchObject({ status: 'connected' });
    expect(h.staged.values.get('expiresAtMs')).toBe(String(Date.parse(expires)));
  });

  it('refuses Workers Builds for an account-owned token before staging', async () => {
    const h = await harness('pages');
    await expect(h.mode.complete({ fields: { token: 'account-test-token' } }, { ...h.context,
      configuration: { ...h.context.configuration, values: { accountId, tokenOwner: 'account', features: ['Workers'] } },
    })).resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_builds_user_token_required' } });
    expect(h.staged.values.size).toBe(0);
  });

  it.each([{ id: zoneId, account: { id: 'f'.repeat(32) } },
    { id: 'f'.repeat(32), account: { id: accountId } }])('refuses a mismatched selected zone identity %j', async identity => {
    const h = await harness('tunnel');
    const send = h.request.getMockImplementation()!;
    h.request.mockImplementation(async input => input.url.endsWith(`/zones/${zoneId}`)
      ? { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
        result: { ...identity, name: 'example.test' } })) }
      : send(input));
    await expect(h.mode.complete({ fields: { token: 'cross-account-zone-token' } }, h.context)).resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_missing_permissions' } });
    expect(h.staged.values.size).toBe(0);
  });
  it('offers a single browser method and API token form through the admitted manifest', () => {
    const declaration = manifest.contributes?.connectedAccountDescriptors?.find(item => item.id === 'cloudflare') as PluginConnectedAccountDescriptorContributionV2 | undefined;
    expect(declaration?.authentication.modes.map(mode => mode.id)).toEqual(['oauth', 'token']);
  });

  it('refuses a selected account outside the token product scope before any staging', async () => {
    const h = await harness('pages');
    await expect(h.mode.complete({ fields: { token: 'test-token' } }, { ...h.context,
      configuration: { ...h.context.configuration, values: { accountId: 'f'.repeat(32), tokenOwner: 'user', features: ['Pages'] } },
    })).resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_missing_permissions' } });
    expect(h.staged.values.size).toBe(0);
  });

  it.each(['workers', 'pages'] as const)('rejects Cloudflare malformed Authorization responses before staging a %s token', async product => {
    const h = await harness(product);
    // Observed with a deliberately fake token at the public verification endpoint, 2026-11-04.
    h.request.mockImplementationOnce(async () => ({ status: 400, headers: {}, body: new TextEncoder().encode(JSON.stringify({
      success: false, errors: [{ code: 6003, message: 'Invalid request headers',
        error_chain: [{ code: 6111, message: 'Invalid format for Authorization header' }] }], messages: [], result: null,
    })) }));
    const result = await h.mode.complete({ fields: { token: 'not-a-real-cloudflare-token' } }, h.context);
    expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_token_rejected' } });
    expect(h.staged.values.size).toBe(0);
    expect(h.request.mock.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('not-a-real-cloudflare-token');
  });

  it.each([400, 403, 429, 503])('keeps an unclassified verification failure (%s) unavailable without staging', async status => {
    const h = await harness();
    h.request.mockImplementationOnce(async () => ({ status, headers: {}, body: new TextEncoder().encode(JSON.stringify({
      success: false, errors: [{ code: 1000, message: 'Provider request unavailable' }], result: null,
    })) }));
    await expect(h.mode.complete({ fields: { token: 'not-a-real-cloudflare-token' } }, h.context))
      .resolves.toMatchObject({ status: 'unavailable', diagnostic: { code: 'cloudflare_http_error', details: { failureCause: { httpStatus: status } } } });
    expect(h.staged.values.size).toBe(0);
  });

  it.each(['<html>unexpected response</html>', '{"success":true}', '{"success":true,"result":{}}'])(
    'reports a malformed HTTP 200 verification response without staging credentials', async body => {
      const h = await harness();
      h.request.mockImplementationOnce(async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(body) }));
      await expect(h.mode.complete({ fields: { token: 'test-token' } }, h.context))
        .resolves.toMatchObject({ status: 'unavailable', diagnostic: { code: 'cloudflare_invalid_response' } });
      expect(h.staged.values.size).toBe(0);
    });

  it('keeps an unclassified selected-resource 403 unavailable without staging', async () => {
    const h = await harness(); const send = h.request.getMockImplementation()!;
    h.request.mockImplementation(async input => input.url.endsWith('/workers/scripts')
      ? { status: 403, headers: {}, body: new TextEncoder().encode('private-token-echo') } : send(input));
    const result = await h.mode.complete({ fields: { token: 'private-token-echo' } }, h.context);
    expect(result).toMatchObject({ status: 'unavailable', diagnostic: { code: 'cloudflare_http_error',
      details: { failureCause: { httpStatus: 403 } } } });
    expect(h.staged.values.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain('private-token-echo');
  });

  it('does not stage credentials or reflect provider echoes on denied verification or network failures', async () => {
    const h = await harness();
    h.request.mockImplementationOnce(async () => ({ status: 403, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: false,
      errors: [{ code: 10000, message: 'Authentication error echoed-secret-test-token' }], result: null })) }));
    const result = await h.mode.complete({ fields: { token: 'echoed-secret-test-token' } }, h.context);
    expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: 'cloudflare_token_rejected' } });
    expect(JSON.stringify(result)).not.toContain('echoed-secret-test-token');
    expect(h.staged.values.size).toBe(0);
    h.request.mockRejectedValueOnce(new Error('echoed-secret-test-token'));
    const failed = await h.mode.complete({ fields: { token: 'echoed-secret-test-token' } }, h.context);
    expect(failed).toMatchObject({ status: 'unavailable', diagnostic: { code: 'action_failed' } });
    expect(readActionOutputDiagnostic(failed)).toMatchObject({ phase: 'cloudflare.verification' });
    expect(JSON.stringify(failed)).not.toContain('echoed-secret-test-token');
    expect(h.staged.values.size).toBe(0);
  });

  it('stops cancellation before the next provider read or credential stage', async () => {
    const h = await harness(); const controller = new AbortController();
    h.request.mockImplementationOnce(async () => { controller.abort(); return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: { id: tokenId, status: 'active' } })) }; });
    await expect(h.mode.complete({ fields: { token: 'cancelled-test-token' } }, { ...h.context, signal: controller.signal })).rejects.toThrow();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.staged.values.size).toBe(0);
  });

  it('leaves reconnect identity with the host and returns the actual provider identity', async () => {
    const h = await harness();
    await expect(h.mode.complete({ fields: { token: 'wrong-account-test-token' } }, { ...h.context,
      attempt: { kind: 'reconnect', attemptId: 'reconnect', account: { service, accountId: 'd'.repeat(32) } },
    })).resolves.toMatchObject({ status: 'connected', providerIdentity: { accountId } });
    expect(h.staged.values.get('token')).toBe('wrong-account-test-token');
  });

  it.each(['daemon', 'account'] as const)('uses only admitted API headers through %s activation, marks expired credentials and makes no idle provider requests', async target => {
    const h = await harness();
    await h.mode.complete({ fields: { token: 'materialize-test-token' } }, h.context);
    const context: ConnectedAccountReadContext = { ...h.context, services: h.services, account: { service, accountId }, credentials: h.staged.store };
    const runtime = target === 'account' ? h.accountRuntime : h.runtime;
    if (!runtime?.materialize) throw new Error('Missing activated Cloudflare materialization runtime');
    h.request.mockClear();
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.cloudflare.com', headerNames: ['authorization'] }, context)).resolves.toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer materialize-test-token' } });
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.cloudflare.com.attacker.test', headerNames: ['authorization'] }, context)).rejects.toThrow();
    await expect(runtime.materialize({ kind: 'environment', keys: ['CLOUDFLARE_API_TOKEN'] }, context)).rejects.toThrow();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).not.toHaveBeenCalled();
    await h.staged.store.set('expiresAtMs', String(Date.now() - 1));
    await expect(h.runtime.status(context)).resolves.toMatchObject({ status: 'expired' });
    await expect(h.runtime.refresh({ ...context, operation: { operationId: 'refresh', configurationRevision: 'config-1' }, stagedCredentials: credentials().store })).resolves.toMatchObject({ status: 'reconnectRequired', diagnostic: { code: 'cloudflare_token_rejected' } });
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.cloudflare.com', headerNames: ['authorization'] }, context)).rejects.toThrow();
    expect(h.request).not.toHaveBeenCalled();
  });
});
