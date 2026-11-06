import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  FeaturesResponseSchema,
  createProviderProbeRequestFingerprintV1,
  encryptSecretStringV1,
  sealSavedSecretResourceStoredContentV1,
  splitProviderSettingsV1,
} from '@happier-dev/protocol';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createProviderProbeHttpClient, ProviderProbeCancelledError } from './client';
import { createProviderDraftProbeService } from './draft';

// Stored daemon credentials are an OS file boundary; the Saved Secret owner stays real.
const persistenceMocks = vi.hoisted(() => ({ readStoredCredentials: vi.fn(async () => null as unknown) }));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: persistenceMocks.readStoredCredentials,
}));

afterEach(() => {
  vi.restoreAllMocks();
  persistenceMocks.readStoredCredentials.mockReset();
  persistenceMocks.readStoredCredentials.mockResolvedValue(null);
  resetActiveAccountSettingsSnapshotForTests();
  resetServerFeaturesClientForTests();
});

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
    providerConnectionsCatalog: {
      status: 'ready' as const,
      revision: 1,
      catalog: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog,
    },
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

function snapshotReader() {
  const current = snapshot();
  return () => current;
}

function sharedSecretSnapshot() {
  return {
    ...snapshot(),
    settings: AccountSettingsSchema.parse({ secrets: [] }),
    savedSecretResources: [{
      resourceId: 'resource-draft-probe',
      ownerAccountId: 'owner-account',
      displayName: 'Shared draft probe key',
      kind: 'apiKey' as const,
      encryptionMode: 'plain' as const,
      revision: 1,
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId: 'resource-draft-probe',
        mode: 'plain',
        content: { v: 1, name: 'Shared draft probe key', kind: 'apiKey', value: 'shared-draft-value' },
      }),
      materialStatus: 'ready' as const,
    }],
  };
}

function request(withCredential = false) {
  return {
    kind: 'draft' as const,
    draftConnectionId: 'pc_draft_1',
    machineId: 'machine-a',
    template: template(withCredential),
    savedSecretId: withCredential ? 'saved-secret-a' : null,
  };
}

