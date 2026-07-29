import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

function runtimeRegistry(
  label: string,
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
      generationId: `registry:${label}`,
    },
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    daemonAuthBridgesByServiceId: new Map(),
    scmHostingProvidersById: new Map(),
    networkAllowedUrlOriginsByPluginId: new Map(),
    processSpawnAllowedPathsByPluginId: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    activatedPluginIds: new Set(),
    activateContributionsOnDemand,
    resolvePromptAssetBlocks: async () => [],
    addRuntimeDisposable: (_pluginId, disposable) => disposable,
    createAgentInvocationServices: () => createUnavailablePluginServices(),
    readHookEventEnvelopeV1,
    retireConsumers: () => {},
    dispose: vi.fn(async () => {}),
  };
}

afterEach(() => {
  resetActiveAccountSettingsSnapshotForTests();
  vi.doUnmock('@/plugins/runtime/reload/singleton');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('runtime Provider connection composition', () => {
  it('describes connections without starting Agent activation and releases the active registry lease', async () => {
    const neverSettles = new Promise<never>(() => {});
    const activateContributionsOnDemand = vi.fn(() => neverSettles);
    const activeRegistry = runtimeRegistry('active', activateContributionsOnDemand);
    const replacementRegistry = runtimeRegistry('replacement', async () => []);
    const controller = createPluginReloadController();
    await controller.adoptPreparedRuntimeRegistry({
      registry: activeRegistry,
      changedPluginIds: [],
      durableRevision: 1,
    });
    vi.doMock('@/plugins/runtime/reload/singleton', () => ({
      pluginReloadController: controller,
    }));

    const credentials: Credentials = {
      token: 'provider-runtime-services-test',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
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
    });
    expect(activeRegistry.dispose).toHaveBeenCalledOnce();
    await controller.shutdown({ timeoutMs: 0 });
  });
});
