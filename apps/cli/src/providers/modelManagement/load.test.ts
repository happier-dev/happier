import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderContributionV1Schema, ProviderSettingsV1Schema,
  createProviderErrorV1, splitProviderSettingsV1, type ProviderErrorV1 } from '@happier-dev/protocol';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createProviderRuntimeStateStore } from '../runtimeState';
import { resolveProviderConnectionForMachine } from '../registry';
import { createRuntimeProviderModelManagementServices } from './runtimeServices';

import {
  createProviderModelLoadHttpPort,
  createProviderModelLoadService,
  evaluateProviderModelLoadPreflight,
  ProviderModelLoadCancelledError,
  type ProviderModelLoadAuthorization,
  type ProviderModelLoadServiceDependencies,
} from './load';
import {
  ProviderProbeCredentialResolutionError,
} from '../probe/authorization';
import {
  ProviderProbeCancelledError,
  ProviderProbeClientError,
  createProviderProbeHttpClient,
  type ProviderProbeTransport,
} from '../probe/client';
import { parseLmStudioModels } from '../../../../../packages/plugins/lmstudio/src/provider/contribution';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { configuration } from '@/configuration';

type Ticket = Readonly<{ revision: number }>;
type CredentialRef = Readonly<{ id: string }>;

const descriptor = {
  endpointTemplateId: 'management',
  path: '/api/v1/models/load',
  request: 'json-model-id-v1',
  confirmation: 'refresh-catalog-load-state',
  preflightPolicy: 'advisory',
} as const;

it('coalesces admitted model loads past the former ten-minute cutoff and a connection rename', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-admitted-load-'));
  const definition = ProviderContributionV1Schema.parse({
    v: 1, id: 'loader', name: 'Loader', kind: 'local',
    endpointTemplates: [{ id: 'management', protocol: 'openai-chat', localUrlCandidates: ['http://127.0.0.1:1234/'],
      capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
    catalog: { source: 'probe', manualModelPolicy: 'allowed',
      probes: [{ endpointTemplateId: 'management', path: '/api/v1/models', reportsModelLoadState: true, parser: 'lmstudio-native-models' }] },
    modelLoad: descriptor,
  });
  const registry = { providersByContributionKey: new Map([['acme.loader/loader', {
    provenance: 'external' as const, source: { kind: 'path' as const }, pluginId: 'acme.loader',
    identity: { pluginId: 'acme.loader', localId: 'loader' }, definition,
  }]]) };
  const plugin = definePlugin({ id: 'acme.loader', version: '1.0.0', displayName: 'Loader',
    entrypoints: { daemon: './daemon.mjs' },
    providers: { loader: { declaration: definition,
      catalogParsers: { 'lmstudio-native-models': parseLmStudioModels } } },
  });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    happyHomeDir: homeDir, controller: pluginReloadController, coldStart: true,
    plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
      instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
    async resolveContributes(happyHomeDir) {
      return createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
      }));
    },
  });
  const baseSettings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{
    v: 1, id: 'connection-a', source: { kind: 'contribution', contributionKey: 'acme.loader/loader' },
    role: 'default', displayName: 'Loader', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
  }] });
  const resolved = resolveProviderConnectionForMachine({ connectionId: 'connection-a', machineId: 'machine-a',
    providerSettings: baseSettings, registry, dnsEvidenceByEndpointUrl: new Map() });
  if (resolved.status !== 'resolved') throw new Error('Expected local model-load source');
  const settings = ProviderSettingsV1Schema.parse({ ...baseSettings, machineGrants: [{
    v: 1, machineId: 'machine-a', connectionId: 'connection-a', confirmedAt: 1,
    endpointSetFingerprint: resolved.record.endpointSetFingerprint,
    connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
  }] });
  let snapshot: ActiveAccountSettingsSnapshot = {
    source: 'cache', settings: AccountSettingsSchema.parse({}),
    providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog },
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account-a',
  };
  let loaded = false;
  let enterPost!: () => void;
  let releasePost!: () => void;
  const postEntered = new Promise<void>(resolve => { enterPost = resolve; });
  const postReleased = new Promise<void>(resolve => { releasePost = resolve; });
  let postCount = 0;
  const client = createProviderProbeHttpClient({
    resolveAddresses: async () => ['127.0.0.1'],
    // DNS and HTTP are the system boundaries; authorization, catalog parsing,
    // runtime persistence, load orchestration and confirmation stay real.
    transport: async input => {
      if (input.method === 'POST') {
        postCount++;
        enterPost();
        await postReleased;
        loaded = true;
      }
      return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({
        models: [{ key: 'model-a', type: 'llm', loaded_instances: loaded ? [{ id: 'instance-a' }] : [] }],
      })) };
    },
  });
  const services = createRuntimeProviderModelManagementServices({ machineId: 'machine-a', happyHomeDir: configuration.happyHomeDir,
    registry, featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => snapshot,
    resolveAddresses: async () => ['127.0.0.1'], runtimeStore: createProviderRuntimeStateStore({ happyHomeDir: homeDir, machineId: 'machine-a' }), client,
    modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected model-settings mutation'); },
  });
  let pending: Promise<Awaited<ReturnType<typeof services.loadModel>>[]> | undefined;
  const startedAt = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
  try {
    await expect(services.probe({ machineId: 'machine-a', connectionId: 'connection-a' })).resolves.toMatchObject({ status: 'success' });
    const request = { machineId: 'machine-a', connectionId: 'connection-a', modelId: 'model-a' };
    pending = Promise.all([services.loadModel(request), services.loadModel(request)]);
    await postEntered;
    clock.mockReturnValue(startedAt + 601_000);
    const renamed = ProviderSettingsV1Schema.parse({ ...settings, connections: settings.connections.map(connection => ({
      ...connection, displayName: 'Renamed loader', displayNameMode: 'custom', revision: connection.revision + 1,
    })) });
    snapshot = { ...snapshot, providerConnectionsCatalog: { status: 'ready', revision: 2, catalog: splitProviderSettingsV1(renamed).catalog } };
    releasePost();
    await expect(pending).resolves.toEqual([
      { status: 'loaded', source: 'requested' },
      { status: 'loaded', source: 'requested' },
    ]);
    expect(postCount).toBe(1);
  } finally {
    releasePost();
    await pending;
    clock.mockRestore();
    await fixture.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
});

