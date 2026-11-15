import { resolveConnectedAccountAuthenticationModeMachineRequirement } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountCompletionObservation, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createConnectedAccountAuthenticationAttemptOwner, createConnectedAccountConfigurationOwner, createConnectedAccountCredentialSettlement, invokeConnectedAccountAuthenticationRuntime } from '@happier-dev/cli-common/connectedAccounts';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { museAccountDescriptor, museNativeConnectedAccountPurpose, MUSE_ACCOUNT_SERVICE } from './declarations.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { museAccountConnectedResult, museConnectedAccountRuntime as runtime } from './museAccountRuntime.js';

function fixture(responses: unknown[] = [], httpStatus = 200) {
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
      return { status: httpStatus, headers: {}, finalUrl: request.url, body: new TextEncoder().encode(JSON.stringify(value)) };
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
  it.each([[200, 'ok'], [401, 'needsReauth'], [503, 'networkUnavailable'], [new Error('synthetic-secret'), 'networkUnavailable']] as const)(
    'tests saved subscription credentials with a read-only model request (%s)', async (response, status) => {
      const f = fixture([response instanceof Error ? response : { data: [] }], typeof response === 'number' ? response : 200);
      for (const [key, value] of Object.entries({ credentialMode: 'native', inferenceKey: 'synthetic-key', accountToken: 'synthetic-secret', nativeMechanism: '"oauth"', expiresAtMs: String(Date.now() + 60_000), nativeApiBaseUrl: 'https://api.meta.ai/v1' })) f.values.set(key, value);
      const before = [...f.values];
      const result = await runtime.testConnection!(f.context);
      expect(result.status).toBe(status);
      expect(JSON.stringify(result)).not.toContain('synthetic-secret');
      expect(f.requests).toEqual([expect.objectContaining({ method: 'GET', url: 'https://api.meta.ai/v1/models', headers: expect.objectContaining({ Authorization: 'Bearer synthetic-key' }) })]);
      expect([...f.values]).toEqual(before);
    });

  it('keeps valid access-only Muse health connected and explains why its remote test is unsupported', async () => {
    const f = fixture();
    for (const [key, value] of Object.entries({ credentialMode: 'native', accountToken: 'synthetic-member-access', expiresAtMs: String(Date.now() + 60_000), nativeMechanism: '"oauth"', nativeApiBaseUrl: 'https://api.meta.ai/v1' })) f.values.set(key, value);
    expect(await runtime.status(f.context)).toMatchObject({ status: 'connected', accessMode: 'subscription' });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'unsupported', reason: expect.any(String) });
    expect(f.requests).toEqual([]);
    f.values.set('expiresAtMs', String(Date.now() - 1));
    expect(await runtime.status(f.context)).toMatchObject({ status: 'unavailable' });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'needsReauth' });
  });

  it('materializes an access-only Team snapshot without inference or refresh credentials', async () => {
    const f = fixture();
    const expiry = Date.now() + 60_000;
    for (const [key, value] of Object.entries({ credentialMode: 'native', accountToken: 'synthetic-member-access',
      expiresAtMs: String(expiry), nativeExpiresAt: String(Math.floor(expiry / 1000)), nativeMechanism: '\"oauth\"',
      nativeApiBaseUrl: 'https://api.meta.ai/v1', nativeObtainedVia: 'device_code' })) f.values.set(key, value);
    const result = await runtime.materialize({ kind: 'files', fileIds: ['muse/auth.json'] }, f.context);
    if (result.kind !== 'files') throw new Error('Expected files');
    const auth = JSON.parse(new TextDecoder().decode(result.files['muse/auth.json']));
    expect(auth.providers.meta).toMatchObject({ access_token: 'synthetic-member-access', mechanism: 'oauth' });
    expect(auth.providers.meta).not.toHaveProperty('api_key');
    expect(auth.providers.meta).not.toHaveProperty('refresh_token');
    expect(f.requests).toEqual([]);
    await expect(runtime.materialize({ kind: 'environment', keys: ['META_API_KEY', 'MUSE_CODE_CREDENTIAL'] }, f.context))
      .resolves.toEqual({ kind: 'environment', env: {} });
    await expect(runtime.materialize({ kind: 'httpHeaders', headerNames: ['Authorization'] }, f.context))
      .rejects.toMatchObject({ code: 'plugin_connected_account_credentials_unavailable' });
    f.values.set('expiresAtMs', String(Date.now() - 1));
    await expect(runtime.materialize({ kind: 'files', fileIds: ['muse/auth.json'] }, f.context))
      .rejects.toMatchObject({ code: 'plugin_connected_account_credentials_unavailable' });
  });

  it('routes Muse Meta device grant through Machine only in browsers', () => {
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(entry => entry.id === 'muse-account');
    if (!descriptor) throw new Error('Account descriptor missing');
    const projection = projectConnectedAccountDescriptorV1({
      descriptor, serviceId: descriptor.id, pluginId: PLUGIN_MANIFEST.id,
      provenance: 'first_party', sourceKind: 'builtin',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    });
    const mode = projection.authentication.modes.find(entry => entry.id === 'device');
    expect(projection.capabilities).toContain('usage');
    expect(resolveConnectedAccountAuthenticationModeMachineRequirement(mode, true)).toBe('browser_unreachable');
    expect(resolveConnectedAccountAuthenticationModeMachineRequirement(mode, false)).toBeNull();
    const apiKey = projection.authentication.modes.find(entry => entry.id === 'api-key');
    expect(resolveConnectedAccountAuthenticationModeMachineRequirement(apiKey, true)).toBeNull();
  });

  it('declares an Account-side authentication artifact for app-runnable modes', () => {
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(entry => entry.id === MUSE_ACCOUNT_SERVICE.localId)?.authentication)
      .toMatchObject({ account: { artifactId: 'connected-account-authentication', exportName: 'activate' } });
  });
  it.each([
    { kind: 'environment', keys: ['MUSE_CODE_CREDENTIAL'] },
    { kind: 'files', fileIds: ['muse/auth.json'] },
  ] as const)('refuses incomplete native OAuth credentials for $kind', async request => {
    const f = fixture();
    f.values.set('credentialMode', 'native');
    f.values.set('nativeMechanism', '"oauth"');
    f.values.set('inferenceKey', 'synthetic-key');
    await expect(runtime.materialize(request, f.context)).rejects.toMatchObject({ code: 'plugin_connected_account_credentials_unavailable' });
  });
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
    let storedDirectExportContract: unknown;
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
        mutateCredential: async mutation => { writes++; storedContent = mutation.content; storedMetadata = mutation.metadata; storedDirectExportContract = mutation.directExportContract; return { success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null }; },
        promoteCredentialSecrets: async input => {
          promoted++;
          expect(input.secrets).toMatchObject([{ resourceId: 'synthetic-promoted-key', value: 'synthetic-manual-key' }]);
          writes++;
          storedContent = input.credential.content;
          storedMetadata = input.credential.metadata;
          storedDirectExportContract = input.credential.directExportContract;
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
      expect(storedDirectExportContract).toBeNull();
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
      expect(storedDirectExportContract).toBeNull();
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
    const connected = await mode.poll(f.context);
    expect(connected).toMatchObject({ status: 'connected', credentialKind: 'oauth', completionObservation: {
      v: 1, providerId: 'meta', source: 'providerHttp', confidence: 'confirmed', planLabel: 'Synthetic plan',
      meters: [expect.objectContaining({ used: 135 }), expect.objectContaining({ used: 40 })],
    } });
    if (connected.status !== 'connected') throw new Error('Muse grant was not connected');
    expect(museNativeConnectedAccountPurpose.credentialKinds).toContain(connected.credentialKind);
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
    await expect(runtime.materialize({ kind: 'environment', keys: ['META_API_KEY', 'MUSE_CODE_CREDENTIAL'] }, f.context)).resolves.toEqual({ kind: 'environment', env: {
      META_API_KEY: 'synthetic-key', MUSE_CODE_CREDENTIAL: JSON.stringify({ oauthAccessToken: 'synthetic-account-token', apiKey: 'synthetic-key' }),
    } });
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.meta.ai', headerNames: ['authorization', 'x-api-version'] }, f.context)).resolves.toEqual({ kind: 'httpHeaders', headers: { Authorization: 'Bearer synthetic-key', 'x-api-version': '1.0.0' } });
    await runtime.status(f.context);
    await runtime.refresh({ ...f.context, stagedCredentials: f.context.attemptCredentials, operation: { operationId: 'refresh', configurationRevision: '1' } });
    await runtime.revoke(f.context);
    expect(f.requests).toHaveLength(5);
  });

  it('materializes manual keys in native API-key mode without acquiring a subscription', async () => {
    const f = fixture();
    const mode = runtime.authentication.modes['api-key'];
    if (!mode || mode.kind !== 'manual') throw new Error('Expected key mode');
    const connected = await mode.complete({ fields: { apiKey: 'synthetic-manual-key' } }, f.context);
    expect(connected).toMatchObject({ status: 'connected', credentialKind: 'token' });
    if (connected.status !== 'connected') throw new Error('Muse key was not connected');
    expect(museNativeConnectedAccountPurpose.credentialKinds).toContain(connected.credentialKind);
    await expect(runtime.materialize({ kind: 'environment', keys: ['META_API_KEY'] }, f.context)).resolves.toEqual({ kind: 'environment', env: { META_API_KEY: 'synthetic-manual-key' } });
    await expect(runtime.materialize({ kind: 'environment', keys: ['MUSE_CODE_CREDENTIAL'] }, f.context)).resolves.toEqual({ kind: 'environment', env: {} });
    await expect(runtime.materialize({ kind: 'environment', keys: ['META_API_KEY', 'MUSE_CODE_CREDENTIAL'] }, f.context)).resolves.toEqual({ kind: 'environment', env: { META_API_KEY: 'synthetic-manual-key' } });
    const files = await runtime.materialize({ kind: 'files', fileIds: ['muse/auth.json'] }, f.context);
    if (files.kind !== 'files') throw new Error('Expected native key file');
    expect(files.files['muse/auth.json']).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(files.files['muse/auth.json']))).toEqual({
      schema_version: 1, providers: { meta: {
        access_token: 'synthetic-manual-key', api_key: 'synthetic-manual-key',
        api_base_url: 'https://api.meta.ai/v1', mechanism: 'api_key', obtained_via: 'api_key',
      } },
    });
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
    f.values.set('nativeMechanism', '"oauth"');
    f.values.set('accountToken', 'synthetic-expired-account-token');
    f.values.set('expiresAtMs', '1');
    await expect(runtime.status(f.context)).resolves.toMatchObject({ status: 'connected' });
    expect(await runtime.status(f.context)).not.toHaveProperty('expiresAt');
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.meta.ai', headerNames: ['authorization'] }, f.context)).resolves.toEqual({ kind: 'httpHeaders', headers: { Authorization: 'Bearer synthetic-still-unexpired-key' } });
    await expect(runtime.materialize({ kind: 'environment', keys: ['META_API_KEY'] }, f.context)).resolves.toEqual({ kind: 'environment', env: { META_API_KEY: 'synthetic-still-unexpired-key' } });
    await expect(runtime.materialize({ kind: 'environment', keys: ['MUSE_CODE_CREDENTIAL'] }, f.context)).rejects.toMatchObject({ code: 'plugin_connected_account_credentials_unavailable' });
    await expect(runtime.materialize({ kind: 'files', fileIds: ['muse/auth.json'] }, f.context)).rejects.toMatchObject({ code: 'plugin_connected_account_credentials_unavailable' });
  });

  it('does not turn native API-key material into a Muse subscription credential', async () => {
    const f = fixture();
    f.values.set('credentialMode', 'native');
    f.values.set('nativeMechanism', '"api_key"');
    f.values.set('accountToken', 'native-account-token');
    f.values.set('inferenceKey', 'native-api-key');
    await expect(runtime.materialize({ kind: 'environment', keys: ['META_API_KEY'] }, f.context)).resolves.toEqual({ kind: 'environment', env: { META_API_KEY: 'native-api-key' } });
    await expect(runtime.materialize({ kind: 'environment', keys: ['MUSE_CODE_CREDENTIAL'] }, f.context)).resolves.toEqual({ kind: 'environment', env: {} });
    expect(f.requests).toHaveLength(0);
  });
});
