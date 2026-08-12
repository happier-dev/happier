import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderContributionV1Schema,
  ProviderRuntimeStateFileV1Schema,
  ProviderSettingsV1Schema,
  createProviderCatalogFingerprintV1,
  createProviderManagedProbeRequestFingerprintV1,
  createProviderObservationAuthorizationFingerprintV1,
} from '@happier-dev/protocol';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type {
  ResolveManagedProviderPurposeBindingIntent,
} from '@/providers/managed/resolvePurposeBindingSnapshot';
import type {
  ResolvedFirstPartyManagedProviderFacet,
} from '@/providers/managed/types';

import { resolveProviderConnectionForMachine } from '../registry';
import {
  resolveProviderRuntimeCatalogModel,
  selectProviderRuntimeCatalogSelectionObservation,
  selectProviderRuntimeCatalogModelObservation,
  selectProviderRuntimeCatalogModel,
} from './runtimeCatalog';

const currentAuthorization = createProviderObservationAuthorizationFingerprintV1({
  selectedSecretBindingId: null,
  selectedSecretRecordFingerprint: null,
  credential: null,
});

describe('provider spawn runtime catalog bridge', () => {
  it('selects a probe-only model only from an exact current machine/connection/catalog/authorization record', () => {
    const state = ProviderRuntimeStateFileV1Schema.parse({
      v: 1,
      machineId: 'machine-a',
      endpointHealth: [],
      catalogs: [
        {
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway',
            catalogFingerprint: 'catalog:v1:old',
            observationAuthorizationFingerprint: currentAuthorization,
          },
          state: {
            catalogObservationId: 'old',
            snapshot: { models: [{ id: 'wrong', name: 'Wrong' }], observedAt: 50, stale: false },
            staleProbeModels: [],
          },
          lastAccessedAt: 50,
        },
        {
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway',
            catalogFingerprint: 'catalog:v1:current',
            observationAuthorizationFingerprint: currentAuthorization,
          },
          state: {
            catalogObservationId: 'current',
            snapshot: {
              models: [{
                id: 'probe-only',
                name: 'Probe only',
                capabilities: {
                  toolRoundTrips: 'supported',
                  reasoningControls: 'unsupported',
                },
              }],
              observedAt: 20,
              stale: false,
            },
            staleProbeModels: [{ id: 'disappeared', name: 'Disappeared' }],
          },
          lastAccessedAt: 20,
        },
      ],
      installationChecks: [],
      modelLoadStates: [{
        key: {
          machineId: 'machine-a',
          connectionId: 'pc_gateway',
          catalogObservationId: 'current',
          modelId: 'probe-only',
        },
        loadState: 'unloaded',
        observedAt: 20,
        lastAccessedAt: 20,
      }],
    });

    expect(selectProviderRuntimeCatalogModelObservation({
      runtimeState: state,
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      catalogFingerprint: 'catalog:v1:current',
      currentObservationAuthorizationFingerprints: new Set([currentAuthorization]),
      modelId: 'probe-only',
    })).toEqual({
      model: {
        id: 'probe-only',
        name: 'Probe only',
        capabilities: {
          toolRoundTrips: 'supported',
          reasoningControls: 'unsupported',
        },
      },
      loadState: 'unloaded',
    });
    expect(selectProviderRuntimeCatalogModel({
      runtimeState: state,
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      catalogFingerprint: 'catalog:v1:current',
      currentObservationAuthorizationFingerprints: new Set([currentAuthorization]),
      modelId: 'probe-only',
    })).toEqual({
      id: 'probe-only',
      name: 'Probe only',
      capabilities: {
        toolRoundTrips: 'supported',
        reasoningControls: 'unsupported',
      },
    });
    expect(selectProviderRuntimeCatalogModel({
      runtimeState: state,
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      catalogFingerprint: 'catalog:v1:current',
      currentObservationAuthorizationFingerprints: new Set([currentAuthorization]),
      modelId: 'wrong',
    })).toBeNull();
    expect(selectProviderRuntimeCatalogSelectionObservation({
      runtimeState: state,
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      catalogFingerprint: 'catalog:v1:current',
      currentObservationAuthorizationFingerprints: new Set([currentAuthorization]),
      modelId: 'wrong',
    })).toEqual({ model: null, loadState: 'unknown' });
  });

  it('does not treat an aged model-load observation as current admission truth', () => {
    const state = ProviderRuntimeStateFileV1Schema.parse({
      v: 1,
      machineId: 'machine-a',
      endpointHealth: [],
      catalogs: [{
        key: {
          machineId: 'machine-a',
          connectionId: 'pc_gateway',
          catalogFingerprint: 'catalog:v1:current',
          observationAuthorizationFingerprint: currentAuthorization,
        },
        state: {
          catalogObservationId: 'aged',
          snapshot: {
            models: [{ id: 'probe-only', name: 'Probe only' }],
            observedAt: 20,
            stale: true,
            staleAt: 30,
          },
          staleProbeModels: [],
        },
        lastAccessedAt: 30,
      }],
      installationChecks: [],
      modelLoadStates: [{
        key: {
          machineId: 'machine-a',
          connectionId: 'pc_gateway',
          catalogObservationId: 'aged',
          modelId: 'probe-only',
        },
        loadState: 'unloaded',
        observedAt: 20,
        lastAccessedAt: 20,
      }],
    });

    expect(selectProviderRuntimeCatalogModelObservation({
      runtimeState: state,
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      catalogFingerprint: 'catalog:v1:current',
      currentObservationAuthorizationFingerprints: new Set([currentAuthorization]),
      modelId: 'probe-only',
    })).toMatchObject({
      model: { id: 'probe-only' },
      loadState: 'unknown',
    });
  });

  it('never resurrects a model from an older allowed authorization record', () => {
    const alternateAuthorization = `${currentAuthorization.slice(0, -1)}${currentAuthorization.endsWith('a') ? 'b' : 'a'}` as typeof currentAuthorization;
    const state = ProviderRuntimeStateFileV1Schema.parse({
      v: 1,
      machineId: 'machine-a',
      endpointHealth: [],
      catalogs: [
        {
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway',
            catalogFingerprint: 'catalog:v1:current',
            observationAuthorizationFingerprint: currentAuthorization,
          },
          state: {
            catalogObservationId: 'older',
            snapshot: { models: [{ id: 'gone', name: 'Gone' }], observedAt: 10, stale: false },
            staleProbeModels: [],
          },
          lastAccessedAt: 10,
        },
        {
          key: {
            machineId: 'machine-a', connectionId: 'pc_gateway',
            catalogFingerprint: 'catalog:v1:current',
            observationAuthorizationFingerprint: alternateAuthorization,
          },
          state: {
            catalogObservationId: 'newer',
            snapshot: { models: [{ id: 'current', name: 'Current' }], observedAt: 20, stale: false },
            staleProbeModels: [],
          },
          lastAccessedAt: 20,
        },
      ],
      installationChecks: [],
      modelLoadStates: [],
    });
    const lookup = (modelId: string) => selectProviderRuntimeCatalogModel({
      runtimeState: state,
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      catalogFingerprint: 'catalog:v1:current',
      currentObservationAuthorizationFingerprints: new Set([currentAuthorization, alternateAuthorization]),
      modelId,
    });

    expect(lookup('current')).toMatchObject({ id: 'current', name: 'Current' });
    expect(lookup('gone')).toBeNull();
  });

  it('uses an aged current observation but never promotes a disappeared model into launch authority', () => {
    const state = ProviderRuntimeStateFileV1Schema.parse({
      v: 1,
      machineId: 'machine-a',
      endpointHealth: [],
      catalogs: [{
        key: {
          machineId: 'machine-a', connectionId: 'pc_gateway',
          catalogFingerprint: 'catalog:v1:current',
          observationAuthorizationFingerprint: currentAuthorization,
        },
        state: {
          catalogObservationId: 'current',
          snapshot: { models: [{ id: 'current', name: 'Current' }], observedAt: 20, stale: true, staleAt: 30 },
          staleProbeModels: [{ id: 'disappeared', name: 'Disappeared' }],
        },
        lastAccessedAt: 30,
      }],
      installationChecks: [],
      modelLoadStates: [],
    });

    expect(selectProviderRuntimeCatalogModel({
      runtimeState: state,
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      catalogFingerprint: 'catalog:v1:current',
      currentObservationAuthorizationFingerprints: new Set([currentAuthorization]),
      modelId: 'current',
    })).toMatchObject({ id: 'current', name: 'Current' });
    expect(selectProviderRuntimeCatalogModel({
      runtimeState: state,
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      catalogFingerprint: 'catalog:v1:current',
      currentObservationAuthorizationFingerprints: new Set([currentAuthorization]),
      modelId: 'disappeared',
    })).toBeNull();
  });

  it('breaks equal-time runtime catalog ties by locale-independent authorization identity', () => {
    const alternateAuthorization = `${currentAuthorization.slice(0, -1)}${currentAuthorization.endsWith('a') ? 'b' : 'a'}` as typeof currentAuthorization;
    const state = ProviderRuntimeStateFileV1Schema.parse({
      v: 1,
      machineId: 'machine-a',
      endpointHealth: [],
      catalogs: [currentAuthorization, alternateAuthorization].map((authorization) => ({
        key: {
          machineId: 'machine-a', connectionId: 'pc_gateway',
          catalogFingerprint: 'catalog:v1:current',
          observationAuthorizationFingerprint: authorization,
        },
        state: {
          catalogObservationId: authorization,
          snapshot: { models: [{ id: 'same', name: authorization }], observedAt: 20, stale: false },
          staleProbeModels: [],
        },
        lastAccessedAt: 20,
      })),
      installationChecks: [],
      modelLoadStates: [],
    });
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error('runtime identity ordering must not use localeCompare');
    };
    try {
      expect(selectProviderRuntimeCatalogModel({
        runtimeState: state,
        machineId: 'machine-a',
        connectionId: 'pc_gateway',
        catalogFingerprint: 'catalog:v1:current',
        currentObservationAuthorizationFingerprints: new Set([currentAuthorization, alternateAuthorization]),
        modelId: 'same',
      })).not.toBeNull();
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it('resolves a managed catalog model through stable source authorization without a durable endpoint', async () => {
    const connectionId = 'pc_managed_gateway';
    const contributionKey = 'acme.gateway/gateway';
    const definition = ProviderContributionV1Schema.parse({
      v: 1,
      id: 'gateway',
      name: 'Gateway',
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
      credential: {
        kind: 'apiKey',
        required: false,
        transports: [{
          id: 'bearer',
          protocols: ['openai-responses'],
          uses: ['probe', 'runtime'],
          destination: {
            kind: 'httpHeader',
            name: 'Authorization',
            format: 'bearer',
          },
        }],
      },
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
          executableBasenames: ['gateway-managed'],
          defaultPorts: [8317],
        },
        availabilityProbe: {
          endpointTemplateId: 'responses',
          path: '/v1/models',
          parser: 'openai-models',
        },
      },
    });
    const managed: ResolvedFirstPartyManagedProviderFacet = {
      managedEndpoint: {
        localService: {
          id: 'gateway-managed',
          launch: {
            kind: 'packaged-runtime-binary' as const,
            directorySegments: ['tools', 'unpacked'],
            executableBaseName: 'gateway-managed',
            privateConfigPathFlag: '--config',
          },
          launchMode: {
            kind: 'assignAndInject' as const,
            portPolicy: { kind: 'allocated' as const },
          },
          hostPolicy: { kind: 'loopback' as const },
          name: { strategy: 'fixed' as const, name: 'Gateway managed' },
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
    const catalogSource = {
      kind: 'transientModelEndpoint' as const,
      contractVersion: 'happier.gateway-managed/v1',
      sdkVersion: 'v1.2.3',
    };
    const contribution: ResolvedProviderContribution = {
      provenance: 'first_party',
      source: { kind: 'bundled' },
      pluginId: 'acme.gateway',
      identity: { pluginId: 'acme.gateway', localId: 'gateway' },
      definition,
      managed,
      managedRuntimeAdapter: {
        v: 1,
        catalogSource,
        prepare: async () => {
          throw new Error('not used by runtime catalog lookup');
        },
        resolveAgentEndpoint: () => 'http://127.0.0.1:45123/v1',
      },
    };
    const registry = {
      providersByContributionKey: new Map([[contributionKey, contribution]]),
    };
    const initialSettings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: connectionId,
        source: { kind: 'contribution', contributionKey },
        role: 'default',
        displayName: 'Gateway',
        displayNameMode: 'automatic',
        deployment: { kind: 'managedLocal' },
        purposeBindingDefaults: {
          upstream: {
            kind: 'account',
            account: {
              service: managed.connectedAccounts[0]!.service,
              accountId: 'account-a',
            },
          },
        },
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const initialResolution = resolveProviderConnectionForMachine({
      connectionId,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: initialSettings },
      registry,
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (initialResolution.status !== 'resolved') {
      throw new Error('Expected managed Provider resolution');
    }
    expect(initialResolution.record.endpoints).toEqual([]);
    const providerSettings = ProviderSettingsV1Schema.parse({
      ...initialSettings,
      machineGrants: [{
        v: 1,
        machineId: 'machine-a',
        connectionId,
        endpointSetFingerprint:
          initialResolution.record.endpointSetFingerprint,
        connectionSecurityFingerprint:
          initialResolution.record.connectionSecurityFingerprint,
        confirmedAt: 1,
      }],
    });
    const authorizedResolution = resolveProviderConnectionForMachine({
      connectionId,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: providerSettings },
      registry,
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (
      authorizedResolution.status !== 'resolved'
      || authorizedResolution.record.deployment.kind !== 'managedLocal'
    ) {
      throw new Error('Expected authorized managed Provider resolution');
    }
    if (!('probes' in definition.catalog)) {
      throw new Error('Expected probe catalog');
    }
    const probe = definition.catalog.probes[0]!;
    const endpointTemplate = definition.endpointTemplates[0]!;
    const probeRequestFingerprint =
      createProviderManagedProbeRequestFingerprintV1({
        implementationIdentity:
          authorizedResolution.record.deployment.implementationIdentity,
        managedFacet: authorizedResolution.record.deployment.facet,
        purposeBindings:
          authorizedResolution.record.deployment.purposeBindingIntents,
        catalogSource,
        endpointTemplateId: endpointTemplate.id,
        protocol: endpointTemplate.protocol,
        method: 'GET',
        path: probe.path,
        parser: probe.parser,
        publicHeaders: {},
      });
    const catalogFingerprint = createProviderCatalogFingerprintV1({
      probeRequestFingerprints: [probeRequestFingerprint],
    });
    const managedAuthorization =
      createProviderObservationAuthorizationFingerprintV1({
        selectedSecretBindingId: null,
        selectedSecretRecordFingerprint: null,
        credential: null,
      });
    const runtimeState = ProviderRuntimeStateFileV1Schema.parse({
      v: 1,
      machineId: 'machine-a',
      endpointHealth: [],
      catalogs: [{
        key: {
          machineId: 'machine-a',
          connectionId,
          catalogFingerprint,
          observationAuthorizationFingerprint: managedAuthorization,
        },
        state: {
          catalogObservationId: 'managed-current',
          snapshot: {
            models: [{ id: 'managed-model', name: 'Managed model' }],
            observedAt: 20,
            stale: false,
          },
          staleProbeModels: [],
        },
        lastAccessedAt: 20,
      }],
      installationChecks: [],
      modelLoadStates: [],
    });
    const resolveManagedPurposeBindingIntent = vi.fn<
      ResolveManagedProviderPurposeBindingIntent
    >(async (input) => ({
      purpose: input.purpose,
      target: input.target,
    }));
    const readRuntimeState = vi.fn(async () => runtimeState);

    await expect(resolveProviderRuntimeCatalogModel({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: authorizedResolution.record.connectionId,
          modelId: 'managed-model',
        },
      },
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: providerSettings },
      providerSettings,
      registry,
      dnsEvidenceByEndpointUrl: new Map(),
      resolveManagedPurposeBindingIntent,
      runtimeStateStore: {
        read: readRuntimeState,
      },
    })).resolves.toEqual({
      id: 'managed-model',
      name: 'Managed model',
    });
    expect(resolveManagedPurposeBindingIntent).toHaveBeenCalledWith({
      purpose: authorizedResolution.record.deployment.purposeBindingIntents.bindings[0]!.purpose,
      target: authorizedResolution.record.deployment.purposeBindingIntents.bindings[0]!.target,
      serviceRefs: [managed.connectedAccounts[0]!.service],
      signal: expect.any(AbortSignal),
    });

    resolveManagedPurposeBindingIntent.mockRejectedValueOnce(
      new Error('connected account binding unavailable'),
    );
    readRuntimeState.mockClear();
    await expect(resolveProviderRuntimeCatalogModel({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: authorizedResolution.record.connectionId,
          modelId: 'managed-model',
        },
      },
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: providerSettings },
      providerSettings,
      registry,
      dnsEvidenceByEndpointUrl: new Map(),
      resolveManagedPurposeBindingIntent,
      runtimeStateStore: {
        read: readRuntimeState,
      },
    })).resolves.toBeNull();
    expect(readRuntimeState).not.toHaveBeenCalled();
  });
});
