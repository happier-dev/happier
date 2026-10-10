import { unexpectedProjectNativeAdapterResolution } from "@/plugins/testkit/unexpectedProjectNativeAdapterResolution";
import { unexpectedCaptureSourceResolution } from "@/plugins/testkit/unexpectedCaptureSourceResolution";
import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, FeaturesResponseSchema, ProviderConnectionIdSchema, ProviderConnectionV1Schema, SavedSecretSchema, createProviderErrorV1 } from '@happier-dev/protocol';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { openProviderConnectionsContentV1, type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';

// Stored credentials are a filesystem boundary; the secret transaction stays real.
const persistenceBoundary = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));
vi.mock('@/persistence', async importOriginal => ({ ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: persistenceBoundary.readStoredCredentials }));

function runtimeRegistry(
  activateContributionsOnDemand: ResolvedExecutablePluginRuntimeRegistry['activateContributionsOnDemand'],
): ResolvedExecutablePluginRuntimeRegistry {
  return {
    projectManagedServices: createManagedServicesOwner({
      processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
      dependencies: createUnavailablePluginServices().managedServices.dependencies,
      resolveScope: () => null,
    }),
    contributes: {
      agents: Object.freeze([]),
      actions: Object.freeze([]),
      resources: Object.freeze([]),
      uiViewsV2: Object.freeze([]),
      uiRenderersV2: Object.freeze([]),
      uiTranslationsV2: Object.freeze([]),
      activationTargets: Object.freeze([]),
      catalogEntriesById: Object.freeze({}),
      agentDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: Object.freeze({}),
    },
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    activatedPluginIds: new Set(),
    activateContributionsOnDemand,
    resolveCaptureSource: unexpectedCaptureSourceResolution,
    resolveProjectNativeAdapter: unexpectedProjectNativeAdapterResolution,
    resolvePromptAssetBlocks: async () => [],
    addRuntimeDisposable: (_pluginId, disposable) => disposable,
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    retireConsumers: () => {},
    dispose: vi.fn(async () => {}),
  };
}

