import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceHandle,
  ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';
import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  resolveProviderManagedRuntimeDeclarationV1,
} from '@happier-dev/protocol';

import type { ResolvedManagedProviderRuntime } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveProviderConnectionForMachine } from '@/providers/registry';

import {
  createProviderProbeHttpClient,
} from './client';
import { createProviderManagedCatalogRuntimePort } from './managedRuntime';
import { createRuntimeProviderServices } from './runtimeServices';

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe('managed Provider catalog runtime composition', () => {
  it.each([
    ['bundled', 'first_party', { kind: 'bundled' }],
    ['development path', 'external', { kind: 'path' }],
    ['external package', 'external', { kind: 'package' }],
  ] as const)(
    'single-flights the exact public runtime for a %s declaration through the canonical scheduler and store',
    async (_label, provenance, source) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-managed-catalog-'));
    temporaryPaths.push(happyHomeDir);
    const connectionId = ProviderConnectionIdSchema.parse('pc_cliproxyapi');
    const contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
    const definition = ProviderContributionV1Schema.parse({
      v: 1,
      id: 'cliproxyapi',
      name: 'CLIProxyAPI',
      kind: 'aggregator',
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses',
        localUrlCandidates: ['http://127.0.0.1:8317/v1'],
        capabilities: {
          streaming: 'supported',
          toolRoundTrips: 'supported',
          statefulResponses: 'unknown',
          reasoningControls: 'supported',
        },
      }],
      catalog: {
        source: 'probe',
        manualModelPolicy: 'allowed',
        probes: [{
          endpointTemplateId: 'responses',
          path: '/v1/models',
          parser: 'openai-models',
        }],
      },
      managedRuntime: {
        kind: 'managed',
        endpointTemplateIds: ['responses'],
        connectedAccounts: [{
          purpose: 'upstream',
          service: {
            pluginId: 'happier.connected-account.example',
            localId: 'example',
          },
          required: true,
          materializationKinds: ['httpHeaders'],
        }],
        requestAuthUses: [{
          purpose: 'upstream',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
          },
        }],
      },
      discovery: {
        v: 1,
        listener: {
          executableBasenames: ['cliproxyapi-managed'],
          defaultPorts: [8317],
        },
        availabilityProbe: {
          endpointTemplateId: 'responses',
          path: '/v1/models',
          parser: 'openai-models',
        },
      },
    });
    if (!definition.managedRuntime) {
      throw new Error('Expected public managed Provider declaration');
    }
    const managedRuntime = resolveProviderManagedRuntimeDeclarationV1({
      implementationIdentity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      managedRuntime: definition.managedRuntime,
    });
    const contribution = {
      provenance,
      source,
      pluginId: 'happier.provider.cliproxyapi',
      identity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      definition,
    };
    const registry = {
      providersByContributionKey: new Map([[contributionKey, contribution]]),
    };
    const base = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: connectionId,
        source: { kind: 'contribution', contributionKey },
        deployment: { kind: 'managedLocal' },
        role: 'default',
        displayName: 'CLIProxyAPI',
        displayNameMode: 'automatic',
        purposeBindingDefaults: {
          upstream: {
            kind: 'account',
            account: {
              service: managedRuntime.connectedAccounts[0]!.service,
              accountId: 'account-a',
            },
          },
        },
        revision: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const initial = resolveProviderConnectionForMachine({
      connectionId,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: base },
      registry,
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (initial.status !== 'resolved') {
      throw new Error('Expected managed Provider connection');
    }
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      machineGrants: [{
        v: 1,
        machineId: 'machine-a',
        connectionId,
        endpointSetFingerprint: initial.record.endpointSetFingerprint,
        connectionSecurityFingerprint:
          initial.record.connectionSecurityFingerprint,
        confirmedAt: 1,
      }],
    });
    let currentSettings = settings;
    let invalidateAuthorizationDuringStart = false;
    let switchRuntimeDuringStart = false;
    let returnSuccessorRuntime = false;
    let releaseTransport!: () => void;
    const transportGate = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    let signalTransportStarted!: () => void;
    const transportStarted = new Promise<void>((resolve) => {
      signalTransportStarted = resolve;
    });
    const disposeService = vi.fn(async () => undefined);
    const serviceSnapshot = Object.freeze({
      id: 'cliproxyapi',
      state: 'healthy' as const,
      mode: 'spawn' as const,
      baseUrl: 'http://127.0.0.1:45123',
      startedAtMs: 10,
      lastHealthyAtMs: 11,
      diagnostics: Object.freeze([]),
      diagnosticsTruncated: false,
    });
    const service = Object.freeze({
      snapshot: () => serviceSnapshot,
      observe(listener: Parameters<ManagedServiceHandle['observe']>[0]) {
        listener(serviceSnapshot);
        return Object.freeze({ dispose() {} });
      },
      async waitUntilHealthy() { return serviceSnapshot; },
      async request() { throw new Error('Unexpected managed service request'); },
      async stop() { return Object.freeze({ status: 'stopped' as const }); },
      dispose: disposeService,
    }) satisfies ManagedServiceHandle;
    const start = vi.fn<ManagedProviderRuntime['start']>(async (request, _context) => {
      expect(request).toEqual({
        reason: 'catalogProbe',
        connectionId,
        connectionRevision: 0,
        endpointTemplateIds: ['responses'],
      });
      if (invalidateAuthorizationDuringStart) {
        currentSettings = ProviderSettingsV1Schema.parse({
          ...currentSettings,
          connections: currentSettings.connections.map((connection) => (
            connection.id === connectionId
              ? { ...connection, revision: 1, updatedAt: 2 }
              : connection
          )),
        });
      }
      if (switchRuntimeDuringStart) returnSuccessorRuntime = true;
      return Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'responses',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      });
    });
    const resolvedRuntime = Object.freeze({
      runtime: Object.freeze({ start }),
      activationGeneration: 'activation-7',
      immutableGenerationId: 'immutable-7',
      isCurrent: () => true,
    }) satisfies ResolvedManagedProviderRuntime;
    const successorStart = vi.fn<ManagedProviderRuntime['start']>();
    const successorRuntime = Object.freeze({
      runtime: Object.freeze({ start: successorStart }),
      activationGeneration: 'activation-8',
      immutableGenerationId: 'immutable-8',
      isCurrent: () => true,
    }) satisfies ResolvedManagedProviderRuntime;
    const acquireManagedProviderRuntime = vi.fn(async () => {
      if (returnSuccessorRuntime) {
        returnSuccessorRuntime = false;
        return successorRuntime;
      }
      return resolvedRuntime;
    });
    const connectedAccounts = Object.freeze({
      async getBinding() { return null; },
      async requestSelection() {
        throw new Error('selection is unavailable during managed Provider activation');
      },
      async materialize() { throw new Error('not used by catalog test'); },
      listAccounts: async () => {
          throw new Error('Connected Account listing is outside this fixture');
      },
      materializeListedAccount: async () => {
          throw new Error('Exact-listed Connected Account materialization is outside this fixture');
      },
      watch() { return Object.freeze({ dispose() {} }); },
    }) satisfies ConnectedAccountsService;
    const unavailable = async (): Promise<never> => {
      throw new Error('not used by catalog test');
    };
    const managedServices = Object.freeze({
      dependencies: Object.freeze({
        status: unavailable,
        ensure: unavailable,
        update: unavailable,
        remove: unavailable,
      }),
      supervise: unavailable,
    }) satisfies ManagedServices;
    const endpointAccessCleanup = vi.fn(async () => undefined);
    const invocationCleanup = vi.fn();
    const createManagedProviderRuntimeInvocationServices: NonNullable<
      ResolvedExecutablePluginRuntimeRegistry[
        'createManagedProviderRuntimeInvocationServices'
      ]
    > = vi.fn(async (input) => {
      expect(input.identity).toEqual(contribution.identity);
      expect(input.operationClaim).toBeUndefined();
      expect(input.purposeBindings).toEqual({
        v: 1,
        bindings: [expect.objectContaining({
          purpose: {
            consumer: contribution.identity,
            purpose: 'upstream',
          },
        })],
      });
      return Object.freeze({
        connectedAccounts,
        managedServices,
        projectEndpointAccess: async () => Object.freeze({
          access: Object.freeze({
            endpointUrl: (endpointTemplateId: string) => (
              endpointTemplateId === 'responses'
                ? 'http://127.0.0.1:45123/v1'
                : null
            ),
            request: async () => {
              signalTransportStarted();
              await transportGate;
              return Object.freeze({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: Object.freeze({ 'content-type': 'application/json' }),
                body: new Response(
                  '{"object":"list","data":[{"id":"gpt-5-codex","object":"model"}]}',
                ).body,
              });
            },
          }),
          isCurrent: () => true,
          cleanup: endpointAccessCleanup,
        }),
        bootstrap: Object.freeze({
          identity: contribution.identity,
          activationGeneration: resolvedRuntime.activationGeneration,
          immutableGenerationId: resolvedRuntime.immutableGenerationId,
          manifestAuthority: 'bundled_first_party',
          operationClaimId: 'managed-provider-bounded:catalog-test',
          requestAuth: null,
        }),
        cleanup: invocationCleanup,
      });
    });
    // Boundary fixture exposes only the two registry capabilities this real
    // catalog operation consumes; every internal launch owner remains real.
    const runtimeRegistry = {
      acquireManagedProviderRuntime,
      createManagedProviderRuntimeInvocationServices,
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const releaseRegistryLease = vi.fn(async () => undefined);
    const managedCatalogRuntime = createProviderManagedCatalogRuntimePort({
      acquireRegistryLease: async () => Object.freeze({
        registry: runtimeRegistry,
        source: 'active' as const,
        durableRevision: -1,
        release: releaseRegistryLease,
      }),
    });
    const transport = vi.fn(async () => {
      throw new Error('managed catalog must use opaque endpoint access');
    });
    const services = createRuntimeProviderServices({
      machineId: 'machine-a',
      happyHomeDir,
      registry,
      featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: () => ({
        source: 'cache',
        settings: AccountSettingsSchema.parse({
          providerSettingsV1: currentSettings,
        }),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        scopeKey: 'account-a',
      }),
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport,
      }),
      managedCatalogRuntime,
      resolveManagedPurposeBindingIntent: async ({ purpose, target }) => ({
        purpose,
        target,
      }),
      createObservationId: () => 'managed-observation',
    });
    const identity = { connectionId, machineId: 'machine-a' };

    const first = services.probe(identity);
    await expect(Promise.race([
      transportStarted.then(() => 'started' as const),
      first.then(() => 'completed' as const),
    ])).resolves.toBe('started');
    const second = services.probe(identity);
    releaseTransport();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'success' }),
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(acquireManagedProviderRuntime).toHaveBeenCalledTimes(2);
    expect(createManagedProviderRuntimeInvocationServices).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
    expect(endpointAccessCleanup).toHaveBeenCalledTimes(1);
    expect(invocationCleanup).toHaveBeenCalledTimes(1);
    expect(releaseRegistryLease).toHaveBeenCalledTimes(1);
    expect(disposeService).toHaveBeenCalledTimes(1);

    switchRuntimeDuringStart = true;
    await expect(services.probe(identity)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_authorization_changed' },
    });
    switchRuntimeDuringStart = false;
    expect(start).toHaveBeenCalledTimes(2);
    expect(successorStart).not.toHaveBeenCalled();
    expect(acquireManagedProviderRuntime).toHaveBeenCalledTimes(4);
    expect(createManagedProviderRuntimeInvocationServices).toHaveBeenCalledTimes(2);
    expect(endpointAccessCleanup).toHaveBeenCalledTimes(1);
    expect(invocationCleanup).toHaveBeenCalledTimes(2);
    expect(releaseRegistryLease).toHaveBeenCalledTimes(2);
    expect(disposeService).toHaveBeenCalledTimes(2);

    invalidateAuthorizationDuringStart = true;
    await expect(services.probe(identity)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_authorization_changed' },
    });
    expect(start).toHaveBeenCalledTimes(3);
    expect(successorStart).not.toHaveBeenCalled();
    expect(acquireManagedProviderRuntime).toHaveBeenCalledTimes(6);
    expect(createManagedProviderRuntimeInvocationServices).toHaveBeenCalledTimes(3);
    expect(endpointAccessCleanup).toHaveBeenCalledTimes(1);
    expect(invocationCleanup).toHaveBeenCalledTimes(3);
    expect(releaseRegistryLease).toHaveBeenCalledTimes(3);
    expect(disposeService).toHaveBeenCalledTimes(3);
    const state = await services.runtimeStore.read();
    expect(state.catalogs).toHaveLength(1);
    expect(state.endpointHealth).toEqual([]);
    },
  );
});