describe('draft provider probe service', () => {
  it.each(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET'] as const)(
    'settles an unreachable draft Test with its typed Provider cause (%s)',
    async (code) => {
      // DNS and HTTP transport are external boundaries; draft admission stays real.
      const resolveAddresses = async () => {
        if (code === 'ENOTFOUND') throw Object.assign(new Error('lookup failed'), { code });
        return ['1.1.1.1'];
      };
      const transport = vi.fn(async () => { throw Object.assign(new Error('transport failed'), { code }); });
      const service = createProviderDraftProbeService({
        machineId: 'machine-a',
        getAccountSettingsSnapshot: snapshotReader(),
        resolveAddresses,
        client: createProviderProbeHttpClient({ resolveAddresses, transport }),
      });

      await expect(service.probe(request())).resolves.toMatchObject({
        status: 'error',
        error: { code: 'provider_endpoint_unreachable', connectionId: 'pc_draft_1', retryable: true, action: 'retry' },
      });
      expect(transport).toHaveBeenCalledTimes(code === 'ENOTFOUND' ? 0 : 1);
    },
  );

  it('refuses a public hostname resolving private at dispatch before disclosing its SavedSecret', async () => {
    const privateRequest = request(true);
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'must-not-dispatch' }] }), 'utf8'),
    }));
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: snapshotReader(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['10.0.0.2'],
        transport,
      }),
      now: () => 1_000,
    });

    await expect(service.probe(privateRequest)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_authorization_changed' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('admits one exact explicit Test request with one endpoint resolution', async () => {
    const resolveAddresses = vi.fn(async () => ['1.1.1.1']);
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'model-a' }] }), 'utf8'),
    }));
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: snapshotReader(),
      resolveAddresses,
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
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
    expect(resolveAddresses).toHaveBeenCalledTimes(1);
  });

  it('allows repeated and concurrent authorized reads of the same unsaved draft', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const transport = vi.fn(async () => {
      await pending;
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ data: [] }), 'utf8') };
    });
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: snapshotReader(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      now: () => 1_000,
    });

    const first = service.probe(request());
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const second = service.probe(request());
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'success' }),
    ]);
    await expect(service.probe(request())).resolves.toMatchObject({ status: 'success' });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('keeps an admitted SavedSecret Test active beyond the former default wall cutoff', async () => {
    let now = Date.now();
    const transport = vi.fn(async (input: Readonly<{ headers: Readonly<Record<string, string>> }>) => ({
      status: input.headers.authorization === 'Bearer secret-a' ? 200 : 401,
      headers: {}, body: Buffer.from(JSON.stringify({ data: [{ id: 'delayed-model' }] }), 'utf8'),
    }));
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: snapshotReader(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => { now = Date.now() + 30_001; return ['1.1.1.1']; },
        transport,
        now: () => now,
      }),
      now: () => now,
    });
    await expect(service.probe(request(true))).resolves.toMatchObject({
      status: 'success', models: [{ id: 'delayed-model' }],
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('uses declared fallback probes and returns the successful request fingerprint', async () => {
    let call = 0;
    const transport = vi.fn(async () => {
      call += 1;
      return call === 1
        ? { status: 503, headers: {}, body: Buffer.alloc(0) }
        : { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ data: [{ id: 'fallback-model' }] }), 'utf8') };
    });
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: snapshotReader(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      now: () => 1_000,
    });
    const fallbackRequest = request();
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

  it('refuses wrong-machine and missing-secret requests before provider HTTP dispatch', async () => {
    const transport = vi.fn();
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: snapshotReader(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      now: () => 1_000,
    });
    await expect(service.probe({ ...request(), machineId: 'machine-b' })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_not_enabled_on_machine' },
    });
    expect(transport).not.toHaveBeenCalled();

    const missingSecretDns = vi.fn(async () => ['1.1.1.1']);
    const missingSecretSnapshot = snapshotWithoutSecrets();
    const missingSecretService = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => missingSecretSnapshot,
      resolveAddresses: missingSecretDns,
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      now: () => 2_000,
    });
    await expect(missingSecretService.probe(request(true))).resolves.toMatchObject({
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
      getAccountSettingsSnapshot: (() => {
        const current = { ...base, settings };
        return () => current;
      })(),
      resolveAddresses: async () => ['169.254.169.254'],
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['169.254.169.254'],
        transport,
      }),
      now: () => 2_000,
    });

    await expect(service.probe(request(true))).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_probe_authorization_invalid' },
    });
    expect(secretLookups).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps concurrent edited drafts independent and identifies each exact request', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let transportCall = 0;
    const transport = vi.fn(async () => {
      transportCall += 1;
      if (transportCall === 1) await firstPending;
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ data: [{ id: `model-${transportCall}` }] }), 'utf8') };
    });
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: snapshotReader(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      now: () => 1_000,
    });
    const first = service.probe(request());
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const edited = request();
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
      status: 'success',
      requestFingerprint: createProviderProbeRequestFingerprintV1({
        method: 'GET', endpointUrl: 'https://gateway.example/v1', path: '/models',
        parser: 'openai-models', publicHeaders: {},
      }),
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('finishes an admitted read when the selected SavedSecret rotates during dispatch', async () => {
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
      now: () => 1_000,
    });

    await expect(service.probe(request(true))).resolves.toMatchObject({
      status: 'success', models: [{ id: 'stale' }],
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('uses a shared Saved Secret for a draft Provider probe', async () => {
    const transport = vi.fn(async (request: Readonly<{ headers: Readonly<Record<string, string>> }>) => ({
      status: request.headers.authorization === 'Bearer shared-draft-value' ? 200 : 401,
      headers: {},
      body: Buffer.from(JSON.stringify({ data: [{ id: 'shared-model' }] }), 'utf8'),
    }));
    const currentSnapshot = sharedSecretSnapshot();
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => currentSnapshot,
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      now: () => 1_000,
    });

    await expect(service.probe({
      ...request(true),
      savedSecretId: 'happier:shared-secret:v1:resource-draft-probe',
    })).resolves.toMatchObject({ status: 'success', models: [{ id: 'shared-model' }] });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    // Owner reason `reference_unavailable`: the hydrated row still reads ready, but the Home has not finished this material.
    ['Home preparing_encrypted_access', { status: 200, materialStatus: 'preparing_encrypted_access' }, 'provider_secret_unavailable', 'reference_unavailable'],
    // Untyped catalog failure: nothing about the secret is known, so it is unavailable, not missing.
    ['Home catalog HTTP 500', { status: 500 }, 'provider_secret_unavailable', 'reference_unavailable'],
    // Typed non-ready reasons keep the owner projection's code and carry the owner's reason unchanged.
    ['Home access_removed', { status: 200, materialStatus: 'access_removed' }, 'provider_secret_missing', 'reference_forbidden'],
    ['Home deleted', { status: 200, materialStatus: 'deleted' }, 'provider_secret_missing', 'reference_deleted'],
    ['Home update_required', { status: 200, materialStatus: 'update_required' }, 'provider_secret_missing', 'reference_repair_required'],
    ['Home recipient_mode_unsupported', { status: 200, materialStatus: 'recipient_mode_unsupported' }, 'provider_secret_missing', 'reference_mode_incompatible'],
    // A corrupt Home row carries no ref, so the owner resolves the requested ref as not authorized.
    ['Home resource_corrupt', { status: 200, materialStatus: 'resource_corrupt' }, 'provider_secret_missing', 'reference_forbidden'],
    // Ready Home-current material is admitted and dispatched once.
    ['Home ready', { status: 200, materialStatus: 'ready' }, null, null],
  ] as const)('admits a draft probe against Home-current shared material (%s)', async (_label, home, code, savedSecretReason) => {
    const transport = vi.fn(async (request: Readonly<{ headers: Readonly<Record<string, string>> }>) => ({
      status: request.headers.authorization === 'Bearer shared-draft-value' ? 200 : 401,
      headers: {},
      body: Buffer.from(JSON.stringify({ data: [{ id: 'shared-model' }] }), 'utf8'),
    }));
    const ref = 'happier:shared-secret:v1:resource-draft-probe';
    const currentSnapshot = { ...sharedSecretSnapshot(), scopeKey: resolveAccountSettingsScopeKeyForToken('draft-token') };
    setActiveAccountSettingsSnapshot(currentSnapshot);
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token: 'draft-token', encryption: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(
      FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} }),
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const homeReads = vi.spyOn(axios, 'get').mockResolvedValue(home.status !== 200 ? { status: home.status, data: {} }
      : home.materialStatus === 'resource_corrupt' ? { status: 200, data: { resources: [{
        entry: { materialStatus: 'resource_corrupt', relationship: 'recipient', repair: null } }] } } : {
      status: 200,
      data: { resources: [{ resourceId: 'resource-draft-probe', encryptionMode: 'plain', recipientEnvelope: null,
        storedContent: home.materialStatus === 'ready' ? sealSavedSecretResourceStoredContentV1({
          resourceId: 'resource-draft-probe', mode: 'plain',
          content: { v: 1, name: 'Shared draft probe key', kind: 'apiKey', value: 'shared-draft-value' },
        }) : null,
        entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Shared draft probe key', kind: 'apiKey',
          ownerAccountId: 'owner-account', revision: 1, materialStatus: home.materialStatus,
          capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } } }] },
    });
    const service = createProviderDraftProbeService({
      machineId: 'machine-a',
      getAccountSettingsSnapshot: () => currentSnapshot,
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      now: () => 1_000,
    });

    const result = await service.probe({ ...request(true), savedSecretId: ref });

    expect(homeReads).toHaveBeenCalledTimes(1);
    if (code === null) {
      expect(result).toMatchObject({ status: 'success', models: [{ id: 'shared-model' }] });
      expect(transport).toHaveBeenCalledTimes(1);
      return;
    }
    expect(result).toEqual({ status: 'error',
      error: { ...createProviderErrorV1(code, { connectionId: 'pc_draft_1', machineId: 'machine-a' }), savedSecretReason } });
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses an explicitly tested private Machine endpoint despite ordinary private DNS drift', async () => {
    const privateRequest = request(true);
    privateRequest.template.endpointTemplates[0]!.baseUrl = 'http://gateway.internal:1234/';
    const transport = vi.fn(async (input: Readonly<{ headers: Readonly<Record<string, string>> }>) => ({
      status: input.headers.authorization === 'Bearer secret-a' ? 200 : 401,
      headers: {}, body: Buffer.from(JSON.stringify({ data: [{ id: 'private-model' }] }), 'utf8'),
    }));
    const service = createProviderDraftProbeService({
      machineId: 'machine-a', getAccountSettingsSnapshot: snapshotReader(),
      resolveAddresses: async () => ['10.0.0.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['10.0.0.2'], transport }),
    });
    await expect(service.probe(privateRequest)).resolves.toMatchObject({
      status: 'success', models: [{ id: 'private-model' }],
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('keeps an admitted read but refuses fresh credential acquisition after an Account switch (credential=%s)', async withCredential => {
    // Personal-secret fixtures have no Home settings owner. The bound reader
    // pins that unscoped snapshot by identity until credential acquisition.
    let currentSnapshot = { ...snapshot(), scopeKey: withCredential ? undefined : 'home-a-account-a' };
    const transport = vi.fn(async () => ({ status: 200, headers: {},
      body: Buffer.from(JSON.stringify({ data: [{ id: 'admitted-model' }] }), 'utf8') }));
    const service = createProviderDraftProbeService({
      machineId: 'machine-a', getAccountSettingsSnapshot: () => currentSnapshot,
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => {
          currentSnapshot = { ...currentSnapshot, scopeKey: 'home-b-account-b' };
          return ['1.1.1.1'];
        }, transport,
      }),
    });
    if (withCredential) {
      await expect(service.probe(request(true))).resolves.toMatchObject({
        status: 'error', error: { code: 'provider_authorization_changed' },
      });
      expect(transport).not.toHaveBeenCalled();
    } else {
      await expect(service.probe(request())).resolves.toMatchObject({
        status: 'success', models: [{ id: 'admitted-model' }],
      });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses a cross-origin redirect without disclosing the selected secret to its destination', async () => {
    const transport = vi.fn(async () => ({
      status: 302, headers: { location: 'https://other.example/models' }, body: Buffer.alloc(0),
    }));
    const service = createProviderDraftProbeService({
      machineId: 'machine-a', getAccountSettingsSnapshot: snapshotReader(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
    });
    await expect(service.probe(request(true))).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_authorization_changed' },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('cancels the admitted draft HTTP read when its local caller aborts', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const transport = vi.fn(async () => {
      await pending;
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ data: [] }), 'utf8') };
    });
    const service = createProviderDraftProbeService({
      machineId: 'machine-a', getAccountSettingsSnapshot: snapshotReader(),
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
    });
    const controller = new AbortController();
    const result = service.probe(request(), { signal: controller.signal, wallDeadlineAtMs: Infinity });
    const settled = expect(result).rejects.toBeInstanceOf(ProviderProbeCancelledError);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    controller.abort();
    release();
    await settled;
  });
});
