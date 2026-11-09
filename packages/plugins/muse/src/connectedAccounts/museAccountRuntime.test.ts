import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountCompletionObservation, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createConnectedAccountAuthenticationAttemptOwner, createConnectedAccountConfigurationOwner, createConnectedAccountCredentialSettlement, invokeConnectedAccountAuthenticationRuntime } from '@happier-dev/cli-common/connectedAccounts';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { museAccountDescriptor, MUSE_ACCOUNT_SERVICE } from './declarations.js';
import { museAccountConnectedResult, museConnectedAccountRuntime as runtime } from './museAccountRuntime.js';

function fixture(responses: unknown[] = []) {
  const values = new Map<string, string>();
  const requests: Array<{ url: string; method: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array }> = [];
  const credentials = {
    async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
  };
  const context = {
    signal: new AbortController().signal, attemptCredentials: credentials, credentials,
    services: { http: { async request(request: typeof requests[number]) {
      requests.push(request);
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return { status: 200, headers: {}, finalUrl: request.url, body: new TextEncoder().encode(JSON.stringify(value)) };
    } } },
  } as Parameters<ConnectedAccountRuntime['materialize']>[1] & Parameters<Extract<ConnectedAccountRuntime['authentication']['modes'][string], {kind:'oauthDeviceCode'}>['poll']>[0];
  return { values, requests, context };
}

function deviceMode() {
  const mode = runtime.authentication.modes.device;
  if (!mode || mode.kind !== 'oauthDeviceCode') throw new Error('Expected Muse device mode');
  return mode;
}

