import { describe, expect, it, vi } from 'vitest';
import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderEndpointRuntimeStateRecordV1Schema,
  ProviderRuntimeStateFileV1Schema,
  ProviderSettingsV1Schema,
  createProviderCatalogFingerprintV1,
  createProviderEndpointFingerprintV1,
  createProviderObservationAuthorizationFingerprintV1,
  createProviderProbeRequestFingerprintV1,
  createEmptyProviderRuntimeStateFileV1,
  readProviderSettingsFromAccountSettingsV1,
} from '@happier-dev/protocol';

import type { ProviderRuntimeStateStore } from '@/providers/runtimeState';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveProviderSpawnAuthorization } from '@/providers/spawn/resolve';
import {
  createProviderProbeHttpClient,
  type ProviderProbeTransportRequest,
} from '@/providers/probe/client';
import { createProviderConnectionService } from '@/providers/connections';
import { PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS } from '@/providers/probe/scheduler';
import type { ProviderModelSettingsMutationIntent } from '@/providers/connections';

import {
  createRuntimeProviderModelManagementServices,
  resolveProviderManualModelCatalog,
} from './runtimeServices';

describe('runtime provider model-management composition', () => {
  const successfulModelSettingsMutation = async (
    intent: ProviderModelSettingsMutationIntent,
  ) => ({ status: 'success' as const, action: intent.action });

  it('resolves manual-model policy for a canonical-key connection through the registry', () => {
    const definition = ProviderContributionV1Schema.parse({
      v: 1,
      id: 'main',
      name: 'Gateway',
      kind: 'cloud',
      endpointTemplates: [{
        id: 'chat',
        protocol: 'openai-chat',
        baseUrl: 'https://models.example/v1',
        capabilities: {
          streaming: 'unknown', toolRoundTrips: 'unknown',
          statefulResponses: 'unknown', reasoningControls: 'unknown',
        },
      }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    });
    const contribution: ResolvedProviderContribution = {
      provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.gateway',
      identity: { pluginId: 'acme.gateway', localId: 'main' }, definition,
    };

    expect(resolveProviderManualModelCatalog(
      { providersByContributionKey: new Map([['acme.gateway/main', contribution]]) },
      { kind: 'contribution', contributionKey: 'acme.gateway/main' },
    )).toEqual(definition.catalog);
  });

  it('projects exact structured refs and compatibility without exposing connection endpoints or secrets', async () => {
    const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
    const contributionKey = 'acme.gateway/main';
    const definition = ProviderContributionV1Schema.parse({
      v: 1, id: 'main', name: 'Gateway', kind: 'cloud',
      endpointTemplates: [{
        id: 'chat', protocol: 'openai-chat', baseUrl: 'https://models.example/v1',
        capabilities: {
          streaming: 'supported', toolRoundTrips: 'supported',
          statefulResponses: 'unknown', reasoningControls: 'unknown',
        },
      }],
      catalog: {
        source: 'static+probe', manualModelPolicy: 'catalog-only',
        staticModels: [{ id: 'same-id', name: 'Provider Same', capabilities: { toolRoundTrips: 'supported' } }],
        probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'openai-models' }],
      },
      compatibilityOverrides: [{
        agentTargetKey: 'backend:codex', protocol: 'openai-chat', status: 'verified', reason: 'real integration',
        evidence: { sourceUrls: ['https://docs.example.test'], verifiedAt: '2026-07-11', testIds: ['real-session'] },
      }],
    });
    const contribution: ResolvedProviderContribution = {
      provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.gateway',
      identity: { pluginId: 'acme.gateway', localId: 'main' },
      definition,
    };
    const registry = { providersByContributionKey: new Map([['acme.gateway/main', contribution]]) };
    const preparedDefinition = ProviderContributionV1Schema.parse({
      ...definition,
      catalog: {
        ...definition.catalog,
        staticModels: [{
          id: 'same-id',
          name: 'Prepared generation',
          capabilities: { toolRoundTrips: 'supported' },
        }],
      },
    });
    const preparedRegistry = {
      providersByContributionKey: new Map([['acme.gateway/main', {
        ...contribution,
        definition: preparedDefinition,
      } satisfies ResolvedProviderContribution]]),
    };
    const base = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1, id: connectionId, source: { kind: 'contribution', contributionKey }, role: 'default',
        displayName: 'Gateway', displayNameMode: 'automatic', revision: 2, createdAt: 1, updatedAt: 2,
      }],
    });
    const resolved = resolveProviderConnectionForMachine({
      connectionId, machineId: 'machine-a', accountSettings: { providerSettingsV1: base }, registry,
      dnsEvidenceByEndpointUrl: new Map([['https://models.example/v1', ['1.1.1.1']]]),
    });
    if (resolved.status !== 'resolved') throw new Error('Expected provider connection');
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      accountGrants: [{
        v: 1, connectionId, connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1,
      }],
    });
    const support = {
      acceptsProtocols: ['openai-chat'], required: { streaming: true },
      credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
      authIsolation: { suppressConnectedServiceIds: ['openai-codex'], ownedEnvKeys: [] },
      materialization: 'engineConfig', applyPolicy: 'restart_session', supportsFreeformModelIds: false,
    } as const;
    const agentDefinition = (providerRequirements: unknown) => ({
      id: 'codex',
      pluginId: 'happier.agent.codex',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      definition: { id: 'codex', kindVersion: 1, providerRequirements },
    });
    const agentDefinitionsById = new Map([['codex', agentDefinition(support)]]);
    const executable = {
      generation: 7,
      contributes: {
        providersByContributionKey: registry.providersByContributionKey,
        agentDefinitionsById,
      },
      activateContributionsOnDemand: vi.fn(async () => []),
      agentRuntimesByAgentId: new Map([['codex', {
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        generation: 'fixture-generation',
        providerBinding: {
          v: 1, adapterVersion: 1,
          prepare: vi.fn(() => ({ v: 1, materialization: 'engineConfig' })),
          materialize: vi.fn(),
        },
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createRuntime: vi.fn(),
      }]]),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const lease: PluginRuntimeRegistryLease = {
      registry: executable,
      source: 'active',
      durableRevision: -1,
      release: vi.fn(async () => undefined),
    };
    const preparedLease: PluginRuntimeRegistryLease = {
      registry: {
        ...executable,
        contributes: {
          ...executable.contributes,
          providersByContributionKey: preparedRegistry.providersByContributionKey,
        },
      } as unknown as ResolvedExecutablePluginRuntimeRegistry,
      source: 'active',
      durableRevision: -1,
      release: vi.fn(async () => undefined),
    };
    let currentLease = lease;
    const observationAuthorizationFingerprint = createProviderObservationAuthorizationFingerprintV1({
      selectedSecretBindingId: null,
      selectedSecretRecordFingerprint: null,
      credential: null,
    });
    const probeRequestFingerprint = createProviderProbeRequestFingerprintV1({
      method: 'GET',
      endpointUrl: 'https://models.example/v1',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: {},
    });
    const currentEndpointFingerprint = createProviderEndpointFingerprintV1({
      endpointTemplateId: 'chat',
      protocol: 'openai-chat',
      probeRequestFingerprint,
    });
    const currentCatalogRecord = {
      key: {
        machineId: 'machine-a',
        connectionId,
        catalogFingerprint: createProviderCatalogFingerprintV1({
          probeRequestFingerprints: [probeRequestFingerprint],
        }),
        observationAuthorizationFingerprint,
      },
      state: {
        catalogObservationId: 'current-observation',
        snapshot: {
          models: [{ id: 'probe-current', name: 'Probe current' }],
          observedAt: 20,
          stale: true,
          staleAt: 30,
        },
        staleProbeModels: [{ id: 'probe-disappeared', name: 'Probe disappeared' }],
      },
      lastAccessedAt: 30,
    };
    let state = ProviderRuntimeStateFileV1Schema.parse({
      ...createEmptyProviderRuntimeStateFileV1('machine-a'),
      endpointHealth: [
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId, endpointTemplateId: 'chat',
            endpointFingerprint: 'endpoint-observation:v1:old-endpoint',
            observationAuthorizationFingerprint,
          },
          state: { status: 'available', activity: 'idle', observedAt: 30 },
          lastAccessedAt: 30,
        }),
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId, endpointTemplateId: 'chat',
            endpointFingerprint: currentEndpointFingerprint,
            observationAuthorizationFingerprint,
          },
          state: {
            status: 'unreachable', activity: 'idle', observedAt: 20,
            errorCode: 'provider_endpoint_unreachable',
          },
          lastAccessedAt: 20,
        }),
      ],
    });
    const runtimeStore: ProviderRuntimeStateStore = {
      path: '/virtual/provider-runtime-state.json', read: vi.fn(async () => state),
      updateTransientEndpointHealth: vi.fn(async (transform) => {
        state = { ...state, endpointHealth: [...await transform(state.endpointHealth)] };
      }),
      update: vi.fn(async (transform) => transform(state)),
    };
    let accountSettings = AccountSettingsSchema.parse({ providerSettingsV1: settings });
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'same-id' }] }), 'utf8'),
    }));
    const modelSettingsMutation = vi.fn(successfulModelSettingsMutation);
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a', registry, runtimeStore,
      resolveRegistry: async () => preparedRegistry,
      resolveAddresses: async () => ['1.1.1.1'], acquireRuntimeLease: async () => currentLease,
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      getAccountSettingsSnapshot: () => ({
        source: 'cache', settings: accountSettings,
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account-a',
      }),
      featureGate: { isEnabled: () => true },
      modelSettingsMutation,
    });

    const result = await services.projectModels({ machineId: 'machine-a', agentTargetKey: 'backend:codex' });
    expect(executable.activateContributionsOnDemand).toHaveBeenCalledWith([{
      pluginId: 'happier.agent.codex',
      family: 'agents',
      localId: 'codex',
    }]);
    expect(result).toMatchObject({
      status: 'success', agentTargetKey: 'backend:codex',
      groups: [{
        connectionId, connectionRevision: 2, supportsFreeformModelIds: false,
        suppressedConnectedServiceIds: ['openai-codex'],
        modelLoadAction: 'descriptor_absent',
        modelLoadPreflightPolicy: null,
        rows: [{
          ref: { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'same-id' },
          descriptor: { name: 'Provider Same' },
          compatibility: { result: { status: 'verified' }, confirmed: true },
          endpointHealth: 'unreachable',
        }],
      }],
    });
    // A prepared projection exists concurrently, but the held lease is the
    // operation's authority. The next operation observes that prepared lease.
    currentLease = preparedLease;
    const nextResult = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex',
    });
    expect(nextResult).toMatchObject({
      status: 'success',
      groups: [{ rows: [{ descriptor: { name: 'Prepared generation' } }] }],
    });
    currentLease = lease;
    expect(JSON.stringify(result)).not.toContain('models.example');
    expect(JSON.stringify(result)).not.toContain('publicHeaders');
    if (result.status !== 'success') throw new Error('Expected model projection');
    const projectedRow = result.groups[0]?.rows[0];
    if (!projectedRow) throw new Error('Expected projected model row');
    await expect(services.mutateModelSettings({
      action: 'confirmExperimental',
      machineId: 'machine-a',
      connectionId,
      expectedConnectionRevision: 2,
      agentTargetKey: 'backend:codex',
      modelId: projectedRow.ref.modelId,
      compatibilityFingerprint: projectedRow.compatibility.compatibilityFingerprint,
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_compatibility_unverified' },
    });
    expect(modelSettingsMutation).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(transport).toHaveBeenCalled());

    const selection = {
      v: 1 as const, updatedAt: 1,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'same-id' },
    };
    const authorization = resolveProviderSpawnAuthorization({
      selection, machineId: 'machine-a', agentTargetKey: 'backend:codex', agentId: 'codex',
      accountSettings: AccountSettingsSchema.parse({ providerSettingsV1: settings }), providerSettings: settings,
      registry, dnsEvidenceByEndpointUrl: new Map([['https://models.example/v1', ['1.1.1.1']]]), lease,
    });
    if (!authorization.ok) throw new Error('Expected provider authorization');
    await expect(services.resolveBindingStatus({
      machineId: 'machine-a', agentTargetKey: 'backend:codex', selection,
      launchBinding: authorization.authorization.sessionBindingMetadata,
    })).resolves.toEqual({ status: 'current' });
    await expect(services.resolveBindingStatus({
      machineId: 'machine-a', agentTargetKey: 'backend:codex', selection,
      launchBinding: {
        ...authorization.authorization.sessionBindingMetadata,
        bindingSecurityFingerprint: 'binding-security:v1:changed',
      },
    })).resolves.toEqual({
      status: 'changed',
      nextBindingSecurityFingerprint: authorization.authorization.bindingSecurityFingerprint,
    });

    const probeSelection = (modelId: string) => ({
      v: 1 as const,
      updatedAt: 1,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId },
    });
    const authorizePreviouslyCurrentProbe = (modelId: string) => resolveProviderSpawnAuthorization({
      selection: probeSelection(modelId),
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex',
      agentId: 'codex',
      accountSettings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: new Map([['https://models.example/v1', ['1.1.1.1']]]),
      lease,
      runtimeModelDescriptor: { id: modelId, name: modelId },
    });
    state = ProviderRuntimeStateFileV1Schema.parse({ ...state, catalogs: [currentCatalogRecord] });
    const activeProbeAuthorization = authorizePreviouslyCurrentProbe('probe-current');
    const disappearedProbeAuthorization = authorizePreviouslyCurrentProbe('probe-disappeared');
    if (!activeProbeAuthorization.ok || !disappearedProbeAuthorization.ok) {
      throw new Error('Expected both probe models to represent valid prior launch bindings');
    }
    await expect(services.resolveBindingStatus({
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex',
      selection: probeSelection('probe-current'),
      launchBinding: activeProbeAuthorization.authorization.sessionBindingMetadata,
    })).resolves.toEqual({ status: 'current' });
    await expect(services.resolveBindingStatus({
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex',
      selection: probeSelection('probe-disappeared'),
      launchBinding: disappearedProbeAuthorization.authorization.sessionBindingMetadata,
    })).resolves.toMatchObject({
      status: 'incompatible',
      error: { code: 'provider_model_not_found', action: 'choose_model' },
    });

    await expect(services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex',
      currentSelection: {
        agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'retired-model',
      },
    })).resolves.toMatchObject({
      status: 'success',
      currentSelectionRecovery: {
        kind: 'model_not_found',
        error: { code: 'provider_model_not_found', action: 'choose_model' },
      },
    });

    // A Provider that permits manual ids and an Agent that accepts freeform ids
    // make catalog membership NOT the authority over whether a model is real.
    // The exact selected model stays listed and must not be reported missing.
    const freeformDefinition = ProviderContributionV1Schema.parse({
      ...definition,
      catalog: {
        source: 'static+probe', manualModelPolicy: 'allowed',
        staticModels: [{ id: 'same-id', name: 'Provider Same', capabilities: { toolRoundTrips: 'supported' } }],
        probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'openai-models' }],
      },
    });
    registry.providersByContributionKey.set(contributionKey, { ...contribution, definition: freeformDefinition });
    agentDefinitionsById.set('codex', agentDefinition({ ...support, supportsFreeformModelIds: true }));
    const freeformSelection = {
      agentTargetKey: 'backend:codex',
      providerConnectionId: connectionId,
      modelId: 'vendor/freeform-only',
    };
    const freeformProjection = await services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'backend:codex', currentSelection: freeformSelection,
    });
    expect(freeformProjection).toMatchObject({ status: 'success', currentSelectionRecovery: null });
    if (freeformProjection.status !== 'success') throw new Error('Expected model projection');
    expect(freeformProjection.groups.flatMap((group) => group.rows).map((row) => row.ref.modelId))
      .toContain('vendor/freeform-only');
    // The same selection under an Agent that refuses freeform ids stays missing.
    agentDefinitionsById.set('codex', agentDefinition(support));
    await expect(services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'backend:codex', currentSelection: freeformSelection,
    })).resolves.toMatchObject({
      status: 'success',
      currentSelectionRecovery: {
        kind: 'model_not_found',
        error: { code: 'provider_model_not_found', action: 'choose_model' },
      },
    });
    registry.providersByContributionKey.set(contributionKey, contribution);

    const probeOnlyDefinition = ProviderContributionV1Schema.parse({
      ...definition,
      catalog: {
        source: 'probe', manualModelPolicy: 'allowed',
        probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'openai-models' }],
      },
    });
    registry.providersByContributionKey.set(contributionKey, { ...contribution, definition: probeOnlyDefinition });
    accountSettings = AccountSettingsSchema.parse({
      providerSettingsV1: ProviderSettingsV1Schema.parse({
        ...settings,
        accountGrants: [],
      }),
    });
    await expect(services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'backend:codex', currentSelection: selection.ref,
    })).resolves.toMatchObject({
      status: 'success',
      groups: [{
        connectionId,
        authorization: {
          authorized: false,
          error: { code: 'provider_connection_disabled', action: 'enable_connection' },
        },
        rows: [{ ref: selection.ref }],
      }],
      currentSelectionRecovery: null,
    });
    registry.providersByContributionKey.set(contributionKey, contribution);
    accountSettings = AccountSettingsSchema.parse({ providerSettingsV1: settings });

    registry.providersByContributionKey.delete(contributionKey);
    await expect(services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'backend:codex', currentSelection: selection.ref,
    })).resolves.toMatchObject({
      status: 'success',
      currentSelectionRecovery: {
        kind: 'contribution_unavailable',
        error: { code: 'provider_contribution_unavailable', action: 'restore_plugin' },
      },
    });
    registry.providersByContributionKey.set(contributionKey, contribution);

    accountSettings = AccountSettingsSchema.parse({
      providerSettingsV1: ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connectionTombstones: [{
          v: 1, id: connectionId, contributionKey, lastDisplayName: 'Gateway', deletedAt: 3,
        }],
      }),
    });
    await expect(services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'backend:codex', currentSelection: selection.ref,
    })).resolves.toMatchObject({
      status: 'success',
      currentSelectionRecovery: {
        kind: 'connection_deleted',
        error: { code: 'provider_connection_not_found', action: 'choose_connection' },
        displaySnapshot: { connectionName: 'Gateway' },
      },
    });
  });

  it('fails closed at the canonical feature decision before resolving provider authorization', async () => {
    const isEnabled = vi.fn(() => false);
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => null,
      featureGate: { isEnabled },
      modelSettingsMutation: successfulModelSettingsMutation,
    });

    await expect(services.loadModel({
      connectionId: 'pc_local',
      machineId: 'machine-a',
      modelId: 'model-a',
    })).resolves.toEqual({ status: 'not_supported', reason: 'feature_disabled' });
    await expect(services.rpcHandler({
      action: 'load',
      connectionId: 'pc_local',
      machineId: 'machine-a',
      modelId: 'model-a',
    })).resolves.toEqual({ status: 'not_supported', reason: 'feature_disabled' });
    expect(isEnabled).toHaveBeenCalledWith('providers.localModelManagement');
  });

  it('answers a cold picker read with the catalog its own demand produced', async () => {
    const registry = { providersByContributionKey: new Map() };
    const base = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: 'pc_cold',
        source: {
          kind: 'custom',
          template: {
            v: 1,
            name: 'Cold',
            endpointTemplates: [{
              id: 'catalog',
              protocol: 'openai-chat',
              baseUrl: 'https://cold.example/v1',
              capabilities: {
                streaming: 'unknown', toolRoundTrips: 'unknown',
                statefulResponses: 'unknown', reasoningControls: 'unknown',
              },
            }],
            catalog: {
              source: 'probe',
              manualModelPolicy: 'allowed',
              probes: [{ endpointTemplateId: 'catalog', path: '/models', parser: 'openai-models' }],
            },
          },
        },
        role: 'named',
        displayName: 'Cold',
        displayNameMode: 'custom',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const resolvedCold = resolveProviderConnectionForMachine({
      connectionId: 'pc_cold',
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: base },
      registry,
      dnsEvidenceByEndpointUrl: new Map([['https://cold.example/v1', ['1.1.1.1']]]),
    });
    if (resolvedCold.status !== 'resolved') throw new Error('Expected custom Provider connection');
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      accountGrants: [{
        v: 1,
        connectionId: 'pc_cold',
        connectionSecurityFingerprint: resolvedCold.record.connectionSecurityFingerprint,
        confirmedAt: 1,
      }],
    });
    const support = {
      acceptsProtocols: ['openai-chat'],
      required: { streaming: true },
      credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
      authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
      materialization: 'engineConfig',
      applyPolicy: 'restart_session',
      supportsFreeformModelIds: false,
    } as const;
    const executable = {
      generation: 7,
      contributes: {
        providersByContributionKey: registry.providersByContributionKey,
        agentDefinitionsById: new Map([['codex', {
          id: 'codex',
          pluginId: 'happier.agent.codex',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          definition: { id: 'codex', kindVersion: 1, providerRequirements: support },
        }]]),
      },
      activateContributionsOnDemand: vi.fn(async () => []),
      agentRuntimesByAgentId: new Map([['codex', {
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        generation: 'fixture-generation',
        providerBinding: {
          v: 1,
          adapterVersion: 1,
          prepare: vi.fn(() => ({ v: 1, materialization: 'engineConfig' })),
          materialize: vi.fn(),
        },
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createRuntime: vi.fn(),
      }]]),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const lease: PluginRuntimeRegistryLease = {
      registry: executable,
      source: 'active',
      durableRevision: -1,
      release: vi.fn(async () => undefined),
    };
    let state = createEmptyProviderRuntimeStateFileV1('machine-a');
    const runtimeStore: ProviderRuntimeStateStore = {
      path: '/virtual/provider-runtime-state.json',
      read: vi.fn(async () => state),
      updateTransientEndpointHealth: vi.fn(async (transform) => {
        state = { ...state, endpointHealth: [...await transform(state.endpointHealth)] };
      }),
      update: vi.fn(async (transform) => {
        state = await transform(state);
        return state;
      }),
    };
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'cold-model' }] }), 'utf8'),
    }));
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry,
      runtimeStore,
      resolveAddresses: async () => ['1.1.1.1'],
      acquireRuntimeLease: async () => lease,
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      getAccountSettingsSnapshot: () => ({
        source: 'cache',
        settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        scopeKey: 'account-a',
      }),
      featureGate: { isEnabled: () => true },
      modelSettingsMutation: successfulModelSettingsMutation,
    });

    // The very first picker read is cold: nothing has ever probed this connection,
    // so a projection that returns before its own demand settles is a silently
    // empty list with nothing to follow it.
    const projection = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex',
    });
    expect(projection.status).toBe('success');
    if (projection.status !== 'success') throw new Error('Expected model projection');
    expect(projection.groups.flatMap((group) => group.rows).map((row) => row.ref.modelId))
      .toEqual(['cold-model']);

    // The complement, and the reason the awaited read is safe at all: a connection
    // that already produced an observation is warm, so its refresh stays advisory.
    // Marking the retained snapshot stale makes the next read genuinely re-demand,
    // and the transport never answers — a projection that awaited warm connections
    // could not resolve, so a single dead endpoint would block every picker open.
    state = {
      ...state,
      catalogs: state.catalogs.map((record) => (record.state.snapshot
        ? {
            ...record,
            state: {
              ...record.state,
              snapshot: {
                ...record.state.snapshot,
                stale: true,
                staleAt: record.state.snapshot.observedAt,
              },
            },
          }
        : record)),
    };
    let releaseBlockedTransport!: () => void;
    const blockedTransport = new Promise<void>((resolve) => { releaseBlockedTransport = resolve; });
    transport.mockImplementation(async () => {
      await blockedTransport;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: 'cold-model' }] }), 'utf8'),
      };
    });
    const warm = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex',
    });
    releaseBlockedTransport();
    expect(warm.status).toBe('success');
    if (warm.status !== 'success') throw new Error('Expected model projection');
    expect(warm.groups.flatMap((group) => group.rows).map((row) => row.ref.modelId))
      .toEqual(['cold-model']);

    // A cold read whose own demand refresh FAILS must return the refresh's
    // typed failure instead of a success whose group is silently missing: the
    // UI cannot distinguish "no models" from "unreachable endpoint" otherwise.
    transport.mockImplementation(async () => ({
      status: 503,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}', 'utf8'),
    }));
    state = createEmptyProviderRuntimeStateFileV1('machine-a');
    const failingCold = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex',
    });
    expect(failingCold.status).toBe('success');
    if (failingCold.status !== 'success') throw new Error('Expected model projection');
    expect(failingCold.groups).toEqual([]);
    expect(failingCold.refreshFailures).toEqual([{
      connectionId: 'pc_cold',
      error: expect.objectContaining({ code: 'provider_endpoint_unavailable' }),
    }]);

    // Explicit Retry must enter the existing forced scheduler branch instead
    // of replaying the cached failure from the automatic picker demand.
    transport.mockImplementation(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'recovered-model' }] }), 'utf8'),
    }));
    const recovered = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex',
      forceRefresh: true,
    });
    expect(recovered.status).toBe('success');
    if (recovered.status !== 'success') throw new Error('Expected recovered model projection');
    expect(recovered.refreshFailures).toBeUndefined();
    expect(recovered.groups.flatMap((group) => group.rows).map((row) => row.ref.modelId))
      .toEqual(['recovered-model']);

    // Catalog success is authoritative model truth. A later health failure is
    // represented on row health and must not elevate the whole projection to a
    // catalog refresh failure.
    state = createEmptyProviderRuntimeStateFileV1('machine-a');
    transport
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: 'healthy-catalog-model' }] }), 'utf8'),
      })
      .mockResolvedValueOnce({
        status: 503,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}', 'utf8'),
      });
    const catalogSucceeded = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex',
      forceRefresh: true,
    });
    expect(catalogSucceeded.status).toBe('success');
    if (catalogSucceeded.status !== 'success') throw new Error('Expected catalog projection');
    expect(catalogSucceeded.refreshFailures).toBeUndefined();
    expect(catalogSucceeded.groups.flatMap((group) => group.rows).map((row) => row.ref.modelId))
      .toEqual(['healthy-catalog-model']);
  });

  it('submits picker demand to the sole scheduler and retains no tail the scheduler refused', async () => {
    // The sole probe scheduler admits four active operations and queues 64 more
    // by default, so exactly one of these legal connections must be refused.
    const schedulerAdmittedCapacity = PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS + 64;
    const connectionCount = schedulerAdmittedCapacity + 1;
    const registry = { providersByContributionKey: new Map() };
    const base = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: Array.from({ length: connectionCount }, (_, index) => ({
        v: 1,
        id: `pc_demand_${index}`,
        source: {
          kind: 'custom',
          template: {
            v: 1,
            name: `Demand ${index}`,
            endpointTemplates: [
              {
                id: 'catalog',
                protocol: 'openai-chat',
                baseUrl: `https://catalog-${index}.example/v1`,
                capabilities: {
                  streaming: 'unknown',
                  toolRoundTrips: 'unknown',
                  statefulResponses: 'unknown',
                  reasoningControls: 'unknown',
                },
              },
              {
                id: 'responses',
                protocol: 'openai-responses',
                baseUrl: `https://responses-${index}.example/v1`,
                capabilities: {
                  streaming: 'unknown',
                  toolRoundTrips: 'unknown',
                  statefulResponses: 'unknown',
                  reasoningControls: 'unknown',
                },
              },
            ],
            catalog: {
              source: 'probe',
              manualModelPolicy: 'allowed',
              probes: [
                { endpointTemplateId: 'catalog', path: '/models', parser: 'openai-models' },
                { endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' },
              ],
            },
          },
        },
        role: 'named',
        displayName: `Demand ${index}`,
        displayNameMode: 'custom',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      })),
    });
    const dnsEvidenceByEndpointUrl = new Map<string, readonly string[]>(
      base.connections.flatMap((connection) => connection.source.kind === 'custom'
        ? connection.source.template.endpointTemplates.map((endpoint) => [endpoint.baseUrl, ['1.1.1.1']] as const)
        : []),
    );
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      accountGrants: base.connections.map((connection) => {
        const resolved = resolveProviderConnectionForMachine({
          connectionId: connection.id,
          machineId: 'machine-a',
          accountSettings: { providerSettingsV1: base },
          registry,
          dnsEvidenceByEndpointUrl,
        });
        if (resolved.status !== 'resolved') throw new Error('Expected custom Provider connection');
        return {
          v: 1,
          connectionId: connection.id,
          connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
          confirmedAt: 1,
        };
      }),
    });
    const support = {
      acceptsProtocols: ['openai-chat'],
      required: { streaming: true },
      credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
      authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
      materialization: 'engineConfig',
      applyPolicy: 'restart_session',
      supportsFreeformModelIds: false,
    } as const;
    const executable = {
      generation: 7,
      contributes: {
        providersByContributionKey: registry.providersByContributionKey,
        agentDefinitionsById: new Map([['codex', {
          id: 'codex',
          pluginId: 'happier.agent.codex',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          definition: { id: 'codex', kindVersion: 1, providerRequirements: support },
        }]]),
      },
      activateContributionsOnDemand: vi.fn(async () => []),
      agentRuntimesByAgentId: new Map([['codex', {
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        generation: 'fixture-generation',
        providerBinding: {
          v: 1,
          adapterVersion: 1,
          prepare: vi.fn(() => ({ v: 1, materialization: 'engineConfig' })),
          materialize: vi.fn(),
        },
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createRuntime: vi.fn(),
      }]]),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const lease: PluginRuntimeRegistryLease = {
      registry: executable,
      source: 'active',
      durableRevision: -1,
      release: vi.fn(async () => undefined),
    };
    let state = createEmptyProviderRuntimeStateFileV1('machine-a');
    const runtimeStore: ProviderRuntimeStateStore = {
      path: '/virtual/provider-runtime-state.json',
      read: vi.fn(async () => state),
      updateTransientEndpointHealth: vi.fn(async (transform) => {
        state = { ...state, endpointHealth: [...await transform(state.endpointHealth)] };
      }),
      update: vi.fn(async (transform) => {
        state = await transform(state);
        return state;
      }),
    };
    const catalogHosts = new Set<string>();
    const releases: Array<() => void> = [];
    let releaseAll = false;
    const transport = vi.fn(async (request: ProviderProbeTransportRequest) => {
      if (request.hostname.startsWith('catalog-')) {
        catalogHosts.add(request.hostname);
        if (!releaseAll) {
          await new Promise<void>((resolve) => releases.push(resolve));
        }
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: 'model-a' }] }), 'utf8'),
      };
    });
    const resolveAddresses = vi.fn(async (_hostname: string) => ['1.1.1.1']);
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry,
      runtimeStore,
      resolveAddresses,
      acquireRuntimeLease: async () => lease,
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['1.1.1.1'],
        transport,
      }),
      getAccountSettingsSnapshot: () => ({
        source: 'cache',
        settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        scopeKey: 'account-a',
      }),
      featureGate: { isEnabled: () => true },
      modelSettingsMutation: successfulModelSettingsMutation,
    });

    try {
      // Every one of these connections is cold, so the read waits for the demand
      // it submitted rather than answering with an empty catalog.
      const projection = services.projectModels({
        machineId: 'machine-a',
        agentTargetKey: 'backend:codex',
      });
      // Every identity is submitted immediately, so the sole scheduler holds
      // its four active operations and queues its pending maximum while the
      // transport is blocked. One identity is beyond both and is refused.
      await vi.waitFor(
        () => expect(releases.length).toBe(4),
        { timeout: 5_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      releaseAll = true;
      for (const release of releases.splice(0)) release();

      await expect(projection).resolves.toMatchObject({ status: 'success', groups: expect.any(Array) });
      expect(lease.release).toHaveBeenCalledTimes(1);
      await vi.waitFor(
        () => expect(catalogHosts.size).toBe(schedulerAdmittedCapacity),
        { timeout: 5_000 },
      );
      // A consumer-side queue would keep feeding the refused tail once the
      // scheduler drained; the sole scheduler must leave it for a later read.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(catalogHosts.size).toBe(schedulerAdmittedCapacity);
      expect(schedulerAdmittedCapacity).toBeLessThan(connectionCount);
      // DNS belongs to the immutable picker operation: each unique hostname is
      // resolved once and the same evidence is reused after cold demand.
      const resolvedHostnames = resolveAddresses.mock.calls.map(([hostname]) => hostname);
      const duplicateHostnames = resolvedHostnames.filter((hostname, index) =>
        resolvedHostnames.indexOf(hostname) !== index);
      expect(duplicateHostnames).toEqual([]);
      expect(resolveAddresses).toHaveBeenCalledTimes(connectionCount * 2);
    } finally {
      releaseAll = true;
      for (const release of releases.splice(0)) release();
    }
    // Proving the refused tail requires a fixture larger than the scheduler's
    // whole admission window, so this case is inherently the slowest in the
    // suite and needs more than the shared default budget.
  }, 240_000);

  it('owns one shared probe/catalog runtime when the caller does not provide one', () => {
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => null,
      featureGate: { isEnabled: () => false },
      modelSettingsMutation: successfulModelSettingsMutation,
    });

    expect(services).toMatchObject({
      probe: expect.any(Function),
      models: expect.any(Function),
      loadModel: expect.any(Function),
      cancelModelLoad: expect.any(Function),
      rpcHandler: expect.any(Function),
      runtimeStore: expect.objectContaining({ read: expect.any(Function) }),
    });
  });

  it('returns the exact runtime-state owner supplied to the one shared probe composition', () => {
    let state = createEmptyProviderRuntimeStateFileV1('machine-a');
    const runtimeStore: ProviderRuntimeStateStore = {
      path: '/virtual/provider-runtime-state.json',
      read: vi.fn(async () => state),
      updateTransientEndpointHealth: vi.fn(async (transform) => {
        state = { ...state, endpointHealth: [...await transform(state.endpointHealth)] };
      }),
      update: vi.fn(async (transform) => transform(state)),
    };
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => null,
      featureGate: { isEnabled: () => false },
      runtimeStore,
      modelSettingsMutation: successfulModelSettingsMutation,
    });

    expect(services.runtimeStore).toBe(runtimeStore);
  });

  it('classifies a stale model-settings connection revision without claiming authorization drift', async () => {
    const settings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: 'pc_gateway',
        source: { kind: 'contribution', contributionKey: 'acme.gateway/main' },
        role: 'default',
        displayName: 'Gateway',
        displayNameMode: 'automatic',
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
      }],
    });
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => ({
        source: 'cache',
        settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      }),
      featureGate: { isEnabled: () => true },
      modelSettingsMutation: successfulModelSettingsMutation,
    });

    await expect(services.mutateModelSettings({
      action: 'manualAdd',
      machineId: 'machine-a',
      connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
      expectedConnectionRevision: 1,
      models: [{ id: 'vendor/model' }],
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_changed', retryable: true, action: 'review_connection' },
    });
  });

  it('routes revalidated model settings through the connection-service mutation transaction on CAS retry', async () => {
    const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
    const settings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: 'pc_gateway',
        source: {
          kind: 'custom',
          template: {
            v: 1,
            name: 'Gateway',
            endpointTemplates: [{
              id: 'chat',
              protocol: 'openai-chat',
              baseUrl: 'https://models.example/v1',
              capabilities: {
                streaming: 'unknown',
                toolRoundTrips: 'unknown',
                statefulResponses: 'unknown',
                reasoningControls: 'unknown',
              },
            }],
            catalog: { source: 'manual', manualModelPolicy: 'allowed' },
          },
        },
        role: 'named',
        displayName: 'Gateway',
        displayNameMode: 'custom',
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
      }],
    });
    let accountSettings = AccountSettingsSchema.parse({
      providerSettingsV1: settings,
      concurrentWinner: 0,
    });
    const updateAccountSettings = vi.fn(async (
      mutate: (
        raw: Readonly<Record<string, unknown>>,
      ) => Readonly<Record<string, unknown>>,
    ) => {
      mutate(accountSettings);
      accountSettings = AccountSettingsSchema.parse({
        ...accountSettings,
        concurrentWinner: 1,
      });
      accountSettings = AccountSettingsSchema.parse(mutate(accountSettings));
      return accountSettings;
    });
    const featureGate = { isEnabled: () => true };
    const connectionService = createProviderConnectionService({
      machineId: 'machine-a',
      featureGate,
      loadSnapshot: async () => ({
        accountSettings,
        rawAccountSettings: accountSettings,
        registry: { providersByContributionKey: new Map() },
      }),
      updateAccountSettings,
      collectDnsEvidence: async () => new Map(),
      resolveConnection: () => ({
        status: 'missing',
        connectionId,
        diagnostics: [],
      }),
      runtimeSummary: async () => ({
        summary: {
          health: 'not_checked',
          modelCount: null,
          checkedAt: null,
          endpoints: [],
        },
        probeObservationIdentity: null,
      }),
      now: () => 100,
    });
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => ({
        source: 'cache',
        settings: accountSettings,
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        scopeKey: 'account-a',
      }),
      featureGate,
      modelSettingsMutation: (intent) => connectionService.mutateModelSettings(intent),
    });

    await expect(services.mutateModelSettings({
      action: 'manualAdd',
      machineId: 'machine-a',
      connectionId,
      expectedConnectionRevision: 2,
      models: [{ id: 'vendor/model' }],
    })).resolves.toEqual({ status: 'success', action: 'manualAdd' });

    expect(accountSettings.concurrentWinner).toBe(1);
    expect(
      readProviderSettingsFromAccountSettingsV1(accountSettings)
        .settings.manualModelsByConnectionId[connectionId],
    ).toMatchObject([{ id: 'vendor/model', addedAt: 100 }]);
  });
});
