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
import { createProviderProbeHttpClient } from '@/providers/probe/client';
import { createProviderConnectionService } from '@/providers/connections';
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
    const executable = {
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
          v: 1, adapterVersion: 1,
          prepare: vi.fn(() => ({ v: 1, materialization: 'engineConfig' })),
          materialize: vi.fn(),
        },
        isCurrent: () => true,
        createRuntime: vi.fn(),
      }]]),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const lease: PluginRuntimeRegistryLease = {
      registry: executable, source: 'active', release: vi.fn(async () => undefined),
    };
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
      update: vi.fn(async (transform) => transform(state)), touch: vi.fn(), flushTouches: vi.fn(async () => state),
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
      resolveAddresses: async () => ['1.1.1.1'], acquireRuntimeLease: async () => lease,
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
          compatibility: { result: { status: 'verified' }, confirmed: true },
          endpointHealth: 'unreachable',
        }],
      }],
    });
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
    const state = createEmptyProviderRuntimeStateFileV1('machine-a');
    const runtimeStore: ProviderRuntimeStateStore = {
      path: '/virtual/provider-runtime-state.json',
      read: vi.fn(async () => state),
      update: vi.fn(async (transform) => transform(state)),
      touch: vi.fn(),
      flushTouches: vi.fn(async () => state),
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
