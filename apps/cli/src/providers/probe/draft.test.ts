import { describe, expect, it, vi } from 'vitest';
import {
  AccountSettingsSchema,
  createProviderProbeRequestFingerprintV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { createProviderProbeHttpClient } from './client';
import { createProviderDraftProbeService } from './draft';

const key = new Uint8Array(32).fill(7);

function template(withCredential = false) {
  return {
    v: 1 as const,
    name: 'Draft gateway',
    endpointTemplates: [{
      id: 'openai',
      protocol: 'openai-chat' as const,
      baseUrl: 'https://gateway.example/v1',
      capabilities: {
        streaming: 'unknown' as const,
        toolRoundTrips: 'unknown' as const,
        statefulResponses: 'unknown' as const,
        reasoningControls: 'unknown' as const,
      },
    }],
    ...(withCredential ? {
      credential: {
        kind: 'apiKey' as const,
        slotId: 'apiKey' as const,
        required: true,
        transports: [{
          id: 'probe-bearer',
          protocols: ['openai-chat' as const],
          uses: ['probe' as const, 'runtime' as const],
          destination: { kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const },
        }],
      },
    } : {}),
    catalog: {
      source: 'probe' as const,
      manualModelPolicy: 'allowed' as const,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' as const }],
    },
  };
}

function snapshot(secretValue = 'secret-a') {
  const encryptedValue = encryptSecretStringV1(secretValue, key, (length) => new Uint8Array(length).fill(3));
  return {
    source: 'cache' as const,
    settings: AccountSettingsSchema.parse({
      secrets: [{
        id: 'saved-secret-a',
        name: 'Draft probe secret',
        encryptedValue: { _isSecretValue: true, encryptedValue },
      }],
    }),
    settingsVersion: 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [key],
  };
}

function snapshotWithoutSecrets() {
  return {
    ...snapshot(),
    settings: AccountSettingsSchema.parse({ secrets: [] }),
  };
}

function request(actionNonce = 'draft-action-0001', withCredential = false) {
  return {
    kind: 'draft' as const,
    draftConnectionId: 'pc_draft_1',
    machineId: 'machine-a',
    template: template(withCredential),
    savedSecretId: withCredential ? 'saved-secret-a' : null,
    actionNonce,
  };
}

describe('draft provider probe service', () => {
  it('rejects the exact private dispatch address set before transport when it differs from the set revalidated by the draft owner', async () => {
    const privateRequest = request('draft-action-private-address');
    privateRequest.template.endpointTemplates[0]!.baseUrl = 'http://gateway.internal:1234/';
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'must-not-dispatch' }] }), 'utf8'),
    }));
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => snapshot(),
      resolveAddresses: async () => ['10.0.0.1'],
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['10.0.0.2'],
        transport,
      }),
      createAuthorizationId: () => 'authorization-private-address',
      now: () => 1_000,
    });

    await expect(service.probe(privateRequest)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_authorization_changed' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('mints and consumes a daemon-only authorization for one exact explicit Test request', async () => {
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'model-a' }] }), 'utf8'),
    }));
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => snapshot(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      createAuthorizationId: () => 'authorization-0001',
      now: () => 1_000,
    });

    await expect(service.probe(request())).resolves.toEqual({
      status: 'success',
      models: [{ id: 'model-a' }],
      requestFingerprint: createProviderProbeRequestFingerprintV1({
        method: 'GET', endpointUrl: 'https://gateway.example/v1', path: '/models',
        parser: 'openai-models', publicHeaders: {},
      }),
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(transport.mock.calls)).not.toContain('authorization-0001');
  });

  it('rejects replay and concurrent double-submit before a second provider request', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const transport = vi.fn(async () => {
      await pending;
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ data: [] }), 'utf8') };
    });
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => snapshot(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      createAuthorizationId: () => 'authorization-0001',
      now: () => 1_000,
    });

    const first = service.probe(request());
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    await expect(service.probe(request())).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_probe_authorization_invalid' },
    });
    release();
    await expect(first).resolves.toMatchObject({ status: 'success' });
    await expect(service.probe(request())).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_probe_authorization_invalid' },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('bounds live replay-cache entries and refuses overflow before provider dispatch', async () => {
    const transport = vi.fn(async () => ({
      status: 200, headers: {}, body: Buffer.from(JSON.stringify({ data: [] }), 'utf8'),
    }));
    let authorizationId = 0;
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => snapshot(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      createAuthorizationId: () => `authorization-${String(++authorizationId).padStart(4, '0')}`,
      now: () => 1_000,
      maxReplayEntries: 2,
    });
    await expect(service.probe(request('draft-action-0010'))).resolves.toMatchObject({ status: 'success' });
    await expect(service.probe(request('draft-action-0011'))).resolves.toMatchObject({ status: 'success' });
    await expect(service.probe(request('draft-action-0012'))).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_probe_authorization_invalid' },
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('mints one exact authorization per declared fallback probe and returns the successful request fingerprint', async () => {
    let call = 0;
    const transport = vi.fn(async () => {
      call += 1;
      return call === 1
        ? { status: 503, headers: {}, body: Buffer.alloc(0) }
        : { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ data: [{ id: 'fallback-model' }] }), 'utf8') };
    });
    let authorizationId = 0;
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => snapshot(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      createAuthorizationId: () => `authorization-${String(++authorizationId).padStart(4, '0')}`,
      now: () => 1_000,
    });
    const fallbackRequest = request('draft-action-0013');
    fallbackRequest.template.catalog.probes.push({
      endpointTemplateId: 'openai', path: '/v2/models', parser: 'openai-models',
    });

    await expect(service.probe(fallbackRequest)).resolves.toMatchObject({
      status: 'success',
      models: [{ id: 'fallback-model' }],
      requestFingerprint: createProviderProbeRequestFingerprintV1({
        method: 'GET', endpointUrl: 'https://gateway.example/v1', path: '/v2/models',
        parser: 'openai-models', publicHeaders: {},
      }),
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('refuses wrong-machine, missing-secret, and expired authorization before provider HTTP dispatch', async () => {
    let now = 1_000;
    const transport = vi.fn();
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => snapshot(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      createAuthorizationId: () => 'authorization-0001',
      now: () => now,
      authorizationTtlMs: 10,
      beforeAuthorizationConsume: () => { now = 1_011; },
    });
    await expect(service.probe({ ...request(), machineId: 'machine-b' })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_not_enabled_on_machine' },
    });
    await expect(service.probe(request('draft-action-0002', true))).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_probe_authorization_invalid' },
    });
    expect(transport).not.toHaveBeenCalled();

    const missingSecretDns = vi.fn(async () => ['1.1.1.1']);
    const missingSecretService = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: snapshotWithoutSecrets,
      resolveAddresses: missingSecretDns,
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      createAuthorizationId: () => 'authorization-0002',
      now: () => 2_000,
    });
    await expect(missingSecretService.probe(request('draft-action-0004', true))).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_secret_missing' },
    });
    expect(missingSecretDns).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses an unsafe endpoint before looking up the selected SavedSecret', async () => {
    const base = snapshot();
    const persistedSecrets = base.settings.secrets;
    let secretLookups = 0;
    const settings = { ...base.settings };
    Object.defineProperty(settings, 'secrets', {
      configurable: true,
      enumerable: true,
      get: () => {
        secretLookups += 1;
        return persistedSecrets;
      },
    });
    const transport = vi.fn();
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => ({ ...base, settings }),
      resolveAddresses: async () => ['169.254.169.254'],
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['169.254.169.254'],
        transport,
      }),
      createAuthorizationId: () => 'authorization-unsafe-endpoint',
      now: () => 2_000,
    });

    await expect(service.probe(request('draft-action-unsafe-endpoint', true))).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_probe_authorization_invalid' },
    });
    expect(secretLookups).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it('invalidates an older in-flight draft after an edited path/parser action for the same draft id', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let transportCall = 0;
    const transport = vi.fn(async () => {
      transportCall += 1;
      if (transportCall === 1) await firstPending;
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ data: [{ id: `model-${transportCall}` }] }), 'utf8') };
    });
    let authorizationId = 0;
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => snapshot(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      createAuthorizationId: () => `authorization-${String(++authorizationId).padStart(4, '0')}`,
      now: () => 1_000,
    });
    const first = service.probe(request('draft-action-0005'));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const edited = request('draft-action-0006');
    edited.template.catalog.probes[0]!.path = '/v2/models';
    const second = service.probe(edited);
    await expect(second).resolves.toMatchObject({
      status: 'success',
      requestFingerprint: createProviderProbeRequestFingerprintV1({
        method: 'GET', endpointUrl: 'https://gateway.example/v1', path: '/v2/models',
        parser: 'openai-models', publicHeaders: {},
      }),
    });
    releaseFirst();
    await expect(first).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_probe_authorization_invalid' },
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('discards an in-flight response after the selected SavedSecret record rotates', async () => {
    let currentSnapshot = snapshot('secret-a');
    const transport = vi.fn(async () => {
      currentSnapshot = snapshot('secret-b');
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ data: [{ id: 'stale' }] }), 'utf8') };
    });
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => currentSnapshot,
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      createAuthorizationId: () => 'authorization-0001',
      now: () => 1_000,
    });

    await expect(service.probe(request('draft-action-0003', true))).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_authorization_changed' },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
