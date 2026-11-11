import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createXaiConnectedAccountRuntime } from './runtime.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

function fixture(modeId = 'api-key') {
  const saved = new Map<string, string>();
  const request = vi.fn(async () => ({ status: 503, headers: {}, body: new Uint8Array() }));
  const credentials = { get: async (key: string) => saved.get(key) ?? null,
    set: async (key: string, value: string) => { saved.set(key, value); },
    delete: async (key: string) => { saved.delete(key); } };
  // HTTP and credential custody are genuine host boundaries.
  const context = { signal: new AbortController().signal, invokedAtMs: 1000,
    services: { http: { request } }, attemptCredentials: credentials, credentials,
    configuration: { target: { kind: 'service', modeId }, values: {} },
  } as unknown as ConnectedAccountAuthenticationContext;
  const read = context as unknown as Parameters<ConnectedAccountRuntime['materialize']>[1];
  return { context, read, credentials, request, saved };
}

describe('xAI selected credential runtime', () => {
  it('declares Account placement for app-runnable device and API-key modes', () => {
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(entry => entry.id === 'xai')?.authentication)
      .toMatchObject({ account: { artifactId: 'connected-account-authentication', exportName: 'activate' } });
  });
  it('connects an explicit paid API key with no OAuth or subscription usage request', async () => {
    const f = fixture(); const runtime = createXaiConnectedAccountRuntime();
    const mode = runtime.authentication.modes['api-key'];
    if (mode.kind !== 'manual') throw new Error('Expected manual mode');
    const connected = await mode.complete({ fields: { apiKey: 'fake-paid-key' } }, f.context);
    expect(connected).toMatchObject({ status: 'connected', credentialKind: 'token' });
    if (connected.status !== 'connected') throw new Error('xAI key was not connected');
    const purpose = PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'grok')?.connectedAccounts?.[0];
    expect(purpose?.credentialKinds).toContain(connected.credentialKind);
    expect(await runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.x.ai', headerNames: ['authorization'] }, f.read))
      .toMatchObject({ kind: 'httpHeaders', headers: { Authorization: 'Bearer fake-paid-key' }, facts: { mode: 'api-key', usingApi: true, base: 'https://api.x.ai/v1' } });
    expect(runtime.quota).toBeTypeOf('function');
    await runtime.quota?.(f.read);
    expect(await runtime.materialize({ kind: 'environment', keys: ['GROK_CONNECTED_ACCOUNT_MODE', 'XAI_API_KEY', 'GROK_OAUTH2_ISSUER', 'GROK_OAUTH2_CLIENT_ID'] }, f.read)).toEqual({ kind: 'environment', env: { GROK_CONNECTED_ACCOUNT_MODE: 'api-key', XAI_API_KEY: 'fake-paid-key' } });
    expect(f.request).not.toHaveBeenCalled();
    expect(await runtime.materialize({ kind: 'httpHeaders', origin: 'https://cli-chat-proxy.grok.com', headerNames: ['authorization'] }, f.read))
      .toMatchObject({ facts: { usingApi: true, base: 'https://api.x.ai/v1' } });
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://foreign.example', headerNames: ['authorization'] }, f.read)).rejects.toThrow();
  });
  it('materializes subscription headers and facts without paid fallback or refresh', async () => {
    const f = fixture(); const runtime = createXaiConnectedAccountRuntime();
    await f.credentials.set('xaiCredential', JSON.stringify({ mode: 'subscription', accessToken: 'fake-subscription', refreshToken: 'fake-refresh', expiresAtMs: 5000, clientId: 'fake-native-client' }));
    const material = await runtime.materialize({ kind: 'httpHeaders', origin: 'https://cli-chat-proxy.grok.com', headerNames: ['authorization', 'x-xai-token-auth'] }, f.read);
    expect(material).toMatchObject({ headers: { Authorization: 'Bearer fake-subscription', 'X-XAI-Token-Auth': 'xai-grok-cli' }, expiresAt: 5000, facts: { mode: 'subscription', usingApi: false, base: 'https://cli-chat-proxy.grok.com/v1' } });
    expect(JSON.stringify(material)).not.toContain('fake-refresh');
    expect(await runtime.materialize({ kind: 'environment', keys: ['GROK_CONNECTED_ACCOUNT_MODE', 'XAI_API_KEY', 'GROK_OAUTH2_ISSUER', 'GROK_OAUTH2_CLIENT_ID'] }, f.read)).toMatchObject({ env: { GROK_CONNECTED_ACCOUNT_MODE: 'subscription', GROK_OAUTH2_ISSUER: 'https://auth.x.ai', GROK_OAUTH2_CLIENT_ID: 'fake-native-client' } });
    expect(f.request).not.toHaveBeenCalled();
    expect(await runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.x.ai', headerNames: ['authorization'] }, f.read))
      .toMatchObject({ facts: { usingApi: false, base: 'https://cli-chat-proxy.grok.com/v1' } });
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://foreign.example', headerNames: ['authorization'] }, f.read)).rejects.toThrow();
  });
});

