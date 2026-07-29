import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
} from '@happier-dev/protocol';

import { resolveProviderConnectionForMachine } from '@/providers/registry';
import type {
  ResolvedFirstPartyManagedProviderFacet,
} from '@/providers/managed/types';

import {
  createProviderProbeHttpClient,
  type ProviderProbeTransportRequest,
} from './client';
import { createRuntimeProviderServices } from './runtimeServices';

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe('managed Provider catalog runtime composition', () => {
  it('single-flights one credential-free transient source through the canonical scheduler and store', async () => {
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
    const managedFacet: ResolvedFirstPartyManagedProviderFacet = {
      managedEndpoint: {
        localService: {
          id: 'cliproxyapi',
          launch: {
            kind: 'packaged-runtime-binary' as const,
            directorySegments: ['tools', 'unpacked'],
            executableBaseName: 'cliproxyapi-managed',
            privateConfigPathFlag: '--config',
          },
          launchMode: {
            kind: 'assignAndInject' as const,
            portPolicy: { kind: 'allocated' as const },
          },
          hostPolicy: { kind: 'loopback' as const },
          name: { strategy: 'fixed' as const, name: 'CLIProxyAPI' },
          healthCheck: { kind: 'http' as const, path: '/healthz' },
          restart: { kind: 'never' as const },
          cleanup: { staleAfterMs: 60_000 },
        },
        protocols: ['openai-responses' as const],
      },
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
          kind: 'httpHeaders' as const,
          origin: 'https://api.example.test',
          headerNames: ['authorization'],
        },
      }],
    };
    const managedRuntimeAdapter = {
      v: 1 as const,
      catalogSource: {
        kind: 'transientModelEndpoint' as const,
        contractVersion: 'happier.cliproxyapi-managed/v1',
        sdkVersion: 'v7.2.95',
      },
      prepare: async () => {
        throw new Error('not used by composition test');
      },
      resolveAgentEndpoint: () => 'http://127.0.0.1:45123/v1',
    };
    const contribution = {
      provenance: 'first_party' as const,
      source: { kind: 'bundled' as const },
      pluginId: 'happier.provider.cliproxyapi',
      identity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      definition,
      managed: managedFacet,
      managedRuntimeAdapter,
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
              service: managedFacet.connectedAccounts[0]!.service,
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
    let releaseTransport!: () => void;
    const transportGate = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    let signalTransportStarted!: () => void;
    const transportStarted = new Promise<void>((resolve) => {
      signalTransportStarted = resolve;
    });
    const close = vi.fn(async () => {});
    const launch = vi.fn(async (input) => {
      expect(input.request).toMatchObject({
        deployment: 'managedLocal',
        purposeBindings: {
          bindings: [{
            purpose: {
              consumer: contribution.identity,
              purpose: 'upstream',
            },
          }],
        },
      });
      return {
        ok: true as const,
        endpointUrl: 'http://127.0.0.1:45123/v1',
        downstreamBearer: 'probe-local-bearer',
        isCurrent: () => true,
        close,
      };
    });
    const transport = vi.fn(async (request: ProviderProbeTransportRequest) => {
      expect(request.headers.authorization).toBe('Bearer probe-local-bearer');
      signalTransportStarted();
      await transportGate;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          '{"object":"list","data":[{"id":"gpt-5-codex","object":"model"}]}',
        ),
      };
    });
    const services = createRuntimeProviderServices({
      machineId: 'machine-a',
      happyHomeDir,
      registry,
      featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: () => ({
        source: 'cache',
        settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        scopeKey: 'account-a',
      }),
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport,
      }),
      managedCatalogRuntime: { launch },
      resolveManagedPurposeBindingIntent: async ({ purpose, target }) => ({
        purpose,
        target,
      }),
      createObservationId: () => 'managed-observation',
    });
    const identity = { connectionId, machineId: 'machine-a' };

    const first = services.probe(identity);
    await transportStarted;
    const second = services.probe(identity);
    releaseTransport();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'success' }),
    ]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    const state = await services.runtimeStore.read();
    expect(state.catalogs).toHaveLength(1);
    expect(state.endpointHealth).toEqual([]);
  });
});
