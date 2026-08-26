import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  createProviderErrorV1,
  createProviderObservationAuthorizationFingerprintV1,
  type ProviderCatalogProbeV1,
} from '@happier-dev/protocol';

import { createProviderRuntimeStateStore } from '../runtimeState';
import type { ProviderProbeAuthorizationPort } from './authorization';
import { createProviderProbeHttpClient, type ProviderProbeTransport } from './client';
import {
  createProviderCatalogRefreshFingerprint,
  createProviderCatalogService,
  type ProviderManagedCatalogSource,
} from './catalog';

const machineId = 'machine-a';
const connectionId = 'connection-a';
const observationAuthorizationFingerprint = createProviderObservationAuthorizationFingerprintV1({
  selectedSecretBindingId: null,
  selectedSecretRecordFingerprint: null,
  credential: null,
});

function credentialAuthorizationFingerprint(record: string) {
  return createProviderObservationAuthorizationFingerprintV1({
    selectedSecretBindingId: 'secret-a',
    selectedSecretRecordFingerprint: `saved-secret-record:v1:${record}`,
    credential: {
      selectedProtocol: 'openai-responses',
      selectedUse: 'probe',
      transport: {
        id: 'catalog-key',
        protocols: ['openai-responses'],
        uses: ['probe'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
      },
    },
  });
}

function authPort(options: Readonly<{ failCommit?: boolean; isCurrent?: () => boolean }> = {}): ProviderProbeAuthorizationPort<{ id: number }, never> {
  let revalidations = 0;
  return {
    authorize: async () => ({
      ok: true,
      ticket: { id: 1 },
      observationAuthorizationFingerprint,
      credentialRef: null,
    }),
    revalidate: async () => {
      revalidations += 1;
      return (options.failCommit && revalidations >= 3) || options.isCurrent?.() === false
        ? { ok: false, error: createProviderErrorV1('provider_authorization_changed') }
        : { ok: true };
    },
    authorizeDestination: async () => ({ ok: true }),
    resolveCredential: async (_reference: never) => {
      throw new Error('no credential expected');
    },
  };
}

async function store() {
  return createProviderRuntimeStateStore({
    happyHomeDir: await mkdtemp(join(tmpdir(), 'happier-provider-probe-')),
    machineId,
  });
}

const endpoints = [{
  endpointTemplateId: 'openai',
  protocol: 'openai-responses' as const,
  normalizedUrl: 'https://models.example/v1',
  publicHeaders: {},
}];

const managedSource = {
  implementationIdentity: {
    pluginId: 'happier.provider.cliproxyapi',
    localId: 'cliproxyapi',
  },
  managedRuntime: {
    kind: 'managed',
    dependencies: [],
    endpointTemplateIds: ['cliproxyapi-openai-responses'],
    connectedAccounts: [],
    requestAuthUses: [],
  },
  purposeBindings: { v: 1, bindings: [] },
  endpointTemplateId: 'cliproxyapi-openai-responses',
  protocol: 'openai-responses',
  sourceRegistryVersion: 'cliproxyapi-sdk:v7.2.95',
  publicHeaders: {},
} satisfies ProviderManagedCatalogSource;

describe('provider catalog service', () => {
  it('does not resolve a credential when fresh dispatch DNS is unsafe', async () => {
    const resolveCredential = vi.fn(async () => ({
      ok: true as const,
      lease: {
        credential: { kind: 'httpHeader' as const, name: 'authorization', value: 'Bearer secret-value' },
        redact: (value: string) => value,
        close: vi.fn(),
      },
    }));
    const authorizeDestination = vi.fn(async () => ({ ok: true as const }));
    const transport = vi.fn<ProviderProbeTransport>();
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['64:ff9b:1:a9fe:a9:fe00::'],
        transport,
      }),
      authorization: {
        ...authPort(),
        authorize: async () => ({
          ok: true as const,
          ticket: { id: 1 },
          observationAuthorizationFingerprint,
          credentialRef: { id: 'secret-a' },
        }),
        authorizeDestination,
        resolveCredential,
      },
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'must-not-be-used',
    });

    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unreachable' } });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(authorizeDestination).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns the stable credential-resolution refusal without dispatching a provider request', async () => {
    const transport = vi.fn<ProviderProbeTransport>();
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['93.184.216.34'], transport }),
      authorization: {
        ...authPort(),
        authorize: async () => ({
          ok: true as const,
          ticket: { id: 1 },
          observationAuthorizationFingerprint,
          credentialRef: { id: 'secret-a' },
        }),
        resolveCredential: async () => ({
          ok: false as const,
          error: createProviderErrorV1('provider_authorization_changed', { connectionId, machineId }),
        }),
      },
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'must-not-be-used',
    });

    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    expect(transport).not.toHaveBeenCalled();
    expect((await runtimeStore.read()).endpointHealth).toEqual([]);
  });

  it('keeps a request-scoped credential redaction lease alive through transport and closes it exactly once', async () => {
    const close = vi.fn();
    const redact = vi.fn((value: string) => value.replaceAll('secret-value', '[REDACTED]'));
    let leaseClosedDuringTransport = false;
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async (request) => {
          leaseClosedDuringTransport = close.mock.calls.length > 0;
          expect(request.headers.authorization).toBe('Bearer secret-value');
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from('{"data":[{"id":"model-a"}]}'),
          };
        },
      }),
      authorization: {
        ...authPort(),
        authorize: async () => ({
          ok: true as const,
          ticket: { id: 1 },
          observationAuthorizationFingerprint,
          credentialRef: { id: 'secret-a' },
        }),
        resolveCredential: async () => ({
          ok: true as const,
          lease: {
            credential: { kind: 'httpHeader' as const, name: 'authorization', value: 'Bearer secret-value' },
            redact,
            close,
          },
        }),
      },
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'observation-a',
    });

    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
    })).resolves.toMatchObject({ status: 'success' });
    expect(leaseClosedDuringTransport).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not materialize a credential when authorization changes while publishing checking activity', async () => {
    const close = vi.fn();
    const transport = vi.fn<ProviderProbeTransport>();
    let revalidations = 0;
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport,
      }),
      authorization: {
        authorize: async () => ({
          ok: true as const,
          ticket: { id: 1 },
          observationAuthorizationFingerprint,
          credentialRef: { id: 'secret-a' },
        }),
        revalidate: async () => (++revalidations === 1
          ? { ok: true as const }
          : { ok: false as const, error: createProviderErrorV1('provider_authorization_changed') }),
        authorizeDestination: async () => ({ ok: true as const }),
        resolveCredential: async () => ({
          ok: true as const,
          lease: {
            credential: { kind: 'httpHeader' as const, name: 'authorization', value: 'Bearer secret-value' },
            redact: (value: string) => value.replaceAll('secret-value', '[REDACTED]'),
            close,
          },
        }),
      },
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'must-not-be-used',
    });

    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    expect(close).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses ordered first-success fallback and atomically commits catalog, health, and load generation', async () => {
    const transport = vi.fn<ProviderProbeTransport>()
      .mockResolvedValueOnce({ status: 503, headers: {}, body: Buffer.alloc(0) })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"data":[{"id":"model-a"}]}'),
      });
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['93.184.216.34'], transport }),
      authorization: authPort(),
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'observation-a',
    });
    const probes: readonly ProviderCatalogProbeV1[] = [
      { endpointTemplateId: 'openai', path: '/first', parser: 'openai-models' },
      { endpointTemplateId: 'openai', path: '/second', parser: 'openai-models' },
    ];
    await expect(service.refresh({ connectionId, machineId, endpoints, probes }))
      .resolves.toMatchObject({ status: 'success', models: [{ id: 'model-a' }], requestFingerprint: expect.stringContaining('probe-request:v1:') });
    expect(transport).toHaveBeenCalledTimes(2);
    const state = await runtimeStore.read();
    expect(state.catalogs).toHaveLength(1);
    expect(state.catalogs[0]!.state).toMatchObject({
      catalogObservationId: 'observation-a',
      snapshot: { models: [{ id: 'model-a' }], stale: false, observedAt: 10_000 },
    });
    expect(state.endpointHealth.some((row) => row.state.status === 'available')).toBe(true);
  });

  it('uses the bounded command fallback only after every HTTP probe fails without marking endpoint health available', async () => {
    const transport = vi.fn<ProviderProbeTransport>()
      .mockResolvedValue({ status: 503, headers: {}, body: Buffer.alloc(0) });
    const commandFallback = vi.fn(async () => ({
      status: 'success' as const,
      models: [{ id: 'local-model', name: 'local-model' }],
    }));
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['127.0.0.1'], transport }),
      authorization: authPort(),
      runtimeStore,
      localCatalogFallback: { run: commandFallback },
      now: () => 10_000,
      createObservationId: () => 'observation-command',
    });
    const probes: readonly ProviderCatalogProbeV1[] = [
      { endpointTemplateId: 'openai', path: '/first', parser: 'openai-models' },
      { endpointTemplateId: 'openai', path: '/second', parser: 'openai-models' },
    ];
    const catalogFallback = {
      endpointTemplateId: 'openai', lookupNames: ['ollama'], fixedArgs: ['list'],
      parser: 'ollama-list-table' as const, endpointEnvName: 'OLLAMA_HOST',
    };

    await expect(service.refresh({ connectionId, machineId, endpoints, probes, catalogFallback }))
      .resolves.toMatchObject({ status: 'success', models: [{ id: 'local-model' }] });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(commandFallback).toHaveBeenCalledWith({
      descriptor: catalogFallback,
      endpointUrl: 'https://models.example/v1',
    });
    const state = await runtimeStore.read();
    expect(state.catalogs[0]?.state).toMatchObject({
      catalogObservationId: 'observation-command',
      snapshot: { models: [{ id: 'local-model', name: 'local-model' }], stale: false },
    });
    expect(state.endpointHealth).toHaveLength(2);
    expect(state.endpointHealth.every((row) => row.state.status !== 'available')).toBe(true);
  });

  it('never invokes the command catalog fallback for a health-only refresh', async () => {
    const commandFallback = vi.fn(async () => ({ status: 'success' as const, models: [{ id: 'wrong', name: 'wrong' }] }));
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport: async () => ({ status: 503, headers: {}, body: Buffer.alloc(0) }),
      }),
      authorization: authPort(), runtimeStore,
      localCatalogFallback: { run: commandFallback },
      now: () => 10_000, createObservationId: () => 'unused',
    });
    await expect(service.refresh({
      connectionId, machineId, endpoints, mode: 'health',
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
      catalogFallback: {
        endpointTemplateId: 'openai', lookupNames: ['ollama'], fixedArgs: ['list'],
        parser: 'ollama-list-table', endpointEnvName: 'OLLAMA_HOST',
      },
    })).resolves.toMatchObject({ status: 'error' });
    expect(commandFallback).not.toHaveBeenCalled();
  });

  it('discards a successful response when the authorization ticket changes before commit', async () => {
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"data":[{"id":"model-a"}]}'),
        }),
      }),
      authorization: authPort({ failCommit: true }),
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'observation-a',
    });
    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    const state = await runtimeStore.read();
    expect(state.catalogs).toEqual([]);
    expect(state.endpointHealth).toEqual([]);
  });

  it('revalidates inside the serialized store update immediately before commit', async () => {
    const runtimeStore = await store();
    let releaseQueuedWrite!: () => void;
    const queuedWriteGate = new Promise<void>((resolve) => { releaseQueuedWrite = resolve; });
    const queuedWrite = runtimeStore.update(async (state) => {
      await queuedWriteGate;
      return state;
    });
    let current = true;
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"data":[{"id":"model-a"}]}'),
        }),
      }),
      authorization: authPort({ isCurrent: () => current }),
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'observation-a',
    });
    const refresh = service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
    });
    await vi.waitFor(() => expect(current).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = false;
    releaseQueuedWrite();
    await queuedWrite;

    await expect(refresh).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    const state = await runtimeStore.read();
    expect(state.catalogs).toEqual([]);
    expect(state.endpointHealth).toEqual([]);
  });

  it('does not publish consumer-derived retry timing for scheduler-owned rate-limit admission', async () => {
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        now: () => 10_000,
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async () => ({
          status: 429,
          headers: { 'retry-after': '120' },
          body: Buffer.alloc(0),
        }),
      }),
      authorization: authPort(),
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'observation-a',
    });

    await service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
    });
    const state = await runtimeStore.read();
    expect(state.endpointHealth[0]?.state).toMatchObject({ status: 'rate_limited', observedAt: 10_000 });
    expect(state.endpointHealth[0]?.state).not.toHaveProperty('retryAt');
  });

  it('does not persist a settled failure when the caller cancels', async () => {
    const runtimeStore = await store();
    const controller = new AbortController();
    controller.abort();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async () => { throw new Error('must not dispatch'); },
      }),
      authorization: authPort(),
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'observation-a',
    });

    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'ProviderProbeCancelledError' });
    const state = await runtimeStore.read();
    expect(state.catalogs).toEqual([]);
    expect(state.endpointHealth).toEqual([]);
  });

  it('marks the last successful fallback snapshot stale even when later probes use different authorization provenance', async () => {
    const firstFingerprint = credentialAuthorizationFingerprint('first');
    const secondFingerprint = credentialAuthorizationFingerprint('second');
    const runtimeStore = await store();
    const probes: readonly ProviderCatalogProbeV1[] = [
      { endpointTemplateId: 'openai', path: '/first', parser: 'openai-models' },
      { endpointTemplateId: 'openai', path: '/second', parser: 'openai-models' },
    ];
    const baseAuthorization = authPort();
    const firstService = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"data":[{"id":"model-a"}]}'),
        }),
      }),
      authorization: {
        ...baseAuthorization,
        authorize: async () => ({ ok: true, ticket: { id: 1 }, observationAuthorizationFingerprint: firstFingerprint, credentialRef: null }),
      },
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'observation-a',
    });
    await firstService.refresh({ connectionId, machineId, endpoints, probes });

    let authorizationCall = 0;
    const failedService = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async () => ({ status: 503, headers: {}, body: Buffer.alloc(0) }),
      }),
      authorization: {
        ...baseAuthorization,
        authorize: async () => ({
          ok: true,
          ticket: { id: ++authorizationCall },
          observationAuthorizationFingerprint: authorizationCall === 1 ? firstFingerprint : secondFingerprint,
          credentialRef: null,
        }),
      },
      runtimeStore,
      now: () => 20_000,
      createObservationId: () => 'must-not-be-used',
    });
    await failedService.refresh({ connectionId, machineId, endpoints, probes });

    const state = await runtimeStore.read();
    expect(state.catalogs).toHaveLength(1);
    expect(state.catalogs[0]?.state.snapshot).toMatchObject({ stale: true, staleAt: 20_000 });
  });

  it('refuses manual-only catalogs without authorizing or issuing a guessed request', async () => {
    const authorize = vi.fn();
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async () => { throw new Error('must not request'); },
      }),
      authorization: { ...authPort(), authorize },
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'observation-a',
    });
    await expect(service.refresh({ connectionId, machineId, endpoints, probes: [] }))
      .resolves.toEqual({ status: 'not_supported' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('commits availability health without inventing a catalog observation', async () => {
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"data":[]}'),
        }),
      }),
      authorization: authPort(),
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'must-not-be-used',
    });
    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
      mode: 'health',
    })).resolves.toMatchObject({ status: 'success' });
    const state = await runtimeStore.read();
    expect(state.endpointHealth).toHaveLength(1);
    expect(state.catalogs).toEqual([]);
  });

  it('keeps another process’s newer health row when clearing its own transient checking record', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-probe-'));
    const runtimeStore = createProviderRuntimeStateStore({ happyHomeDir, machineId });
    const otherProcessStore = createProviderRuntimeStateStore({ happyHomeDir, machineId });
    const controller = new AbortController();
    let transportStarted!: () => void;
    const started = new Promise<void>((resolve) => { transportStarted = resolve; });
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async (request) => {
          transportStarted();
          await new Promise<void>((resolve) => {
            request.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('transport must not complete after cancellation');
        },
      }),
      authorization: authPort(),
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'observation-a',
    });
    const refresh = service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
      signal: controller.signal,
    });
    await started;

    // A second daemon/CLI process commits a real observation for the exact same
    // semantic key while this probe is still in flight.
    const transient = await runtimeStore.read();
    const endpointKey = transient.endpointHealth[0]!.key;
    await otherProcessStore.update((state) => ({
      ...state,
      endpointHealth: [{
        key: endpointKey,
        state: { status: 'available' as const, activity: 'idle' as const, observedAt: 9_500 },
        lastAccessedAt: 9_500,
      }],
    }));

    controller.abort();
    await expect(refresh).rejects.toBeTruthy();

    // Read through a fresh store so the assertion observes the durable file rather
    // than either writer's in-memory copy.
    const settled = await createProviderRuntimeStateStore({ happyHomeDir, machineId }).read();
    expect(settled.endpointHealth).toHaveLength(1);
    expect(settled.endpointHealth[0]?.state).toMatchObject({ status: 'available', observedAt: 9_500 });
  });

  it('publishes transient checking activity without destroying the prior settled result', async () => {
    const runtimeStore = await store();
    let releaseTransport!: () => void;
    const transportGate = new Promise<void>((resolve) => { releaseTransport = resolve; });
    let transportStarted!: () => void;
    const started = new Promise<void>((resolve) => { transportStarted = resolve; });
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async () => {
          transportStarted();
          await transportGate;
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from('{"data":[]}'),
          };
        },
      }),
      authorization: authPort(),
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'observation-a',
    });
    const refresh = service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
    });
    await started;

    const checking = await runtimeStore.read();
    expect(checking.endpointHealth[0]?.state).toEqual({ status: 'not_checked', activity: 'checking' });

    releaseTransport();
    await refresh;
    const settled = await runtimeStore.read();
    expect(settled.endpointHealth[0]?.state).toEqual({ status: 'available', activity: 'idle', observedAt: 10_000 });
  });

  it('uses one authorized bounded managed runtime and commits no transient endpoint health', async () => {
    const close = vi.fn(async () => {});
    const managedRequest = vi.fn(async (request: Readonly<{
      pathAndQuery: string;
      headers: Readonly<Record<string, string>>;
      timeoutMs: number;
    }>) => {
      // The probe reaches the supervised service through the exact handle, so
      // it hands over a relative path and never a second authenticated URL.
      expect(request.pathAndQuery).toBe('/v1/models');
      expect(Object.keys(request.headers).map((name) => name.toLowerCase()))
        .not.toContain('authorization');
      expect(request.timeoutMs).toBeLessThanOrEqual(
        PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
      );
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new Response(
          '{"object":"list","data":[{"id":"gpt-5-codex","object":"model"}]}',
        ).body,
      };
    });
    const launch = vi.fn(async () => ({
      ok: true as const,
      endpointUrl: 'http://127.0.0.1:45123/v1',
      access: { request: managedRequest },
      isCurrent: () => true,
      close,
    }));
    const authorize = vi.fn(authPort().authorize);
    const transport = vi.fn<ProviderProbeTransport>(async () => {
      throw new Error('managed catalog must not use the raw HTTP transport');
    });
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport,
      }),
      authorization: { ...authPort(), authorize },
      managedCatalogRuntime: { launch },
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'managed-observation',
    });

    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints: [],
      probes: [{
        endpointTemplateId: 'cliproxyapi-openai-responses',
        path: '/v1/models',
        parser: 'openai-models',
      }],
      managedSource,
    })).resolves.toMatchObject({
      status: 'success',
      models: [{ id: 'gpt-5-codex' }],
    });
    expect(authorize).toHaveBeenCalledBefore(launch);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(managedRequest).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    const state = await runtimeStore.read();
    expect(state.catalogs).toHaveLength(1);
    expect(state.endpointHealth).toEqual([]);
  });

  it('runs ordered managed probes and the declared fallback through one launch-local service', async () => {
    const close = vi.fn(async () => {});
    const managedRequest = vi.fn(async (request: Readonly<{
      pathAndQuery: string;
      headers: Readonly<Record<string, string>>;
      timeoutMs: number;
    }>) => ({
      status: 503,
      headers: { 'content-type': 'application/json' },
      body: new Response('{"error":"temporarily unavailable"}').body,
    }));
    const launch = vi.fn(async () => ({
      ok: true as const,
      endpointUrl: 'http://127.0.0.1:45123/v1',
      access: { request: managedRequest },
      isCurrent: () => true,
      close,
    }));
    const fallback = vi.fn(async () => ({
      status: 'success' as const,
      models: [{ id: 'local-model', name: 'Local model' }],
    }));
    const transport = vi.fn<ProviderProbeTransport>(async () => {
      throw new Error('managed catalog must not use the raw HTTP transport');
    });
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport,
      }),
      authorization: authPort(),
      managedCatalogRuntime: { launch },
      localCatalogFallback: { run: fallback },
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'managed-fallback-observation',
    });
    const probes: readonly ProviderCatalogProbeV1[] = [
      {
        endpointTemplateId: 'cliproxyapi-openai-responses',
        path: '/v1/models-primary',
        parser: 'openai-models',
      },
      {
        endpointTemplateId: 'cliproxyapi-openai-responses',
        path: '/v1/models-secondary',
        parser: 'openai-models',
      },
    ];
    const catalogFallback = {
      endpointTemplateId: 'cliproxyapi-openai-responses',
      lookupNames: ['gateway'],
      fixedArgs: ['models'],
      parser: 'ollama-list-table' as const,
      endpointEnvName: 'GATEWAY_HOST',
    };

    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints: [],
      probes,
      catalogFallback,
      managedSource,
    })).resolves.toMatchObject({
      status: 'success',
      models: [{ id: 'local-model', name: 'Local model' }],
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(managedRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      pathAndQuery: '/v1/models-primary',
    }));
    expect(managedRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({
      pathAndQuery: '/v1/models-secondary',
    }));
    expect(fallback).toHaveBeenCalledWith({
      descriptor: catalogFallback,
      endpointUrl: 'http://127.0.0.1:45123/v1',
    });
    expect(transport).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('discards a managed result when source authority changes and still closes the runtime', async () => {
    const close = vi.fn(async () => {});
    let revalidations = 0;
    const runtimeStore = await store();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport: async () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"object":"list","data":[{"id":"gpt-5-codex","object":"model"}]}'),
        }),
      }),
      authorization: {
        ...authPort(),
        revalidate: async () => (++revalidations < 3
          ? { ok: true as const }
          : {
              ok: false as const,
              error: createProviderErrorV1('provider_authorization_changed', { connectionId, machineId }),
            }),
      },
      managedCatalogRuntime: {
        launch: async () => ({
          ok: true as const,
          endpointUrl: 'http://127.0.0.1:45123/v1',
          access: {
            request: async () => ({
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: new Response(
                '{"object":"list","data":[{"id":"gpt-5-codex","object":"model"}]}',
              ).body,
            }),
          },
          isCurrent: () => true,
          close,
        }),
      },
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'must-not-commit',
    });

    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints: [],
      probes: [{
        endpointTemplateId: 'cliproxyapi-openai-responses',
        path: '/v1/models',
        parser: 'openai-models',
      }],
      managedSource,
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_authorization_changed' },
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect((await runtimeStore.read()).catalogs).toEqual([]);
  });

  it('refuses a retired contributed catalog format instead of authoring a current observation', async () => {
    const runtimeStore = await store();
    let generationIsCurrent = true;
    const parse = vi.fn(() => ({ models: [{ id: 'acme/sonnet' }], loadStates: [] }));
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport: async () => {
          // The contributing plugin is replaced while this probe is in flight,
          // exactly as a reload does to queued or running probe work.
          generationIsCurrent = false;
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from('{"catalog":[]}'),
          };
        },
      }),
      authorization: authPort(),
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'must-not-commit',
    });

    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/catalog', parser: 'acme-catalog-v3' }],
      contributedCatalogParsers: {
        parsersByFormat: { 'acme-catalog-v3': parse },
        isCurrent: () => generationIsCurrent,
      },
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_contribution_unavailable' },
    });
    expect((await runtimeStore.read()).catalogs).toEqual([]);
    expect((await runtimeStore.read()).endpointHealth).toEqual([]);
  });

  it('never dispatches a probe for a contributed format whose generation is already retired', async () => {
    const runtimeStore = await store();
    const transport = vi.fn<ProviderProbeTransport>();
    const service = createProviderCatalogService({
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['93.184.216.34'],
        transport,
      }),
      authorization: authPort(),
      runtimeStore,
      now: () => 10_000,
      createObservationId: () => 'must-not-commit',
    });

    await expect(service.refresh({
      connectionId,
      machineId,
      endpoints,
      probes: [{ endpointTemplateId: 'openai', path: '/catalog', parser: 'acme-catalog-v3' }],
      contributedCatalogParsers: {
        parsersByFormat: { 'acme-catalog-v3': () => ({ models: [], loadStates: [] }) },
        isCurrent: () => false,
      },
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_contribution_unavailable' },
    });
    expect(transport).not.toHaveBeenCalled();
    expect((await runtimeStore.read()).endpointHealth).toEqual([]);
  });

});