describe('xAI OAuth discovery and refresh', () => {
  it('retains a successful device grant when optional userinfo is temporarily unreachable', async () => {
    const f = fixture('device'); const runtime = createXaiConnectedAccountRuntime();
    const mode = runtime.authentication.modes.device;
    if (mode.kind !== 'oauthDeviceCode') throw new Error('Expected device mode');
    const responses = [
      { device_authorization_endpoint: 'https://auth.example/device', token_endpoint: 'https://auth.example/token' },
      { device_code: 'fake-device', user_code: 'FAKE', verification_uri: 'https://auth.example/verify', expires_in: 600 },
      { access_token: 'fake-granted', refresh_token: 'fake-refresh', expires_in: 3600 },
    ];
    f.request.mockImplementation(async () => {
      const body = responses.shift();
      if (!body) throw new Error('Fake userinfo transport failure');
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    });
    await mode.begin(f.context);
    const connected = await mode.poll(f.context);
    expect(connected).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
    if (connected.status !== 'connected') throw new Error('xAI grant was not connected');
    const purpose = PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'grok')?.connectedAccounts?.[0];
    expect(purpose?.credentialKinds).toContain(connected.credentialKind);
    expect(JSON.parse(f.saved.get('xaiCredential') ?? 'null')).toMatchObject({ accessToken: 'fake-granted' });
  });
  it('discovers once per device attempt and preserves polling under the attempt owner', async () => {
    const f = fixture('device'); const runtime = createXaiConnectedAccountRuntime();
    const mode = runtime.authentication.modes.device;
    if (mode.kind !== 'oauthDeviceCode') throw new Error('Expected device mode');
    const replies = [
      { device_authorization_endpoint: 'https://auth.example/device', token_endpoint: 'https://auth.example/token' },
      { device_code: 'fake-device', user_code: 'FAKE', verification_uri: 'https://auth.example/verify', expires_in: 600, interval: 5 },
      { error: 'authorization_pending' }, { error: 'slow_down' },
      { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, token_type: 'Bearer' },
      { sub: 'fake-user', email: 'fake@example.test' },
    ];
    f.request.mockImplementation(async () => {
      const body = replies.shift();
      return { status: body && 'error' in body ? 400 : 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    });
    expect(await mode.begin(f.context)).toMatchObject({ status: 'awaitingDeviceAuthorization', userCode: 'FAKE', pollIntervalMs: 5000 });
    expect(await mode.poll(f.context)).toMatchObject({ status: 'pending', retryAfterMs: 5000 });
    expect(await mode.poll(f.context)).toMatchObject({ status: 'pending', retryAfterMs: 10000 });
    const connected = await mode.poll(f.context);
    expect(connected).toMatchObject({ status: 'connected', providerIdentity: { accountId: 'fake-user' } });
    expect(connected).not.toHaveProperty('accountId');
    expect(f.request.mock.calls).toHaveLength(6);
    await mode.cancel(f.context);
    expect(f.saved.has('xaiDevice')).toBe(false);
  });
  it.each([[400, 'invalid_grant', 'reconnectRequired'], [403, 'BLOCKED_REASON_NO_LOGS', 'unavailable'], [503, 'server_error', 'unavailable']])('classifies refresh %s/%s without invalidating transient or policy failures', async (status, error, expected) => {
    const f = fixture(); const runtime = createXaiConnectedAccountRuntime();
    await f.credentials.set('xaiCredential', JSON.stringify({ mode: 'subscription', accessToken: 'fake-old', refreshToken: 'fake-refresh', tokenEndpoint: 'https://auth.example/token', clientId: 'fake-client' }));
    f.request.mockImplementation(async () => ({ status: Number(status), headers: {}, body: new TextEncoder().encode(JSON.stringify({ error })) }));
    const context = { ...f.read, stagedCredentials: f.credentials } as unknown as Parameters<ConnectedAccountRuntime['refresh']>[0];
    expect(await runtime.refresh(context)).toMatchObject({ status: expected,
      ...(error === 'BLOCKED_REASON_NO_LOGS' ? { diagnostic: { code: 'xai_refresh_BLOCKED_REASON_NO_LOGS' } } : {}) });
    expect(f.saved.get('xaiCredential')).toContain('fake-old');
  });
});