describe('Muse account runtime', () => {
  it.each([
    ['native', '"oauth"', 'subscription'],
    ['native', '"api_key"', 'apiKey'],
    ['manual', '', 'apiKey'],
  ] as const)('publishes the actual %s/%s access mode from its native credential contract', async (mode, mechanism, accessMode) => {
    const f = fixture();
    f.values.set('credentialMode', mode);
    f.values.set('nativeMechanism', mechanism);
    expect(await museAccountConnectedResult(f.context.attemptCredentials)).toMatchObject({ accessMode });
  });
  it.each(['plain', 'e2ee'] as const)('composes the real attempt and %s settlement owners: paced polls, one mint/write, local expiry and cancel', async accountMode => {
    let now = 1700000000000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture([
      { device_code: 'synthetic-device', user_code: 'ABCD', verification_uri: 'https://auth.meta.com/device', expires_in: 600, interval: 5 },
      { error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'synthetic-account-token' },
      { api_key: 'synthetic-key', base_url: 'https://api.meta.ai/v1', is_subs_active: true, subs_usage: { weekly: { used_percent: 20 } } },
      { device_code: 'synthetic-device-2', user_code: 'ABCD', verification_uri: 'https://auth.meta.com/device', expires_in: 10, interval: 5 },
      { device_code: 'synthetic-device-3', user_code: 'ABCD', verification_uri: 'https://auth.meta.com/device', expires_in: 10, interval: 5 },
      { device_code: 'synthetic-reconnect-device', user_code: 'ABCD', verification_uri: 'https://auth.meta.com/device', expires_in: 600, interval: 5 },
      { error: 'access_denied' },
    ]);
    let writes = 0;
    let sequence = 0;
    let storedContent: ReturnType<typeof sealQualifiedConnectedAccountContentEnvelope> | undefined;
    let storedMetadata: unknown;
    let promoted = 0;
    let publishedObservation: ConnectedAccountCompletionObservation | undefined;
    let finishBackground!: (response: { status: string }) => void;
    let background = new Promise<{ status: string }>(resolve => { finishBackground = resolve; });
    async function awaitDeviceStart() {
      expect(await background).toMatchObject({ status: 'awaitingDeviceAuthorization' });
      background = new Promise(resolve => { finishBackground = resolve; });
    }
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const owner = createConnectedAccountAuthenticationAttemptOwner({
      onBackgroundTransition: input => finishBackground(input.response),
      now: () => now, createAttemptId: () => `attempt-${++sequence}`, createAccountId: () => `synthetic-account-${sequence}`,
      createSavedSecretResourceId: () => 'synthetic-promoted-key',
      attemptAddresses: { acknowledge: async () => ({ expiresAtMs: now + 600000 }), read: async () => null, clear: async () => {} },
      accounts: { readExact: async account => ({ account, authenticationModeId: 'device', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null }) },
      configuration: createConnectedAccountConfigurationOwner({
        read: async () => null, replace: async () => { throw new Error('Unused configuration write'); }, destroyAttempt: async () => {},
        secrets: { admit: async () => {}, has: async () => false, read: async () => null }, isRuntimeCurrent: () => true,
      }),
      runtime: {
        admit: async input => ({ service: MUSE_ACCOUNT_SERVICE,
          descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse(museAccountDescriptor.authentication.modes.find(mode => mode.id === input.modeId)),
          occurrenceId: 'synthetic-runtime', sourceCustody: { kind: 'managed', immutableGenerationId: 'synthetic-artifact', installSource: 'archive' } }),
        isCurrent: () => true,
        invoke: async invocation => invokeConnectedAccountAuthenticationRuntime({
          mode: runtime.authentication.modes[invocation.admission.modeId], descriptor: invocation.admission.descriptor, operation: invocation.operation,
          context: { ...f.context, ...invocation.context, signal: invocation.signal ?? f.context.signal },
          signal: invocation.signal, registerRawForRedaction() {}, invokeCallback: async work => work(),
        }),
      },
      oauth: { create: async () => { throw new Error('Unused OAuth redirect'); } },
      settlement: createConnectedAccountCredentialSettlement({
        now: () => now, resolveAccountMode: async () => accountMode,
        seal: (kind, mode, payload) => mode === 'plain'
          ? sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode: mode, payload, randomBytes: length => new Uint8Array(length).fill(3) })
          : sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode: mode, payload, material, randomBytes: length => new Uint8Array(length).fill(3) }),
        open: (kind, mode, envelope) => mode === 'plain'
          ? openQualifiedConnectedAccountContentEnvelope({ kind, accountMode: mode, envelope })
          : openQualifiedConnectedAccountContentEnvelope({ kind, accountMode: mode, envelope, material }),
        parseConfigurationContent: value => value,
        mutateCredential: async mutation => { writes++; storedContent = mutation.content; storedMetadata = mutation.metadata; return { success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null }; },
        promoteCredentialSecrets: async input => {
          promoted++;
          expect(input.secrets).toMatchObject([{ resourceId: 'synthetic-promoted-key', value: 'synthetic-manual-key' }]);
          writes++;
          storedContent = input.credential.content;
          storedMetadata = input.credential.metadata;
          return { status: 'applied', credential: { success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null } };
        },
        mutateCredentialHealth: async () => {}, readCredential: async () => null, readConfiguration: async () => null,
        readHttpStatus: () => null, readFailureCode: () => null,
        onSettled: async input => { publishedObservation = input.completionObservation; },
      }),
    });
    try {
      await expect(owner.beginConnect({ service: MUSE_ACCOUNT_SERVICE, modeId: 'device' })).resolves.toMatchObject({ status: 'starting' });
      await awaitDeviceStart();
      await owner.pollDevice({ attemptId: 'attempt-1' });
      expect(f.requests).toHaveLength(1);
      now += 5000;
      await owner.pollDevice({ attemptId: 'attempt-1' });
      await owner.pollDevice({ attemptId: 'attempt-1' });
      expect(f.requests).toHaveLength(2);
      now += 5000;
      await expect(owner.pollDevice({ attemptId: 'attempt-1' })).resolves.toMatchObject({ status: 'pending', retryAfterMs: 10000 });
      now += 10000;
      await expect(owner.pollDevice({ attemptId: 'attempt-1' })).resolves.toMatchObject({ status: 'connected', includesApiKey: true, accessMode: 'subscription' });
      await owner.pollDevice({ attemptId: 'attempt-1' });
      expect(f.requests).toHaveLength(5);
      expect(writes).toBe(1);
      expect(storedMetadata).toMatchObject({ includesApiKey: true, accessMode: 'subscription' });
      expect(publishedObservation).toMatchObject({ providerId: 'meta', observedAtMs: now, meters: [expect.objectContaining({ used: 20 })] });
      expect(storedContent?.t).toBe(accountMode === 'plain' ? 'plain' : 'encrypted');
      if (!storedContent) throw new Error('Expected settled credential envelope');
      const opened = accountMode === 'plain'
        ? openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode, envelope: storedContent })
        : openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode, envelope: storedContent, material });
      expect(opened).toMatchObject({ v: 1, values: { accountToken: 'synthetic-account-token', inferenceKey: 'synthetic-key', credentialMode: 'native' } });
      await owner.beginConnect({ service: MUSE_ACCOUNT_SERVICE, modeId: 'device' });
      await awaitDeviceStart();
      now += 10001;
      await expect(owner.pollDevice({ attemptId: 'attempt-2' })).resolves.toMatchObject({ status: 'unavailable', code: 'connected_account_device_authorization_expired' });
      expect(f.requests).toHaveLength(6);
      await owner.beginConnect({ service: MUSE_ACCOUNT_SERVICE, modeId: 'device' });
      await awaitDeviceStart();
      await owner.cancel({ attemptId: 'attempt-3' });
      now += 5000;
      await owner.pollDevice({ attemptId: 'attempt-3' });
      expect(f.requests).toHaveLength(7);
      expect(writes).toBe(1);
      const original = storedContent;
      await owner.beginReconnect({ account: { service: MUSE_ACCOUNT_SERVICE, accountId: 'synthetic-account-1' } });
      await awaitDeviceStart();
      now += 5000;
      const refusedReconnect = await owner.pollDevice({ attemptId: 'attempt-4' });
      expect(refusedReconnect.status).not.toBe('connected');
      expect(f.requests).toHaveLength(9);
      expect(writes).toBe(1);
      expect(storedContent).toBe(original);
      await expect(owner.beginConnect({ service: MUSE_ACCOUNT_SERVICE, modeId: 'api-key' })).resolves.toMatchObject({ status: 'awaitingManual' });
      await expect(owner.submitManual({ attemptId: 'attempt-5', fields: { apiKey: 'synthetic-manual-key' } })).resolves.toMatchObject({ status: 'connected', accessMode: 'apiKey' });
      expect(storedMetadata).toMatchObject({ accessMode: 'apiKey' });
      expect(storedMetadata).not.toHaveProperty('includesApiKey');
      expect(promoted).toBe(1);
      expect(writes).toBe(2);
      expect(f.requests).toHaveLength(9);
      if (!storedContent) throw new Error('Expected manual credential envelope');
      const manualPayload = accountMode === 'plain'
        ? openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode, envelope: storedContent })
        : openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode, envelope: storedContent, material });
      expect(manualPayload).toEqual({ v: 1, values: { credentialMode: 'manual' }, secretRefs: { inferenceKey: 'happier:shared-secret:v1:synthetic-promoted-key' } });
    } finally { await owner.dispose(); clock.mockRestore(); }
  });
  it('performs one connection mint after pending/slowdown and reuses staged completion', async () => {
    const f = fixture([
      { device_code: 'synthetic-device', user_code: 'ABCD', verification_uri: 'https://auth.meta.com/device', expires_in: 600, interval: 5 },
      { error: 'authorization_pending' }, { error: 'slow_down' },
      { access_token: 'synthetic-account-token' },
      { api_key: 'synthetic-key', base_url: 'https://api.meta.ai/v1', is_subs_active: true, user_email: 'person@example.test', user_full_name: 'Person',
        subs_tier_name: 'Synthetic plan', subs_usage: { weekly: { used_percent: 135, resets_at: '2026-11-16T00:00:00Z' }, window: { used_percent: 40, window_duration_mins: 300 } } },
    ]);
    const mode = deviceMode();
    await expect(mode.begin(f.context)).resolves.toMatchObject({ status: 'awaitingDeviceAuthorization', pollIntervalMs: 5000 });
    await expect(mode.poll(f.context)).resolves.toEqual({ status: 'pending', retryAfterMs: 5000 });
    await expect(mode.poll(f.context)).resolves.toEqual({ status: 'pending', retryAfterMs: 10000 });
    await expect(mode.poll(f.context)).resolves.toMatchObject({ status: 'connected', credentialKind: 'oauth', completionObservation: {
      v: 1, providerId: 'meta', source: 'providerHttp', confidence: 'confirmed', planLabel: 'Synthetic plan',
      meters: [expect.objectContaining({ used: 135 }), expect.objectContaining({ used: 40 })],
    } });
    const repeated = await mode.poll(f.context);
    expect(repeated).toMatchObject({ status: 'connected' });
    expect(repeated).not.toHaveProperty('completionObservation');
    expect([...f.values.keys()].some(key => /usage|observation/i.test(key))).toBe(false);
    expect(f.requests).toHaveLength(5);
    const mint = f.requests.filter(request => request.url.endsWith('/muse-code/key'));
    expect(mint).toHaveLength(1);
    expect(new TextDecoder().decode(mint[0]?.body)).toBe('{}');
    expect(mint[0]?.headers).toMatchObject({ Authorization: 'Bearer synthetic-account-token', 'x-api-version': '1.0.0' });
    const files = await runtime.materialize({ kind: 'files', fileIds: ['muse/auth.json'] }, f.context);
    if (files.kind !== 'files') throw new Error('Expected native files');
    const native = JSON.parse(new TextDecoder().decode(files.files['muse/auth.json']));
    expect(native).toMatchObject({ schema_version: 1, providers: { meta: { mechanism: 'oauth', obtained_via: 'device_code', api_base_url: 'https://api.meta.ai/v1' } } });
    expect(native.providers.meta).not.toHaveProperty('expires_at');
    await expect(runtime.materialize({ kind: 'environment', keys: ['META_API_KEY'] }, f.context)).resolves.toEqual({ kind: 'environment', env: {} });
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.meta.ai', headerNames: ['authorization', 'x-api-version'] }, f.context)).resolves.toEqual({ kind: 'httpHeaders', headers: { Authorization: 'Bearer synthetic-key', 'x-api-version': '1.0.0' } });
    await runtime.status(f.context);
    await runtime.refresh({ ...f.context, stagedCredentials: f.context.attemptCredentials, operation: { operationId: 'refresh', configurationRevision: '1' } });
    await runtime.revoke(f.context);
    expect(f.requests).toHaveLength(5);
  });

  it('keeps manual keys separate from subscription files and performs no acquisition on reads', async () => {
    const f = fixture();
    const mode = runtime.authentication.modes['api-key'];
    if (!mode || mode.kind !== 'manual') throw new Error('Expected key mode');
    await expect(mode.complete({ fields: { apiKey: 'synthetic-manual-key' } }, f.context)).resolves.toMatchObject({ status: 'connected', credentialKind: 'token' });
    await expect(runtime.materialize({ kind: 'environment', keys: ['META_API_KEY'] }, f.context)).resolves.toEqual({ kind: 'environment', env: { META_API_KEY: 'synthetic-manual-key' } });
    await expect(runtime.materialize({ kind: 'files', fileIds: ['muse/auth.json'] }, f.context)).resolves.toEqual({ kind: 'files', files: {} });
    await expect(runtime.quota?.(f.context)).rejects.toMatchObject({ code: 'plugin_connected_account_usage_unavailable' });
    expect(f.requests).toHaveLength(0);
  });

  it('does not retry an ambiguous mint or settle account-token-only auth as ready', async () => {
    const f = fixture([
      { device_code: 'synthetic-device', user_code: 'ABCD', verification_uri: 'https://auth.meta.com/device', expires_in: 600, interval: 5 },
      { access_token: 'synthetic-account-token' }, new Error('network boundary failure'),
    ]);
    const mode = deviceMode();
    await mode.begin(f.context);
    await expect(mode.poll(f.context)).resolves.toMatchObject({ status: 'outcomeUnknown' });
    await expect(mode.poll(f.context)).resolves.toMatchObject({ status: 'outcomeUnknown' });
    expect(f.requests).toHaveLength(3);
    await expect(runtime.status(f.context)).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('does not turn an account-token expiry into an unreported inference-key expiry', async () => {
    const f = fixture();
    f.values.set('credentialMode', 'native');
    f.values.set('inferenceKey', 'synthetic-still-unexpired-key');
    f.values.set('expiresAtMs', '1');
    await expect(runtime.status(f.context)).resolves.toMatchObject({ status: 'connected' });
    expect(await runtime.status(f.context)).not.toHaveProperty('expiresAt');
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.meta.ai', headerNames: ['authorization'] }, f.context)).resolves.toEqual({ kind: 'httpHeaders', headers: { Authorization: 'Bearer synthetic-still-unexpired-key' } });
    await expect(runtime.materialize({ kind: 'environment', keys: ['META_API_KEY'] }, f.context)).resolves.toEqual({ kind: 'environment', env: {} });
    await expect(runtime.materialize({ kind: 'files', fileIds: ['muse/auth.json'] }, f.context)).rejects.toMatchObject({ code: 'plugin_connected_account_credentials_unavailable' });
  });
});
