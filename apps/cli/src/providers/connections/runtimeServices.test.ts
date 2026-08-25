import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

function runtimeRegistry(
  activateContributionsOnDemand: ResolvedExecutablePluginRuntimeRegistry['activateContributionsOnDemand'],
): ResolvedExecutablePluginRuntimeRegistry {
  return {
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
    resolvePromptAssetBlocks: async () => [],
    addRuntimeDisposable: (_pluginId, disposable) => disposable,
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    retireConsumers: () => {},
    dispose: vi.fn(async () => {}),
  };
}

afterEach(() => {
  resetActiveAccountSettingsSnapshotForTests();
  vi.doUnmock('@/plugins/runtime/reload/singleton');
  vi.doUnmock('@/settings/accountSettings/updateAccountSettingsV2WithRetry');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('runtime Provider connection composition', () => {
  it('describes token-only account connections without starting Agent activation and releases the active registry lease', async () => {
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

  it('raises the canonical outcomeUnknown refusal from the one Account-Settings CAS seam', async () => {
    // `outcomeUnknown` is the only CAS status that means the machine may have
    // applied the change. The composition — not just the reader it calls — is
    // what both the daemon RPC surface and the direct CLI share, so this is
    // where the typed refusal has to survive: an untyped Error here reaches
    // the caller as `provider_settings_invalid` and sends them to retry a
    // possibly-applied mutation.
    const updateAccountSettingsV2WithRetry = vi.fn(async () => ({
      status: 'outcomeUnknown' as const,
      lastKnownVersion: 3,
    }));
    vi.doMock('@/settings/accountSettings/updateAccountSettingsV2WithRetry', async () => ({
      ...(await vi.importActual<
        typeof import('@/settings/accountSettings/updateAccountSettingsV2WithRetry')
      >('@/settings/accountSettings/updateAccountSettingsV2WithRetry')),
      updateAccountSettingsV2WithRetry,
    }));

    const credentials: StoredCredentials = {
      token: 'provider-runtime-services-cas-test',
      encryption: null,
    };
    const { createRuntimeProviderConnectionServices } = await import('./runtimeServices');
    const { service } = createRuntimeProviderConnectionServices({
      machineId: 'machine-a',
      credentials,
      happyHomeDir: configuration.happyHomeDir,
      featureGate: { isEnabled: (featureId) => featureId === 'providers' },
      runtimeSummary: async () => ({ status: 'error' }),
      resolveRegistry: async () => ({ providersByContributionKey: new Map() }),
    });

    await expect(service.mutateModelSettings({
      action: 'manualAdd',
      machineId: 'machine-a',
      connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
      expectedConnectionRevision: 0,
      expectedManualSource: { kind: 'contribution', contributionKey: 'acme.gateway/gateway' },
      models: [{ id: 'vendor/model' }],
    })).resolves.toEqual({
      status: 'error',
      error: {
        v: 1,
        code: 'provider_rpc_mutation_outcome_unknown',
        machineId: 'machine-a',
        retryable: false,
        action: 'review_current_state',
      },
    });
    expect(updateAccountSettingsV2WithRetry).toHaveBeenCalledOnce();
  });
});