function authorization(overrides: Partial<ProviderModelLoadAuthorization<Ticket, CredentialRef>> = {}): ProviderModelLoadAuthorization<Ticket, CredentialRef> {
  return {
    ticket: { revision: 1 },
    source: 'trusted_local_contribution',
    descriptor,
    endpoint: {
      endpointTemplateId: 'management',
      endpointUrl: 'http://127.0.0.1:1234/',
      endpointFingerprint: 'endpoint-fingerprint-a',
      publicHeaders: {},
    },
    credentialRef: null,
    ...overrides,
  };
}

function harness(input: Readonly<{
  enabled?: boolean;
  isEnabled?: () => boolean;
  initialLoadState?: 'loaded' | 'unloaded' | 'unknown';
  confirmedLoadState?: 'loaded' | 'unloaded' | 'unknown';
  authorization?: ProviderModelLoadAuthorization<Ticket, CredentialRef> | ProviderErrorV1 | 'unavailable';
  post?: ProviderModelLoadServiceDependencies<Ticket, CredentialRef>['http']['postJsonModelId'];
  authorize?: ProviderModelLoadServiceDependencies<Ticket, CredentialRef>['authorization']['authorize'];
  authorizeDestination?: ProviderModelLoadServiceDependencies<Ticket, CredentialRef>['authorization']['authorizeDestination'];
  refresh?: ProviderModelLoadServiceDependencies<Ticket, CredentialRef>['catalog']['refresh'];
  http?: ProviderModelLoadServiceDependencies<Ticket, CredentialRef>['http'];
}> = {}) {
  let refreshed = false;
  const auth = input.authorization === undefined ? authorization() : input.authorization;
  const postJsonModelId = vi.fn(input.post ?? (async () => ({ ok: true as const, statusCode: 200 })));
  const readCurrentModel = vi.fn<ProviderModelLoadServiceDependencies<Ticket, CredentialRef>['catalog']['readCurrentModel']>(async () => ({
    status: 'listed' as const,
    catalogObservationId: refreshed ? 'observation-b' : 'observation-a',
    loadState: refreshed ? (input.confirmedLoadState ?? 'loaded') : (input.initialLoadState ?? 'unloaded'),
  }));
  const refresh = vi.fn(input.refresh ?? (async () => {
    refreshed = true;
    return { status: 'success' as const };
  }));
  const authorize = vi.fn(input.authorize ?? (async () => auth === 'unavailable'
    ? { status: 'unavailable' as const }
    : 'code' in auth
      ? { status: 'error' as const, error: auth }
      : { status: 'authorized' as const, authorization: auth }));
  const resolveCredential = vi.fn(async () => ({
    ok: true as const,
    lease: {
      credential: { kind: 'httpHeader' as const, name: 'authorization', value: 'Bearer secret' },
      containsSensitiveValue: (value: string) => value.includes('secret'),
      close: vi.fn(),
    },
  }));
  const service = createProviderModelLoadService<Ticket, CredentialRef>({
    isFeatureEnabled: input.isEnabled ?? (() => input.enabled ?? true),
    authorization: {
      authorize,
      authorizeDestination: vi.fn(input.authorizeDestination ?? (async () => ({ ok: true as const }))),
      resolveCredential,
    },
    catalog: { readCurrentModel, refresh },
    http: input.http ?? { postJsonModelId },
  });
  return {
    service,
    authorize,
    postJsonModelId,
    readCurrentModel,
    refresh,
    resolveCredential,
  };
}