describe('xAI refresh custody', () => {
  it('discovers the selected native issuer once when an imported credential needs refresh', async () => {
    const f = fixture(); const runtime = createXaiConnectedAccountRuntime();
    await f.credentials.set('xaiCredential', JSON.stringify({ mode: 'subscription', accessToken: 'fake-import', refreshToken: 'fake-refresh', issuer: 'https://auth.x.ai', clientId: 'fake-native-client' }));
    const urls: string[] = [];
    f.request.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { url: string; body?: Uint8Array };
      urls.push(input.url);
      const body = urls.length === 1 ? { token_endpoint: 'https://auth.example/native-token' } : { access_token: 'fake-rotated', expires_in: 3600 };
      if (urls.length === 2) expect(new TextDecoder().decode(input.body)).toContain('client_id=fake-native-client');
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    });
    const staged = new Map<string, string>();
    const context = { ...f.read, stagedCredentials: { set: async (key: string, value: string) => { staged.set(key, value); } } } as unknown as Parameters<ConnectedAccountRuntime['refresh']>[0];
    expect(await runtime.refresh(context)).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
    expect(urls).toEqual(['https://auth.x.ai/.well-known/openid-configuration', 'https://auth.example/native-token']);
    expect(JSON.parse(staged.get('xaiCredential') ?? 'null')).toMatchObject({ tokenEndpoint: 'https://auth.example/native-token', refreshToken: 'fake-refresh', accessToken: 'fake-rotated' });
    expect(f.saved.get('xaiCredential')).toContain('fake-import');
  });
  it('rotates refresh material through staged custody while HTTP output contains only access headers', async () => {
    const f = fixture(); const runtime = createXaiConnectedAccountRuntime();
    await f.credentials.set('xaiCredential', JSON.stringify({ mode: 'subscription', accessToken: 'fake-old', refreshToken: 'fake-old-refresh', tokenEndpoint: 'https://auth.example/token', clientId: 'fake-client' }));
    f.request.mockImplementation(async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ access_token: 'fake-new-access', refresh_token: 'fake-new-refresh', expires_in: 3600 })) }));
    const staged = new Map<string, string>();
    const context = { ...f.read, stagedCredentials: { set: async (key: string, value: string) => { staged.set(key, value); } } } as unknown as Parameters<ConnectedAccountRuntime['refresh']>[0];
    expect(await runtime.refresh(context)).toMatchObject({ status: 'connected', credentialKind: 'oauth', expiresAt: 3601000 });
    expect(JSON.parse(staged.get('xaiCredential') ?? 'null')).toMatchObject({ accessToken: 'fake-new-access', refreshToken: 'fake-new-refresh' });
    expect(f.saved.get('xaiCredential')).toContain('fake-old-refresh');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});


describe('xAI explicit native import and access-only materialization', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ['malformed', 'rejected', 'xai_native_schema_unsupported'],
    ['missing', 'unavailable', 'xai_native_file_unavailable'],
  ])('distinguishes %s native source without disclosing file contents', async (source, status, code) => {
    const root = await mkdtemp(join(tmpdir(), 'xai-import-failure-'));
    try {
      const file = join(root, 'auth.json');
      if (source === 'malformed') await writeFile(file, '{"key":"fake-private-native-value"');
      vi.stubEnv('GROK_AUTH_PATH', file);
      const f = fixture('native-import');
      const mode = createXaiConnectedAccountRuntime().authentication.modes['native-import'];
      if (mode.kind !== 'manual') throw new Error('Expected explicit native import');
      const result = await mode.complete({ fields: { source: 'native' } }, f.context);
      expect(result).toMatchObject({ status, diagnostic: { code } });
      expect(JSON.stringify(result)).not.toContain('fake-private-native-value');
      expect(f.saved.size).toBe(0);
      expect(f.request).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('imports one selected fake native file and emits access-only selected home bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xai-import-fixture-'));
    try {
      const file = join(root, 'auth.json');
      const scope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
      await writeFile(file, JSON.stringify({ [scope]: { key: 'fake-native-access', refresh_token: 'fake-native-refresh', auth_mode: 'oidc', create_time: '2026-11-09T00:00:00Z', user_id: 'fake-native-user', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828' } }));
      vi.stubEnv('GROK_AUTH_PATH', file);
      const f = fixture('native-import'); const runtime = createXaiConnectedAccountRuntime();
      const mode = runtime.authentication.modes['native-import'];
      if (mode.kind !== 'manual') throw new Error('Expected explicit native import');
      const connected = await mode.complete({ fields: { source: 'native' } }, f.context);
      expect(connected).toMatchObject({ status: 'connected', credentialKind: 'oauth', providerIdentity: { accountId: 'fake-native-user' } });
      expect(connected).not.toHaveProperty('accountId');
      const material = await runtime.materialize({ kind: 'files', fileIds: ['auth.json'] }, f.read);
      if (material.kind !== 'files') throw new Error('Expected selected native file');
      const content = new TextDecoder().decode(material.files['auth.json']);
      expect(JSON.parse(content)).toMatchObject({ [scope]: { key: 'fake-native-access', auth_mode: 'oidc' } });
      expect(content).not.toContain('fake-native-refresh');
      expect(f.saved.get('xaiCredential')).toContain('fake-native-refresh');
      expect(f.request).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