describe('managed provider catalog refresh fingerprint', () => {
  const managedProbe: ProviderCatalogProbeV1 = {
    endpointTemplateId: managedSource.endpointTemplateId,
    path: '/v1/models',
    parser: 'openai-models',
  };

  it('fingerprints ordered managed probes and fallback without a transient endpoint', () => {
    const probes = [
      managedProbe,
      { ...managedProbe, path: '/v1/models-secondary' },
    ] as const;
    const catalogFallback = {
      endpointTemplateId: managedSource.endpointTemplateId,
      lookupNames: ['gateway'],
      fixedArgs: ['models'],
      parser: 'ollama-list-table' as const,
      endpointEnvName: 'GATEWAY_HOST',
    };
    const fingerprint = createProviderCatalogRefreshFingerprint({
      endpoints,
      probes,
      catalogFallback,
      managedSource,
    });
    expect(fingerprint).toEqual(expect.any(String));
    expect(createProviderCatalogRefreshFingerprint({
      endpoints,
      probes,
      catalogFallback: { ...catalogFallback, fixedArgs: ['alternate-models'] },
      managedSource,
    })).not.toBe(fingerprint);
    expect(createProviderCatalogRefreshFingerprint({
      endpoints,
      probes,
      catalogFallback,
      managedSource: { ...managedSource, sourceRegistryVersion: 'cliproxyapi-sdk:v7.2.96' },
    })).not.toBe(fingerprint);
  });
});