describe('provider model-load preflight', () => {
  it('blocks only verified unloaded models with a required descriptor', () => {
    expect(evaluateProviderModelLoadPreflight({ descriptor: null, loadState: 'unloaded' })).toEqual({
      status: 'allowed', loadActionAvailable: false,
    });
    expect(evaluateProviderModelLoadPreflight({ descriptor, loadState: 'unloaded' })).toEqual({
      status: 'allowed', loadActionAvailable: true,
    });
    expect(evaluateProviderModelLoadPreflight({
      descriptor: { ...descriptor, preflightPolicy: 'required' }, loadState: 'unknown',
    })).toEqual({ status: 'allowed', loadActionAvailable: true });
    expect(evaluateProviderModelLoadPreflight({
      descriptor: { ...descriptor, preflightPolicy: 'required' }, loadState: 'unloaded',
    })).toMatchObject({ status: 'blocked', error: { code: 'provider_model_unloaded', action: 'load_model' } });
  });
});

describe('provider model-load safe-client adapter', () => {
  const portInput = {
    connectionId: 'connection-a',
    machineId: 'machine-a',
    endpointUrl: 'http://127.0.0.1:1234/',
    path: '/api/v1/models/load',
    publicHeaders: {},
    body: { model: 'model-a' },
    resolveCredential: async () => ({
      credential: { kind: 'httpHeader' as const, name: 'authorization', value: 'Bearer secret' },
      containsSensitiveValue: (value: string) => value.includes('secret'),
      close: () => {},
    }),
    authorizeDestination: async () => {},
    redirectPolicy: 'reject',
    signal: new AbortController().signal,
  } as const;

  it('adapts only the fixed model-id request to the canonical safe HTTP client', async () => {
    const postModelLoad = vi.fn(async () => ({ statusCode: 204 }));
    const port = createProviderModelLoadHttpPort({ postModelLoad });
    await expect(port.postJsonModelId(portInput)).resolves.toEqual({ ok: true, statusCode: 204 });
    expect(postModelLoad).toHaveBeenCalledWith({
      endpointUrl: portInput.endpointUrl,
      path: portInput.path,
      publicHeaders: {},
      modelId: 'model-a',
      resolveCredential: portInput.resolveCredential,
      authorizeDestination: portInput.authorizeDestination,
      signal: portInput.signal,
    });
  });

  it('maps safe-client failures without exposing raw transport errors and preserves cancellation', async () => {
    const unavailable = createProviderModelLoadHttpPort({
      postModelLoad: async () => { throw new ProviderProbeClientError('provider_endpoint_unavailable'); },
    });
    await expect(unavailable.postJsonModelId(portInput)).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_endpoint_unavailable', connectionId: 'connection-a', machineId: 'machine-a' },
    });

    const cancelled = createProviderModelLoadHttpPort({
      postModelLoad: async () => { throw new ProviderProbeCancelledError(); },
    });
    await expect(cancelled.postJsonModelId(portInput)).rejects.toBeInstanceOf(ProviderModelLoadCancelledError);
  });

  it('preserves a typed credential-resolution refusal through the safe-client adapter', async () => {
    const refusal = createProviderErrorV1('provider_secret_missing', {
      connectionId: 'connection-a', machineId: 'machine-a',
    });
    const port = createProviderModelLoadHttpPort({
      postModelLoad: async (input) => {
        await input.resolveCredential?.();
        return { statusCode: 204 };
      },
    });
    await expect(port.postJsonModelId({
      ...portInput,
      resolveCredential: async () => { throw new ProviderProbeCredentialResolutionError(refusal); },
    })).rejects.toMatchObject({ error: refusal });
  });
});

