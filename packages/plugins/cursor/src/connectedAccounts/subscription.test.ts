import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountPortableAuthenticationContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { cursorConnectedAccountRuntime } from './runtime.js';

function fixture(status = 404, body: unknown = {}) {
  const values = new Map<string, string>();
  const store = { async get(key: string) { return values.get(key) ?? null; }, async set(key: string, value: string) { values.set(key, value); }, async delete(key: string) { values.delete(key); } };
  const requests: { url: string; method: string; headers?: Readonly<Record<string, string>> }[] = [];
  const service = { pluginId: 'happier.agent.cursor', localId: 'cursor-account' };
  const context = {
    plugin: { id: service.pluginId, version: '0.0.0' }, contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
    surface: 'ui', invokedAtMs: 1000, service, attempt: { kind: 'connect', attemptId: 'fixture' },
    configuration: { target: { kind: 'attempt', service, attemptId: 'fixture', modeId: 'subscription' }, revision: '1', values: {}, async getSecret() { return null; } },
    signal: new AbortController().signal, attemptCredentials: store,
    services: { http: createPluginHttpFixture({ async request(request) { requests.push(request); return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) }; } }) },
  } satisfies ConnectedAccountPortableAuthenticationContext;
  const mode = cursorConnectedAccountRuntime.authentication.modes.subscription;
  if (mode?.kind !== 'oauthDeviceCode') throw new Error('Cursor subscription browser poll mode missing');
  const read = { ...context, credentials: store, stagedCredentials: store, account: { service, accountId: 'saved' } } as Parameters<ConnectedAccountRuntime['refresh']>[0];
  return { values, context, read, mode, requests };
}
const token = `e30.${btoa(JSON.stringify({ exp: 4102444800 })).replace(/=/g, '')}.fixture`;
describe('Cursor subscription authentication', () => {
  it('binds the browser S256 challenge to the secret verifier used in polling', async () => {
    const f = fixture();
    const result = await f.mode.begin(f.context);
    expect(result.status).toBe('awaitingDeviceAuthorization');
    if (result.status !== 'awaitingDeviceAuthorization') throw new Error('Begin failed');
    const url = new URL(result.verificationUriComplete ?? result.verificationUri ?? '');
    expect(url.origin + url.pathname).toBe('https://cursor.com/loginDeepControl');
    expect(url.searchParams.get('mode')).toBe('login');
    expect(url.searchParams.get('redirectTarget')).toBe('cli');
    expect(await f.mode.poll(f.context)).toMatchObject({ status: 'pending' });
    const poll = new URL(f.requests[0]!.url);
    expect(poll.origin + poll.pathname).toBe('https://api2.cursor.sh/auth/poll');
    expect(poll.searchParams.get('uuid')).toBe(url.searchParams.get('uuid'));
    const verifier = poll.searchParams.get('verifier')!;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    expect(url.searchParams.get('challenge')).toBe(challenge);
    expect(JSON.stringify(result)).not.toContain(verifier);
    await f.mode.cancel?.(f.context);
    expect(f.values.has('cursorPoll')).toBe(false);
  });
  it('stores a valid access/refresh pair and expiry only in credential custody', async () => {
    const f = fixture(200, { accessToken: token, refreshToken: 'fixture-refresh' });
    await f.mode.begin(f.context);
    const result = await f.mode.poll(f.context);
    expect(result).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
    expect(f.values.get('accessToken')).toBe(token);
    expect(f.values.get('refreshToken')).toBe('fixture-refresh');
    expect(f.values.get('expiresAtMs')).toBe('4102444800000');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(await cursorConnectedAccountRuntime.materialize({ kind: 'environment', keys: ['CURSOR_AUTH_TOKEN', 'AGENT_CLI_CREDENTIAL_STORE', 'CURSOR_API_KEY'] }, f.read)).toEqual({ kind: 'environment', env: { CURSOR_AUTH_TOKEN: token, AGENT_CLI_CREDENTIAL_STORE: 'memory' } });
  });
  it.each([401, 403, 410])('settles expired/refused poll %s without storing credentials', async status => {
    const f = fixture(status);
    await f.mode.begin(f.context);
    expect(await f.mode.poll(f.context)).toMatchObject({ status: 'rejected' });
    expect(f.values.has('accessToken')).toBe(false);
  });
  it('reports transport failure as unavailable and retains the attempt for recovery', async () => {
    const f = fixture();
    await f.mode.begin(f.context);
    const context = { ...f.context, services: { http: createPluginHttpFixture({
      async request() { throw new TypeError('Failed to fetch'); },
    }) } };
    expect(await f.mode.poll(context)).toMatchObject({ status: 'unavailable', diagnostic: { code: 'cursor_poll_transport_unavailable' } });
    expect(f.values.has('accessToken')).toBe(false);
    expect(await f.mode.poll(f.context)).toMatchObject({ status: 'pending' });
  });
  it('rejects malformed successful responses', async () => {
    const f = fixture(200, { accessToken: token });
    await f.mode.begin(f.context);
    expect(await f.mode.poll(f.context)).toMatchObject({ status: 'rejected' });
    expect(f.values.has('accessToken')).toBe(false);
  });
  it('rotates refresh credentials through the existing staged settlement', async () => {
    const f = fixture(200, { accessToken: token, refreshToken: 'rotated-refresh' });
    f.values.set('refreshToken', 'previous-refresh');
    f.values.set('credentialKind', 'oauth');
    expect(await cursorConnectedAccountRuntime.refresh(f.read)).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
    expect(f.requests[0]).toMatchObject({ url: 'https://api2.cursor.sh/auth/exchange_user_api_key', method: 'POST', headers: { Authorization: 'Bearer previous-refresh' } });
    expect(f.values.get('refreshToken')).toBe('rotated-refresh');
  });
  it('retains the current refresh token when exchange rotates only access', async () => {
    const f = fixture(200, { accessToken: token });
    f.values.set('refreshToken', 'retained-refresh'); f.values.set('credentialKind', 'oauth');
    expect(await cursorConnectedAccountRuntime.refresh(f.read)).toMatchObject({ status: 'connected' });
    expect(f.values.get('refreshToken')).toBe('retained-refresh');
  });
  it('requires reconnection for rejected refresh and scopes bearer delivery to Cursor', async () => {
    const f = fixture(401);
    f.values.set('refreshToken', 'previous-refresh'); f.values.set('accessToken', token); f.values.set('credentialKind', 'oauth');
    expect(await cursorConnectedAccountRuntime.refresh(f.read)).toMatchObject({ status: 'reconnectRequired' });
    await expect(cursorConnectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://example.test', headerNames: ['Authorization'] }, f.read)).rejects.toThrow();
    expect(await cursorConnectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://api2.cursor.sh', headerNames: ['Authorization'] }, f.read)).toMatchObject({ kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } });
  });
});
