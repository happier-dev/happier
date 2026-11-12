import { describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/plugin-sdk/errors';
import { createKimiConnectedAccountRuntime } from './runtime.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

function store(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, async get(key: string) { return values.get(key) ?? null; }, async set(key: string, value: string) { values.set(key, value); }, async delete(key: string) { values.delete(key); } };
}
function context(credentials = store()) {
  const account = { service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'fake-account' };
  return { account, credentials, configuration: { target: { kind: 'account' as const, account, modeId: 'api-key' }, revision: '1', values: {}, async getSecret() { return null; } }, signal: new AbortController().signal, invokedAtMs: 1800000000000 };
}

describe('Kimi connected service', () => {
  it('delivers regional Code-key endpoints without exposing refresh material', async () => {
    const runtime = createKimiConnectedAccountRuntime();
    const ctx = { ...context(store({ accessToken: 'fake-code', refreshToken: 'fake-root', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' })), services: {} } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    expect(await runtime.materialize({ kind: 'environment', keys: ['KIMI_API_KEY', 'KIMI_CODE_BASE_URL', 'KIMI_CODE_ANTHROPIC_BASE_URL'] }, ctx)).toEqual({ kind: 'environment', env: {
      KIMI_API_KEY: 'fake-code', KIMI_CODE_BASE_URL: 'https://api.kimi.ai/coding/v1', KIMI_CODE_ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding/',
    } });
  });
  it('keeps an unknown credential kind usable for selected Code-key delivery', async () => {
    const runtime = createKimiConnectedAccountRuntime();
    const ctx = { ...context(store({ accessToken: 'fake-unknown', apiKind: 'code' })), services: {} } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    expect(await runtime.materialize({ kind: 'environment', keys: ['KIMI_API_KEY'] }, ctx)).toEqual({ kind: 'environment', env: { KIMI_API_KEY: 'fake-unknown' } });
  });
  it('uses one install id through device begin, pending, slow-down, success and headers', async () => {
    const runtime = createKimiConnectedAccountRuntime();
    const credentials = store();
    const calls: string[] = [];
    const responses = [
      { device_code: 'fake-device', user_code: 'FAKE-CODE', verification_uri: 'https://vendor.example/activate', expires_in: 600, interval: 2 },
      { error: 'authorization_pending' }, { error: 'slow_down' },
      { access_token: 'fake-selected', refresh_token: 'fake-root', expires_in: 3600, scope: 'coding offline_access', token_type: 'Bearer' },
    ];
    const mode = runtime.authentication.modes.device;
    expect(mode).toBeDefined();
    if (mode.kind !== 'oauthDeviceCode') throw new Error('device mode missing');
    const daemon = store();
    const ctx = { ...context(credentials), service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, attemptCredentials: credentials, attempt: { kind: 'connect', attemptId: 'fake' }, services: { storage: { daemon: { async transaction<T>(work: (scope: ReturnType<typeof store>) => Promise<T>) { return work(daemon); } } }, http: { async request(input: { headers?: Record<string, string>; url: string }) {
      calls.push(input.headers?.['X-Msh-Device-Id'] ?? '');
      const body = responses.shift();
      return { status: body && 'error' in body ? 400 : 200, headers: {}, finalUrl: input.url, body: new TextEncoder().encode(JSON.stringify(body)) };
    } } } } as Parameters<typeof mode.begin>[0];
    expect(await mode.begin(ctx)).toMatchObject({ status: 'awaitingDeviceAuthorization', pollIntervalMs: 2000 });
    expect(await mode.poll(ctx)).toMatchObject({ status: 'pending', retryAfterMs: 2000 });
    expect(await mode.poll(ctx)).toMatchObject({ status: 'pending', retryAfterMs: 7000 });
    const connected = await mode.poll(ctx);
    expect(connected).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
    if (connected.status !== 'connected') throw new Error('Kimi grant was not connected');
    const purpose = PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'kimi')?.connectedAccounts?.[0];
    expect(purpose?.credentialKinds).toContain(connected.credentialKind);
    expect(new Set(calls).size).toBe(1);
    expect(calls[0]).not.toBe('');
    expect(credentials.values.get('deviceId')).toBe(calls[0]);
    expect(credentials.values.has('deviceCode')).toBe(false);
    expect(daemon.values.get('kimi-device-id')).toBe(calls[0]);
    expect(credentials.values.get('scope')).toBe('coding offline_access');
    expect(credentials.values.get('tokenType')).toBe('Bearer');
    expect(credentials.values.get('oauthHost')).toBe('https://auth.kimi.com');
  });
  it('reports manual credential kind and never exchanges or refreshes a key', async () => {
    const runtime = createKimiConnectedAccountRuntime();
    const credentials = store();
    const mode = runtime.authentication.modes['api-key'];
    if (mode.kind !== 'manual') throw new Error('manual mode missing');
    const input = { ...context(credentials), attemptCredentials: credentials, services: {}, attempt: { kind: 'connect', attemptId: 'fake' }, service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' } } as Parameters<typeof mode.complete>[1];
    const connected = await mode.complete({ fields: { token: 'fake-key' } }, input);
    expect(connected).toMatchObject({ status: 'connected', credentialKind: 'token' });
    if (connected.status !== 'connected') throw new Error('Kimi key was not connected');
    const purpose = PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'kimi')?.connectedAccounts?.[0];
    expect(purpose?.credentialKinds).toContain(connected.credentialKind);
    expect(await runtime.refresh({ ...context(credentials), stagedCredentials: store(), operation: { operationId: 'fake', configurationRevision: '1' }, services: {} } as Parameters<ConnectedAccountRuntime['refresh']>[0])).toMatchObject({ status: 'connected', credentialKind: 'token' });
    expect(credentials.values.has('refreshToken')).toBe(false);
    expect(await runtime.materialize({ kind: 'environment', keys: ['KIMI_API_KEY', 'HAPPIER_KIMI_ACCESS_TOKEN', 'UNRELATED_KEY'] },
      { ...context(credentials), services: {} } as Parameters<ConnectedAccountRuntime['materialize']>[1])).toEqual({
      kind: 'environment', env: { KIMI_API_KEY: 'fake-key', HAPPIER_KIMI_ACCESS_TOKEN: 'fake-key' },
    });
  });
  it.each([
    { credentialKind: 'oauth', apiKind: 'code' },
    { credentialKind: 'token', apiKind: 'platform' },
  ])('refuses to relabel $credentialKind/$apiKind credentials as a Code API key', async row => {
    const runtime = createKimiConnectedAccountRuntime();
    const ctx = { ...context(store({ accessToken: 'fake-selected', ...row })), services: {} } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    await expect(runtime.materialize({ kind: 'environment', keys: ['KIMI_API_KEY'] }, ctx)).rejects.toMatchObject({
      code: 'kimi_code_api_key_unavailable',
    });
    expect(await runtime.materialize({ kind: 'environment', keys: ['HAPPIER_KIMI_ACCESS_TOKEN'] }, ctx)).toEqual({
      kind: 'environment', env: { HAPPIER_KIMI_ACCESS_TOKEN: 'fake-selected' },
    });
  });
  it('materializes selected regional headers and refuses a foreign origin', async () => {
    const runtime = createKimiConnectedAccountRuntime();
    const ctx = { ...context(store({ accessToken: 'fake-b', credentialKind: 'oauth', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1', deviceId: 'fake-install' })), services: {} } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    expect(await runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.kimi.ai', headerNames: ['Authorization', 'X-Msh-Device-Id'] }, ctx)).toMatchObject({ kind: 'httpHeaders', headers: { Authorization: 'Bearer fake-b', 'X-Msh-Device-Id': 'fake-install' } });
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://foreign.example', headerNames: ['Authorization'] }, ctx)).rejects.toThrow();
  });
  it.each([
    { status: 503, limitCategory: 'capacity', retryable: true },
    { status: 401, limitCategory: 'auth_invalid', retryable: false },
    { status: 429, limitCategory: 'rate_limit', retryable: true },
  ])('preserves a failed model request as provider evidence ($status)', async row => {
    const runtime = createKimiConnectedAccountRuntime();
    const ctx = { ...context(store({ accessToken: 'fake-selected', apiBase: 'https://api.kimi.ai/coding/v1' })),
      services: { http: { async request(input: { url: string }) {
        return { status: row.status, headers: {}, finalUrl: input.url,
          body: new TextEncoder().encode('fake-private-vendor-body') };
      } } },
    } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    const error = await runtime.materialize({ kind: 'files', fileIds: ['config.toml'] }, ctx).catch(error => error);
    expect(error).toMatchObject({ code: 'provider_unavailable', retryable: row.retryable,
      details: { httpStatus: row.status, limitCategory: row.limitCategory } });
    expect(readUnexpectedActionErrorDiagnosticV1(error)).toMatchObject({ httpStatus: row.status });
    expect(JSON.stringify(error)).not.toContain('fake-private-vendor-body');
    expect(JSON.stringify(error)).not.toContain('fake-selected');
  });
  it.each([{ status: 403, error: 'policy_refusal', result: 'outcomeUnknown' }, { status: 400, error: 'invalid_grant', result: 'reconnectRequired' }, { status: 429, error: 'rate_limited', result: 'outcomeUnknown' }])('uses terminal grant evidence for refresh ($status $error)', async row => {
    const runtime = createKimiConnectedAccountRuntime();
    const ctx = { ...context(store({ accessToken: 'fake-old', refreshToken: 'fake-root', credentialKind: 'oauth', apiBase: 'https://api.kimi.com/coding/v1' })), stagedCredentials: store(), operation: { operationId: 'fake', configurationRevision: '1' }, services: { http: { async request() { return { status: row.status, headers: {}, finalUrl: 'https://auth.kimi.com/api/oauth/token', body: new TextEncoder().encode(JSON.stringify({ error: row.error })) }; } } } } as Parameters<ConnectedAccountRuntime['refresh']>[0];
    expect(await runtime.refresh(ctx)).toMatchObject({ status: row.result });
  });
  it('rotates access credentials while retaining refresh when the response omits it', async () => {
    const runtime = createKimiConnectedAccountRuntime();
    const staged = store();
    const ctx = { ...context(store({ accessToken: 'fake-old', refreshToken: 'fake-root', credentialKind: 'oauth', apiBase: 'https://api.kimi.ai/coding/v1' })), stagedCredentials: staged, operation: { operationId: 'fake', configurationRevision: '1' }, services: { http: { async request(request: { url: string }) {
      expect(request.url).toBe('https://auth.kimi.ai/api/oauth/token');
      return { status: 200, headers: {}, finalUrl: request.url, body: new TextEncoder().encode(JSON.stringify({ access_token: 'fake-new', expires_in: 3600 })) };
    } } } } as Parameters<ConnectedAccountRuntime['refresh']>[0];
    expect(await runtime.refresh(ctx)).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
    expect(staged.values.get('accessToken')).toBe('fake-new');
    expect(staged.values.get('refreshToken')).toBe('fake-root');
  });
  it('refreshes through the selected stored OAuth host', async () => {
    const runtime = createKimiConnectedAccountRuntime();
    const ctx = { ...context(store({ accessToken: 'fake-old', refreshToken: 'fake-root', credentialKind: 'oauth', apiBase: 'https://api.kimi.ai/coding/v1', oauthHost: 'https://auth.kimi.com' })), stagedCredentials: store(), operation: { operationId: 'fake', configurationRevision: '1' }, services: { http: { async request(request: { url: string }) {
      expect(request.url).toBe('https://auth.kimi.com/api/oauth/token');
      return { status: 200, headers: {}, finalUrl: request.url, body: new TextEncoder().encode(JSON.stringify({ access_token: 'fake-new', expires_in: 3600 })) };
    } } } } as Parameters<ConnectedAccountRuntime['refresh']>[0];
    expect(await runtime.refresh(ctx)).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
  });
  it('demands identity from /me without turning a model catalog into an authentication probe', async () => {
    const runtime = createKimiConnectedAccountRuntime();
    const staged = store();
    const ctx = { ...context(store({ accessToken: 'fake-b', credentialKind: 'oauth', apiBase: 'https://api.kimi.ai/coding/v1' })), stagedCredentials: staged,
      operation: { operationId: 'fake', configurationRevision: '1' }, services: { http: { async request(request: { url: string; headers: Record<string, string> }) {
        expect(request.url).toBe('https://api.kimi.ai/coding/v1/me');
        expect(request.headers.Authorization).toBe('Bearer fake-b');
        return { status: 200, headers: {}, finalUrl: request.url, body: new TextEncoder().encode(JSON.stringify({ user_id: 'selected-b', email: 'b@example.invalid', nickname: 'B' })) };
      } } },
    } as Parameters<NonNullable<ConnectedAccountRuntime['enrichCredentialContext']>>[0];
    expect(runtime.enrichCredentialContext).toBeTypeOf('function');
    expect(await runtime.enrichCredentialContext!(ctx)).toMatchObject({ status: 'connected', credentialKind: 'oauth', providerIdentity: { accountId: 'selected-b', email: 'b@example.invalid' } });
    expect(staged.values.get('accessToken')).toBeUndefined();
  });
});

// HTTP fixtures follow the vendor's published balance response (2026-11-12).
describe('Moonshot platform quota', () => {
  it.each([['https://api.moonshot.ai/v1', 'usd'], ['https://api.moonshot.cn/v1', 'unknown']])('reads the selected regional balance: %s', async (base, unit) => {
    const calls: string[] = [];
    const ctx = { ...context(store({ apiKind: 'platform', accessToken: 'fake-platform', apiBase: base })), services: { http: { async request(input: {url: string; method: string; headers: Record<string,string>}) {
      calls.push(input.url);
      expect(input.method).toBe('GET');
      expect(input.headers.Authorization).toBe('Bearer fake-platform');
      return { status: 200, headers: {}, finalUrl: input.url, body: new TextEncoder().encode(JSON.stringify({code:0,status:true,scode:'0x0',data:{available_balance:49.58894,voucher_balance:46.58893,cash_balance:3.00001}})) };
    } } } } as Parameters<NonNullable<ConnectedAccountRuntime['quota']>>[0];
    const snapshot = await createKimiConnectedAccountRuntime().quota!(ctx);
    expect(calls).toEqual([base + '/users/me/balance']);
    expect(snapshot.limits).toEqual([expect.objectContaining({ id: 'available_balance', remaining:49.58894, unit })]);
    expect(snapshot.limits[0]).not.toHaveProperty('utilizationPct');
    expect(snapshot.limits[0]).not.toHaveProperty('limit');
    expect(snapshot.limits[0]).not.toHaveProperty('resetsAtMs');
    if (unit === 'unknown') expect(snapshot.limits[0].details?.note).toContain('CNY');
  });
});