describe('explicit provider model loading', () => {
  const request = { connectionId: 'connection-a', machineId: 'machine-a', modelId: 'model-a' } as const;

  it('fails closed when the feature or trusted descriptor is absent and issues no POST', async () => {
    const disabled = harness({ enabled: false });
    await expect(disabled.service.loadNow(request)).resolves.toEqual({ status: 'not_supported', reason: 'feature_disabled' });
    expect(disabled.postJsonModelId).not.toHaveBeenCalled();

    const absent = harness({ authorization: 'unavailable' });
    await expect(absent.service.loadNow(request)).resolves.toEqual({ status: 'not_supported', reason: 'descriptor_absent' });
    expect(absent.postJsonModelId).not.toHaveBeenCalled();

    const endpointMismatch = harness({
      authorization: authorization({
        endpoint: {
          endpointTemplateId: 'other-endpoint',
          endpointUrl: 'http://127.0.0.1:1234/',
          endpointFingerprint: 'endpoint-fingerprint-a',
          publicHeaders: {},
        },
      }),
    });
    await expect(endpointMismatch.service.loadNow(request)).resolves.toEqual({
      status: 'not_supported', reason: 'descriptor_absent',
    });
    expect(endpointMismatch.postJsonModelId).not.toHaveBeenCalled();
  });

  it('requires the exact current catalog model before resolving a credential or POSTing', async () => {
    const test = harness({ authorization: authorization({ credentialRef: { id: 'credential-a' } }) });
    test.readCurrentModel.mockResolvedValueOnce({ status: 'not_found' });
    await expect(test.service.loadNow(request)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_model_not_found' },
    });
    expect(test.resolveCredential).not.toHaveBeenCalled();
    expect(test.postJsonModelId).not.toHaveBeenCalled();
  });

  it('does not resolve a credential when fresh model-load dispatch DNS is unsafe', async () => {
    const transport = vi.fn<ProviderProbeTransport>();
    const test = harness({
      authorization: authorization({
        credentialRef: { id: 'credential-a' },
        endpoint: {
          endpointTemplateId: 'management',
          endpointUrl: 'https://models.example/',
          endpointFingerprint: 'endpoint-fingerprint-a',
          publicHeaders: {},
        },
      }),
      http: createProviderModelLoadHttpPort(createProviderProbeHttpClient({
        resolveAddresses: async () => ['64:ff9b:1:a9fe:a9:fe00::'],
        transport,
      })),
    });

    await expect(test.service.loadNow(request)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_endpoint_unreachable' },
    });
    expect(test.resolveCredential).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses missing credentials before any POST', async () => {
    const missing = createProviderErrorV1('provider_secret_missing', {
      connectionId: request.connectionId, machineId: request.machineId,
    });
    const test = harness({ authorization: missing });
    await expect(test.service.loadNow(request)).resolves.toEqual({ status: 'error', error: missing });
    expect(test.postJsonModelId).not.toHaveBeenCalled();
  });

  it('constructs only the fixed request and reports success after exact catalog confirmation', async () => {
    const test = harness({
      authorization: authorization({ credentialRef: { id: 'credential-a' } }),
    });
    await expect(test.service.loadNow(request)).resolves.toEqual({ status: 'loaded', source: 'requested' });
    expect(test.postJsonModelId).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl: 'http://127.0.0.1:1234/',
      path: '/api/v1/models/load',
      body: { model: 'model-a' },
      redirectPolicy: 'reject',
      resolveCredential: expect.any(Function),
    }));
    expect(test.refresh).toHaveBeenCalledTimes(1);
    expect(test.readCurrentModel).toHaveBeenCalledTimes(2);
  });

  it('does not POST when a current refresh observes an external load', async () => {
    const test = harness({ initialLoadState: 'loaded' });
    await expect(test.service.loadNow(request)).resolves.toEqual({ status: 'loaded', source: 'already_loaded' });
    expect(test.postJsonModelId).not.toHaveBeenCalled();
    expect(test.refresh).not.toHaveBeenCalled();
  });

  it('runs a separate operation when the endpoint generation rotates under one model', async () => {
    const releases: Array<() => void> = [];
    let endpointFingerprint = 'endpoint-fingerprint-a';
    const test = harness({
      authorize: async () => ({
        status: 'authorized' as const,
        authorization: authorization({
          endpoint: {
            endpointTemplateId: 'management',
            endpointUrl: endpointFingerprint === 'endpoint-fingerprint-a'
              ? 'http://127.0.0.1:1234/'
              : 'http://127.0.0.1:5678/',
            endpointFingerprint,
            publicHeaders: {},
          },
        }),
      }),
      post: () => new Promise((resolve) => {
        releases.push(() => resolve({ ok: true as const, statusCode: 200 }));
      }),
    });
    const first = test.service.loadNow(request);
    await vi.waitFor(() => expect(test.postJsonModelId).toHaveBeenCalledTimes(1));

    endpointFingerprint = 'endpoint-fingerprint-b';
    const second = test.service.loadNow(request);

    try {
      await vi.waitFor(() => expect(test.postJsonModelId).toHaveBeenCalledTimes(2));
      expect(test.authorize).toHaveBeenCalledTimes(2);
      expect(test.postJsonModelId).toHaveBeenNthCalledWith(1, expect.objectContaining({
        endpointUrl: 'http://127.0.0.1:1234/',
      }));
      expect(test.postJsonModelId).toHaveBeenNthCalledWith(2, expect.objectContaining({
        endpointUrl: 'http://127.0.0.1:5678/',
      }));
    } finally {
      for (const release of releases.splice(0)) release();
      await Promise.allSettled([first, second]);
    }
  });

  it('keeps distinct model ids separate under the same endpoint generation', async () => {
    const releases: Array<() => void> = [];
    const test = harness({ post: () => new Promise(resolve => {
      releases.push(() => resolve({ ok: true, statusCode: 200 }));
    }) });
    const pending = Promise.all([
      test.service.loadNow(request),
      test.service.loadNow({ ...request, modelId: 'model-b' }),
    ]);
    try {
      await vi.waitFor(() => expect(test.postJsonModelId).toHaveBeenCalledTimes(2));
      expect(test.postJsonModelId.mock.calls.map(([input]) => input.body)).toEqual([
        { model: 'model-a' }, { model: 'model-b' },
      ]);
    } finally {
      for (const release of releases) release();
      await pending;
    }
  });

  it('redacts an unexpected catalog read failure without dispatching a model load', async () => {
    const test = harness();
    test.readCurrentModel.mockRejectedValueOnce(new Error('catalog resolver raced'));
    await expect(test.service.loadNow(request)).resolves.toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unavailable' } });
    expect(test.postJsonModelId).not.toHaveBeenCalled();
  });

  it('preserves the exact destination-authorization error and issues no accepted POST', async () => {
    const changed = createProviderErrorV1('provider_authorization_changed', {
      connectionId: request.connectionId, machineId: request.machineId,
    });
    const test = harness({
      authorizeDestination: async () => ({ ok: false, error: changed }),
      post: async ({ authorizeDestination }) => {
        await authorizeDestination({
          normalizedUrl: 'http://127.0.0.1:1234/api/v1/models/load',
          scope: 'machine',
          locality: 'loopback',
          origin: 'http://127.0.0.1:1234',
          hostname: '127.0.0.1',
          protocol: 'http:',
          resolvedAddresses: ['127.0.0.1'],
          nonPublicAddresses: ['127.0.0.1'],
        });
        return { ok: true, statusCode: 200 };
      },
    });
    await expect(test.service.loadNow(request)).resolves.toEqual({ status: 'error', error: changed });
    expect(test.refresh).not.toHaveBeenCalled();
  });

  it('returns unloaded when 2xx is not confirmed by a new exact catalog observation', async () => {
    const test = harness({ confirmedLoadState: 'unloaded' });
    await expect(test.service.loadNow(request)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_model_unloaded', action: 'load_model' },
    });
  });

  it('returns unloaded when the confirmation refresh is unsupported or fails to list the exact model', async () => {
    const unsupported = harness({ refresh: async () => ({ status: 'not_supported' }) });
    await expect(unsupported.service.loadNow(request)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_model_unloaded' },
    });

    const disappeared = harness();
    disappeared.readCurrentModel
      .mockResolvedValueOnce({ status: 'listed', catalogObservationId: 'observation-a', loadState: 'unloaded' })
      .mockResolvedValueOnce({ status: 'not_found' });
    await expect(disappeared.service.loadNow(request)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_model_unloaded' },
    });
  });

  it('forwards redacted safe-client authorization, redirect, and timeout failures', async () => {
    for (const error of [
      createProviderErrorV1('provider_endpoint_unauthorized', {
        connectionId: request.connectionId, machineId: request.machineId,
      }),
      createProviderErrorV1('provider_probe_response_invalid', {
        connectionId: request.connectionId, machineId: request.machineId,
      }),
      createProviderErrorV1('provider_endpoint_unavailable', {
        connectionId: request.connectionId, machineId: request.machineId,
      }),
    ]) {
      const test = harness({ post: async () => ({ ok: false, error }) });
      await expect(test.service.loadNow(request)).resolves.toEqual({ status: 'error', error });
      expect(test.refresh).not.toHaveBeenCalled();
    }
  });

  it('maps a wrong management key response without attempting catalog confirmation', async () => {
    const test = harness({
      authorization: authorization({ credentialRef: { id: 'credential-a' } }),
      post: async () => ({ ok: true, statusCode: 401 }),
    });
    await expect(test.service.loadNow(request)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_endpoint_unauthorized', action: 'replace_secret' },
    });
    expect(test.refresh).not.toHaveBeenCalled();
  });

  it('distinguishes an optional missing management key from a rejected bound key', async () => {
    const test = harness({ post: async () => ({ ok: true, statusCode: 401 }) });
    await expect(test.service.loadNow(request)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_endpoint_auth_required', action: 'add_secret' },
    });
    expect(test.resolveCredential).not.toHaveBeenCalled();
    expect(test.refresh).not.toHaveBeenCalled();
  });

  it('cancels Happier waiting while warning that the provider may continue', async () => {
    const controller = new AbortController();
    const test = harness({
      post: async ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ProviderModelLoadCancelledError()), { once: true });
      }),
    });
    const pending = test.service.loadNow({ ...request, signal: controller.signal });
    await vi.waitFor(() => expect(test.postJsonModelId).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'cancelled', providerMayContinue: true });
  });

  it('idempotently cancels the exact in-flight load without a durable operation id', async () => {
    const test = harness({
      post: async ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ProviderModelLoadCancelledError()), { once: true });
      }),
    });
    const pending = test.service.loadNow(request);
    await vi.waitFor(() => expect(test.postJsonModelId).toHaveBeenCalledTimes(1));

    await expect(test.service.cancelNow(request)).resolves.toEqual({
      status: 'cancelled',
      providerMayContinue: true,
    });
    await expect(pending).resolves.toEqual({ status: 'cancelled', providerMayContinue: true });
    await expect(test.service.cancelNow(request)).resolves.toEqual({
      status: 'cancelled',
      providerMayContinue: true,
    });
    expect(test.postJsonModelId).toHaveBeenCalledTimes(1);
  });

  it('does not start catalog, secret, or POST work when cancellation wins during authorization', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const test = harness({
      authorize: () => new Promise((resolve) => {
        release = () => resolve({ status: 'authorized', authorization: authorization() });
      }),
    });
    const pending = test.service.loadNow({ ...request, signal: controller.signal });
    controller.abort();
    release();
    await expect(pending).resolves.toEqual({ status: 'cancelled', providerMayContinue: true });
    expect(test.readCurrentModel).not.toHaveBeenCalled();
    expect(test.resolveCredential).not.toHaveBeenCalled();
    expect(test.postJsonModelId).not.toHaveBeenCalled();
  });

  it('cancels an existing authorization after the feature is disabled while rejecting a new load', async () => {
    let enabled = true;
    let releaseAuthorization!: () => void;
    const test = harness({
      isEnabled: () => enabled,
      authorize: () => new Promise((resolve) => {
        releaseAuthorization = () => resolve({ status: 'authorized', authorization: authorization() });
      }),
    });
    const pending = test.service.loadNow(request);
    await vi.waitFor(() => expect(test.authorize).toHaveBeenCalledOnce());

    try {
      enabled = false;
      await expect(test.service.cancelNow(request)).resolves.toEqual({
        status: 'cancelled',
        providerMayContinue: true,
      });
      await expect(pending).resolves.toEqual({
        status: 'cancelled',
        providerMayContinue: true,
      });
      await expect(test.service.loadNow(request)).resolves.toEqual({
        status: 'not_supported',
        reason: 'feature_disabled',
      });
      releaseAuthorization();
      await Promise.resolve();
      expect(test.readCurrentModel).not.toHaveBeenCalled();
      expect(test.postJsonModelId).not.toHaveBeenCalled();
    } finally {
      releaseAuthorization();
      await pending;
    }
  });

  it('cancels an existing transport after the feature is disabled', async () => {
    let enabled = true;
    const finishPosts = new Map<string, () => void>();
    const abortedTransportKeys = new Set<string>();
    const exactKey = (candidate: Readonly<{
      machineId: string;
      connectionId: string;
      modelId: string;
    }>) => `${candidate.machineId}\0${candidate.connectionId}\0${candidate.modelId}`;
    const test = harness({
      isEnabled: () => enabled,
      post: ({ machineId, connectionId, body, signal }) => new Promise((resolve, reject) => {
        const key = exactKey({ machineId, connectionId, modelId: body.model });
        finishPosts.set(key, () => resolve({ ok: true as const, statusCode: 200 }));
        signal.addEventListener('abort', () => {
          abortedTransportKeys.add(key);
          reject(new ProviderModelLoadCancelledError());
        }, { once: true });
      }),
    });
    const pending = test.service.loadNow(request);
    const neighboringRequests = [
      { ...request, machineId: 'machine-b' },
      { ...request, connectionId: 'connection-b' },
      { ...request, modelId: 'model-b' },
    ];
    const neighboringLoads = neighboringRequests.map((candidate) => test.service.loadNow(candidate));
    await vi.waitFor(() => expect(test.postJsonModelId).toHaveBeenCalledTimes(4));

    try {
      enabled = false;
      await expect(test.service.cancelNow(request)).resolves.toEqual({
        status: 'cancelled',
        providerMayContinue: true,
      });
      await expect(pending).resolves.toEqual({
        status: 'cancelled',
        providerMayContinue: true,
      });
      expect(abortedTransportKeys).toEqual(new Set([exactKey(request)]));
      finishPosts.forEach((finish) => finish());
      await expect(Promise.all(neighboringLoads)).resolves.toEqual([
        { status: 'loaded', source: 'requested' },
        { status: 'loaded', source: 'requested' },
        { status: 'loaded', source: 'requested' },
      ]);
    } finally {
      finishPosts.forEach((finish) => finish());
      await Promise.all([pending, ...neighboringLoads]);
    }
  });

  it('settles cancellation without reauthorizing when a logical load is hung and its endpoint disappears', async () => {
    let authorizeCalls = 0;
    let releaseOriginal!: () => void;
    const originalAuthorization = new Promise<Readonly<{
      status: 'authorized';
      authorization: ProviderModelLoadAuthorization<Ticket, CredentialRef>;
    }>>((resolve) => {
      releaseOriginal = () => resolve({
        status: 'authorized',
        authorization: authorization(),
      });
    });
    const test = harness({
      authorize: async () => {
        authorizeCalls += 1;
        return authorizeCalls === 1
          ? originalAuthorization
          : { status: 'unavailable' as const };
      },
    });
    const pending = test.service.loadNow(request);
    await vi.waitFor(() => expect(authorizeCalls).toBe(1));

    try {
      await expect(test.service.cancelNow(request)).resolves.toEqual({
        status: 'cancelled',
        providerMayContinue: true,
      });
      await expect(pending).resolves.toEqual({
        status: 'cancelled',
        providerMayContinue: true,
      });
      expect(authorizeCalls).toBe(1);
      releaseOriginal();
      await Promise.resolve();
      expect(test.readCurrentModel).not.toHaveBeenCalled();
      expect(test.resolveCredential).not.toHaveBeenCalled();
      expect(test.postJsonModelId).not.toHaveBeenCalled();
    } finally {
      releaseOriginal();
      await pending;
    }
  });

  it('cancels the captured endpoint generation instead of reauthorizing a changed endpoint', async () => {
    let authorizeCalls = 0;
    let releasePost!: () => void;
    const test = harness({
      authorize: async () => {
        const endpointFingerprint = authorizeCalls === 0 ? 'endpoint-fingerprint-a' : 'endpoint-fingerprint-b';
        authorizeCalls += 1;
        return {
          status: 'authorized' as const,
          authorization: authorization({
            endpoint: {
              endpointTemplateId: 'management',
              endpointUrl: endpointFingerprint === 'endpoint-fingerprint-a'
                ? 'http://127.0.0.1:1234/'
                : 'http://127.0.0.1:5678/',
              endpointFingerprint,
              publicHeaders: {},
            },
          }),
        };
      },
      post: ({ signal }) => new Promise((resolve, reject) => {
        releasePost = () => resolve({ ok: true as const, statusCode: 200 });
        signal.addEventListener('abort', () => reject(new ProviderModelLoadCancelledError()), { once: true });
      }),
    });
    const pending = test.service.loadNow(request);
    await vi.waitFor(() => expect(test.postJsonModelId).toHaveBeenCalledTimes(1));
    expect(test.postJsonModelId).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl: 'http://127.0.0.1:1234/',
    }));

    try {
      await expect(test.service.cancelNow(request)).resolves.toEqual({
        status: 'cancelled',
        providerMayContinue: true,
      });
      expect(authorizeCalls).toBe(1);
      await expect(pending).resolves.toEqual({
        status: 'cancelled',
        providerMayContinue: true,
      });
    } finally {
      releasePost();
      await pending;
    }
  });

  it('cancels every pending authorization for one logical model identity', async () => {
    const pendingAuthorizations: Array<() => void> = [];
    let authorizeCalls = 0;
    const test = harness({
      authorize: async () => {
        authorizeCalls += 1;
        return await new Promise<Readonly<{
          status: 'authorized';
          authorization: ProviderModelLoadAuthorization<Ticket, CredentialRef>;
        }>>((resolve) => {
          pendingAuthorizations.push(() => resolve({
            status: 'authorized',
            authorization: authorization(),
          }));
        });
      },
    });
    const first = test.service.loadNow(request);
    const second = test.service.loadNow(request);
    await vi.waitFor(() => expect(pendingAuthorizations.length).toBe(2));

    try {
      await expect(test.service.cancelNow(request)).resolves.toEqual({
        status: 'cancelled',
        providerMayContinue: true,
      });
      await expect(Promise.all([first, second])).resolves.toEqual([
        { status: 'cancelled', providerMayContinue: true },
        { status: 'cancelled', providerMayContinue: true },
      ]);
      expect(test.readCurrentModel).not.toHaveBeenCalled();
      expect(test.postJsonModelId).not.toHaveBeenCalled();
    } finally {
      pendingAuthorizations.forEach((release) => release());
      await Promise.all([first, second]);
    }
  });

  it('isolates pre-authorization cancellation from a different exact model identity', async () => {
    const releases = new Map<string, () => void>();
    let modelACalls = 0;
    const test = harness({
      authorize: async (candidate) => {
        if (candidate.modelId === 'model-a') {
          modelACalls += 1;
          if (modelACalls > 1) {
            return { status: 'authorized', authorization: authorization() };
          }
        }
        return await new Promise<Readonly<{
          status: 'authorized';
          authorization: ProviderModelLoadAuthorization<Ticket, CredentialRef>;
        }>>((resolve) => {
          releases.set(candidate.modelId, () => resolve({
            status: 'authorized',
            authorization: authorization(),
          }));
        });
      },
    });
    const modelA = test.service.loadNow(request);
    const modelB = test.service.loadNow({ ...request, modelId: 'model-b' });
    await vi.waitFor(() => expect(releases.size).toBe(2));

    await test.service.cancelNow(request);
    releases.get('model-a')?.();
    releases.get('model-b')?.();

    await expect(modelA).resolves.toEqual({
      status: 'cancelled',
      providerMayContinue: true,
    });
    await expect(modelB).resolves.toEqual({
      status: 'loaded',
      source: 'requested',
    });
    expect(test.postJsonModelId).toHaveBeenCalledTimes(1);
    expect(test.postJsonModelId).toHaveBeenCalledWith(expect.objectContaining({
      body: { model: 'model-b' },
    }));
  });

  it.each(['error', 'unavailable', 'throw'] as const)(
    'cleans pending authorization custody after an %s outcome',
    async (outcome) => {
      let calls = 0;
      const refusal = createProviderErrorV1('provider_connection_disabled', {
        connectionId: request.connectionId,
        machineId: request.machineId,
      });
      const test = harness({
        authorize: async () => {
          calls += 1;
          if (calls > 1) {
            return { status: 'authorized', authorization: authorization() };
          }
          if (outcome === 'throw') throw new Error('authorization boundary failed');
          return outcome === 'error'
            ? { status: 'error', error: refusal }
            : { status: 'unavailable' };
        },
      });

      if (outcome === 'throw') {
        await expect(test.service.loadNow(request)).rejects.toThrow(
          'authorization boundary failed',
        );
      } else if (outcome === 'error') {
        await expect(test.service.loadNow(request)).resolves.toEqual({
          status: 'error',
          error: refusal,
        });
      } else {
        await expect(test.service.loadNow(request)).resolves.toEqual({
          status: 'not_supported',
          reason: 'descriptor_absent',
        });
      }

      await expect(test.service.loadNow(request)).resolves.toEqual({
        status: 'loaded',
        source: 'requested',
      });
      expect(test.postJsonModelId).toHaveBeenCalledTimes(1);
    },
  );

  it('aborts a newly-created single-flight when its first subscriber is already cancelled', async () => {
    const controller = new AbortController();
    const test = harness({
      authorize: () => {
        controller.abort();
        return Promise.resolve({ status: 'authorized', authorization: authorization() });
      },
    });
    await expect(test.service.loadNow({ ...request, signal: controller.signal })).resolves.toEqual({
      status: 'cancelled', providerMayContinue: true,
    });
    await Promise.resolve();
    expect(test.readCurrentModel).not.toHaveBeenCalled();
    expect(test.resolveCredential).not.toHaveBeenCalled();
    expect(test.postJsonModelId).not.toHaveBeenCalled();
  });

  it('lets one cancelled subscriber detach without aborting a shared explicit load', async () => {
    let release!: () => void;
    const test = harness({
      post: () => new Promise((resolve) => { release = () => resolve({ ok: true, statusCode: 200 }); }),
    });
    const controller = new AbortController();
    const cancelled = test.service.loadNow({ ...request, signal: controller.signal });
    const continuing = test.service.loadNow(request);
    await vi.waitFor(() => expect(test.postJsonModelId).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(cancelled).resolves.toEqual({ status: 'cancelled', providerMayContinue: true });
    release();
    await expect(continuing).resolves.toEqual({ status: 'loaded', source: 'requested' });
  });

  it('starts a fresh single-flight instead of joining an abandoned aborted entry', async () => {
    const releases: Array<() => void> = [];
    const test = harness({
      post: () => new Promise((resolve) => {
        releases.push(() => resolve({ ok: true, statusCode: 200 }));
      }),
    });
    const controller = new AbortController();
    const abandoned = test.service.loadNow({ ...request, signal: controller.signal });
    await vi.waitFor(() => expect(test.postJsonModelId).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(abandoned).resolves.toEqual({ status: 'cancelled', providerMayContinue: true });

    const retry = test.service.loadNow(request);
    await vi.waitFor(() => expect(test.postJsonModelId).toHaveBeenCalledTimes(2));
    releases[1]!();
    await expect(retry).resolves.toEqual({ status: 'loaded', source: 'requested' });
    releases[0]!();
  });
});