afterEach(async () => {
  const { resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  resetActiveAccountSettingsSnapshotForTests();
  vi.doUnmock('@/plugins/runtime/reload/singleton');
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  persistenceBoundary.readStoredCredentials.mockReset();
});

describe('runtime Provider connection composition', () => {
  it('saves Account authoring without resolving machine endpoints or runtime state', async () => {
    const { setActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const credentials: StoredCredentials = { token: 'provider-account-daemon-edit', encryption: null };
    const { defaultsByAgentTargetKey: _defaults, ...empty } = DEFAULT_PROVIDER_SETTINGS_V1;
    let catalog: ProviderConnectionsCatalogV1 = { ...empty, connections: [ProviderConnectionV1Schema.parse({
      v: 1, id: 'pc_account', role: 'named', displayName: 'Original', displayNameMode: 'custom', revision: 0,
      createdAt: 1, updatedAt: 1, source: { kind: 'custom', template: { v: 1, name: 'Account Provider',
        endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://account-provider.invalid/v1',
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' } } },
    })] };
    let revision = 7;
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {},
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
      providerConnectionsCatalog: { status: 'ready', revision, catalog } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
        status: 'present', revision, content: { t: 'plain', v: catalog } } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      const history = emptyAccountSettingsHistoryCaptureResponse(path);
      if (history) return history;
      throw new Error(`Unexpected daemon Account Provider read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const { ProviderConnectionsRowMutationV1Schema } = await import('@happier-dev/protocol/providers/connections/connectionRowsV1');
      const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
      if (mutation.content?.t !== 'plain') throw new Error('Plain Account must keep a Plain catalog');
      catalog = mutation.content.v;
      revision += 1;
      return { status: 200, data: { status: 'updated', revision, cursor: revision } };
    });
    const resolveAddresses = vi.fn(async (): Promise<never> => { throw new Error('Account authoring cannot perform DNS'); });
    const runtimeSummary = vi.fn(async (): Promise<never> => { throw new Error('Account authoring cannot run a Provider'); });
    const { createRuntimeProviderConnectionServices } = await import('./runtimeServices');
    const services = createRuntimeProviderConnectionServices({ machineId: 'machine-a', credentials,
      happyHomeDir: configuration.happyHomeDir, featureGate: { isEnabled: () => true }, runtimeSummary,
      resolveRegistry: async () => ({ providersByContributionKey: new Map() }), resolveAddresses });
    expect(await services.mutateConnection({ action: 'update', machineId: 'machine-a', connectionId: 'pc_account',
      expectedRevision: 0, displayName: 'Edited Account' })).toMatchObject({ status: 'success', connection: { displayName: 'Edited Account' } });
    expect(catalog.connections[0]?.displayName).toBe('Edited Account');
    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(runtimeSummary).not.toHaveBeenCalled();
  });

  it.each(['none', 'row', 'history'] as const)('loads the Provider row through the admitted HTTP boundary without a Settings root (outage: %s)', async outage => {
    const { setActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const credentials: StoredCredentials = { token: 'provider-runtime-row-test', encryption: null };
    setActiveAccountSettingsSnapshot({
      source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {},
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    const { defaultsByAgentTargetKey: _defaults, ...emptyCatalog } = DEFAULT_PROVIDER_SETTINGS_V1;
    const catalog = { ...emptyCatalog, connections: [ProviderConnectionV1Schema.parse({
      v: 1, id: 'pc_row', role: 'named', displayName: 'Row Provider', displayNameMode: 'custom',
      revision: 0, createdAt: 1, updatedAt: 1, source: { kind: 'custom', template: {
        v: 1, name: 'Row Provider', endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://row-provider.invalid/v1',
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      } },
    })] };
    let rowAvailable = outage !== 'row';
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v1/account/entity-rows/provider-connections') {
        if (!rowAvailable) throw new Error('Temporary Home outage');
        return { status: 200, data: { status: 'present', revision: 7, content: { t: 'plain', v: catalog } } };
      }
      if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/account/entity-rows/profiles/transfer' && outage === 'history') return { status: 503, data: {} };
      const historyResponse = emptyAccountSettingsHistoryCaptureResponse(path);
      if (historyResponse) return historyResponse;
      throw new Error(`Unexpected Provider HTTP boundary: ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected Provider row read mutation'));
    const { createRuntimeProviderConnectionServices } = await import('./runtimeServices');
    const { createRuntimeProviderServices } = await import('@/providers/probe/runtimeServices');
    const registry = { providersByContributionKey: new Map() };
    const runtime = createRuntimeProviderServices({ machineId: 'machine-a', registry,
      featureGate: { isEnabled: () => true }, happyHomeDir: configuration.happyHomeDir });
    const services = createRuntimeProviderConnectionServices({
      machineId: 'machine-a', credentials, happyHomeDir: configuration.happyHomeDir,
      featureGate: { isEnabled: (featureId) => featureId === 'providers' },
      runtimeSummary: runtime.summary,
      resolveRegistry: async () => registry,
      resolveAddresses: async () => ['1.1.1.1'],
    });
    if (outage === 'row') {
      await expect(services.describeConnections({ machineId: 'machine-a' })).resolves.toMatchObject({
        status: 'error', error: { code: 'provider_settings_invalid' },
      });
      rowAvailable = true;
    }
    const result = await services.describeConnections({ machineId: 'machine-a' });
    expect(result, JSON.stringify({ catalog: getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog,
      httpPaths: get.mock.calls.map(call => new URL(String(call[0])).pathname) })).toMatchObject({
      status: 'success', connections: [{ connectionId: 'pc_row', displayName: 'Row Provider' }],
    });
    expect(post).not.toHaveBeenCalled();
    if (outage === 'history') expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({
      status: 'ready', cleanup: { status: 'cleanup-pending' },
    });
  });

  it('describes token-only account connections without starting Agent activation and releases the active registry lease', async () => {
    const { setActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const neverSettles = new Promise<never>(() => {});
    const activateContributionsOnDemand = vi.fn(() => neverSettles);
    const activeRegistry = runtimeRegistry(activateContributionsOnDemand);
    const replacementRegistry = runtimeRegistry(async () => []);
    const controller = createPluginReloadController();
    await controller.adoptPreparedRuntimeRegistry({
      registry: activeRegistry,
      changedPluginIds: [],
      durableRevision: 1,
      runningSessionDisposition: 'retainRunningSessions',
    });
    vi.doMock('@/plugins/runtime/reload/singleton', () => ({
      pluginReloadController: controller,
    }));

    const credentials: StoredCredentials = {
      token: 'provider-runtime-services-test',
      encryption: null,
    };
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: (() => {
        const { defaultsByAgentTargetKey: _defaults, ...catalog } = DEFAULT_PROVIDER_SETTINGS_V1;
        return catalog;
      })() },
    });

    const { createRuntimeProviderConnectionServices } = await import('./runtimeServices');
    const services = createRuntimeProviderConnectionServices({
      machineId: 'machine-a',
      credentials,
      happyHomeDir: configuration.happyHomeDir,
      featureGate: {
        isEnabled: (featureId) => featureId === 'providers',
      },
      runtimeSummary: async () => ({ status: 'error' }),
      resolveRegistry: async () => ({ providersByContributionKey: new Map() }),
    });
    const timeout = Symbol('timeout');
    const result = await Promise.race([
      services.describeConnections({ machineId: 'machine-a' }),
      new Promise<typeof timeout>((resolve) => {
        setTimeout(() => resolve(timeout), 50);
      }),
    ]);

    expect(result).not.toBe(timeout);
    expect(result).toMatchObject({ status: 'success', connections: [], available: [] });
    expect(activateContributionsOnDemand).not.toHaveBeenCalled();

    await controller.adoptPreparedRuntimeRegistry({
      registry: replacementRegistry,
      changedPluginIds: [],
      durableRevision: 2,
      runningSessionDisposition: 'retainRunningSessions',
    });
    expect(activeRegistry.dispose).toHaveBeenCalledOnce();
    await controller.shutdown({ timeoutMs: 0 });
  });

  it.each(['applied', 'conflict', 'outcome_unknown'] as const)('applies one Provider row mutation or preserves its typed refusal (%s)', async outcome => {
    const { setActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const credentials: StoredCredentials = {
      token: 'provider-runtime-services-cas-test',
      encryption: null,
    };
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      rawSettings: {},
      settingsVersion: 3,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    const { defaultsByAgentTargetKey: _defaults, ...empty } = DEFAULT_PROVIDER_SETTINGS_V1;
    let catalog = { ...empty, connections: [ProviderConnectionV1Schema.parse({
      v: 1, id: 'pc_gateway', role: 'default', source: { kind: 'contribution', contributionKey: 'acme.gateway/gateway' },
      displayName: 'Gateway', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    })] };
    let revision = 7;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 3, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
        status: 'present', revision, content: { t: 'plain', v: catalog },
      } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 3, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      const historyResponse = emptyAccountSettingsHistoryCaptureResponse(path);
      if (historyResponse) return historyResponse;
      throw new Error(`Unexpected Provider HTTP boundary: ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
      if (outcome === 'conflict') return { status: 409, data: { status: 'conflict', revision: 8 } };
      catalog = { ...catalog, connections: [] };
      revision = 8;
      if (outcome === 'outcome_unknown') throw new Error('ACK lost after dispatch');
      return { status: 200, data: { status: 'updated', revision, cursor: revision } };
    });
    const { createRuntimeProviderConnectionServices } = await import('./runtimeServices');
    const { createRuntimeProviderServices } = await import('@/providers/probe/runtimeServices');
    const registry = { providersByContributionKey: new Map() };
    const runtime = createRuntimeProviderServices({ machineId: 'machine-a', registry,
      featureGate: { isEnabled: () => true }, happyHomeDir: configuration.happyHomeDir });
    const { service } = createRuntimeProviderConnectionServices({
      machineId: 'machine-a',
      credentials,
      happyHomeDir: configuration.happyHomeDir,
      featureGate: { isEnabled: (featureId) => featureId === 'providers' },
      runtimeSummary: runtime.summary,
      resolveRegistry: async () => registry,
    });

    await expect(service.delete({
      action: 'delete',
      machineId: 'machine-a',
      connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
    })).resolves.toEqual(outcome === 'applied' ? { status: 'success', connectionId: 'pc_gateway' } : {
      status: 'error', error: createProviderErrorV1(outcome === 'conflict'
        ? 'provider_connection_changed' : 'provider_rpc_mutation_outcome_unknown', { machineId: 'machine-a' }),
    });
    expect(post).toHaveBeenCalledOnce();
    expect(new URL(String(post.mock.calls[0]?.[0])).pathname).toBe('/v1/account/entity-rows/provider-connections');
    expect(post.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 7, content: { t: 'plain', v: { connections: [] } } });
    expect(catalog.connections).toHaveLength(outcome === 'conflict' ? 1 : 0);
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 3, rawSettings: {} });
  });
  it('binds prepared material through one canonical resource and Provider row transaction despite unrelated Settings drift', async () => {
    const { setActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const credentials: StoredCredentials = {
      token: `e30.${Buffer.from(JSON.stringify({ sub: 'provider-account' })).toString('base64url')}.signature`, encryption: null,
    };
    persistenceBoundary.readStoredCredentials.mockResolvedValue(credentials);
    const raw = { preferredLanguage: 'fr', futureSibling: { preserved: true } };
    const { defaultsByAgentTargetKey: _defaults, ...empty } = DEFAULT_PROVIDER_SETTINGS_V1;
    let catalog: ProviderConnectionsCatalogV1 = { ...empty, connections: [ProviderConnectionV1Schema.parse({
      v: 1, id: 'pc_prepared', role: 'named', displayName: 'Prepared Provider', displayNameMode: 'custom',
      revision: 0, createdAt: 1, updatedAt: 1, source: { kind: 'custom', template: {
        v: 1, name: 'Prepared Provider', endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://prepared-provider.invalid/v1',
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
        credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', protocols: ['openai-chat'], uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      } },
    })] };
    let revision = 7;
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse(raw), rawSettings: raw,
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
      providerConnectionsCatalog: { status: 'ready', revision, catalog } });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({
      features: { teams: { enabled: true } }, capabilities: {} }))));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 9, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
        status: 'present', revision, content: { t: 'plain', v: catalog },
      } };
      if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 9, content: { t: 'plain', v: raw } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      const historyResponse = emptyAccountSettingsHistoryCaptureResponse(path);
      if (historyResponse) return historyResponse;
      throw new Error(`Unexpected prepared Provider HTTP boundary: ${path}`);
    });
    let observed: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse> | undefined;
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe('/v1/account/saved-secrets/resources/promote');
      observed = SharedSavedSecretPromoteInputV1Schema.parse(body);
      const opened = openProviderConnectionsContentV1({ mode: 'plain', material: null,
        content: observed.catalogMutations?.providerConnections?.content });
      if (opened.status !== 'opened') throw new Error('fixture_unopenable_provider_mutation');
      catalog = opened.catalog;
      revision = 8;
      return { status: 200, data: { resourceId: observed.resourceId, settingsVersion: 9 } };
    });
    const { createRuntimeProviderConnectionServices } = await import('./runtimeServices');
    const { createRuntimeProviderServices } = await import('@/providers/probe/runtimeServices');
    const registry = { providersByContributionKey: new Map() };
    const runtime = createRuntimeProviderServices({ machineId: 'machine-a', registry,
      featureGate: { isEnabled: () => true }, happyHomeDir: configuration.happyHomeDir });
    const { service } = createRuntimeProviderConnectionServices({ machineId: 'machine-a', credentials,
      happyHomeDir: configuration.happyHomeDir, featureGate: { isEnabled: featureId => featureId === 'providers' },
      runtimeSummary: runtime.summary, resolveRegistry: async () => registry, resolveAddresses: async () => ['1.1.1.1'] });
    const record = SavedSecretSchema.parse({ id: 'draft-provider-key', name: 'Provider key', kind: 'apiKey',
      createdAt: 1, updatedAt: 1, encryptedValue: { _isSecretValue: true, value: 'provider-private' } });
    await expect(service.bindSecret({ action: 'bindSecret', machineId: 'machine-a', connectionId: 'pc_prepared',
      credentialSlotId: 'apiKey', savedSecretId: record.id, scope: 'account', preparedSavedSecret: { id: record.id, record },
    })).resolves.toMatchObject({ status: 'success', connectionId: 'pc_prepared', credential: { accountBound: true } });
    if (!observed) throw new Error('fixture_missing_atomic_provider_request');
    const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: 'provider-account',
      source: { kind: 'personal-saved-secret', secretId: record.id } });
    const ref = `happier:shared-secret:v1:${resourceId}`;
    expect(observed).toMatchObject({ resourceId, nextSettings: null, profileMutations: [],
      referenceCensus: { scope: 'catalogs', accountMode: 'plain', catalogs: { providerConnections: 7 } },
      catalogMutations: { providerConnections: { expectedRevision: 7, referencedSavedSecretIds: [ref],
        savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] } } });
    expect(observed).not.toHaveProperty('expectedSettingsVersion');
    expect(openSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', storedContent: observed.storedContent }))
      .toMatchObject({ value: 'provider-private' });
    expect(catalog.secretBindingsByConnectionId[ProviderConnectionIdSchema.parse('pc_prepared')]?.account).toEqual({ apiKey: ref });
    expect(post).toHaveBeenCalledOnce();
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 4, rawSettings: raw,
      providerConnectionsCatalog: { status: 'ready', revision: 8 } });
  });
});
