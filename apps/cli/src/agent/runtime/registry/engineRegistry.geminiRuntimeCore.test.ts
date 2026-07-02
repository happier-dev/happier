import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '../../../plugins/projection/registry/sources/generatedBundledPlugins';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from '../../../plugins/projection/registry/types';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { isExecutionRunHostRuntime } from '../bridges/executionRun/executionRunHostRuntime';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const GEMINI_BACKEND_ID = 'gemini';
const GEMINI_PLUGIN_ID = 'happier.agent.gemini';

function createGeminiOnlyContributionRegistry(): ResolvedContributionRegistry {
  const builtInContributions = resolveBuiltInContributions();
  const provider = builtInContributions.providers.find((entry) => entry.id === GEMINI_BACKEND_ID);
  const backend = builtInContributions.backends.find((entry) => entry.id === GEMINI_BACKEND_ID);
  const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === GEMINI_PLUGIN_ID) ?? [];

  if (!provider || !backend || activationTargets.length !== 1) {
    throw new Error('Expected generated Gemini provider, backend, and activation target contributions');
  }

  return {
    providers: Object.freeze([provider]),
    backends: Object.freeze([backend]),
    actions: Object.freeze([]),
    resources: Object.freeze([]),
    uiDescriptors: Object.freeze([]),
    notifications: Object.freeze([]),
    notificationChannels: Object.freeze([]),
    events: Object.freeze([]),
    executionRunProfiles: Object.freeze([]),
    installables: Object.freeze([]),
    requestInterceptors: Object.freeze([]),
    scmHostingProviders: Object.freeze([]),
    scmBackends: Object.freeze([]),
    connectedAccountDescriptors: Object.freeze([]),
    activationTargets: Object.freeze(activationTargets),
    hookRegistrations: Object.freeze([]),
    surfaceHandlersByBackendId: new Map(),
    catalogEntriesById: Object.freeze(provider.catalogEntry ? { [provider.catalogEntry.id]: provider.catalogEntry } : {}),
    providerDefinitionsById: new Map([[provider.id, provider]]),
    backendDefinitionsById: new Map([[backend.id, backend]]),
    pluginDiagnosticsByPluginId: Object.freeze({}),
  };
}

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('engineRegistry (gemini runtimeCore)', () => {
  it('resolves the bundled Gemini ACP plugin runtimeCore through production dispatch', async () => {
    const contributes = createGeminiOnlyContributionRegistry();
    const activationTarget = contributes.activationTargets[0];
    expect({
      activationDaemonEntryPath: activationTarget?.daemonEntryPath,
      bundledPackageNamesIncludeGemini: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES.includes('@happier-dev/plugins-gemini'),
    }).toEqual({
      activationDaemonEntryPath: '@happier-dev/plugins-gemini',
      bundledPackageNamesIncludeGemini: true,
    });

    const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
      contributes,
      pluginIds: [GEMINI_PLUGIN_ID],
    });

    expect({
      engines: [...runtimeRegistry.backendEnginesByBackendId.entries()].map(([backendId, entry]) => ({
        backendId,
        pluginId: entry.pluginId,
      })),
      diagnostics: runtimeRegistry.pluginDiagnosticsByPluginId,
    }).toEqual({
      engines: [{
        backendId: GEMINI_BACKEND_ID,
        pluginId: GEMINI_PLUGIN_ID,
      }],
      diagnostics: {
        [GEMINI_PLUGIN_ID]: [],
      },
    });

    const resolution = await resolveBackendEngineAdapterResolution(GEMINI_BACKEND_ID, {
      contributes,
    });

    expect({
      selectedSource: resolution?.selectedSource,
      runtimeOwner: resolution?.runtimeOwner,
      diagnostics: resolution?.diagnostics,
      backendPluginId: resolution?.backend.pluginId,
      backendDaemonEntryPath: resolution?.backend.daemonEntryPath,
    }).toEqual({
      selectedSource: 'plugin',
      runtimeOwner: {
        backendId: GEMINI_BACKEND_ID,
        selected: {
          kind: 'plugin_engine',
          ownerId: GEMINI_PLUGIN_ID,
          provenance: 'first_party',
          pluginId: GEMINI_PLUGIN_ID,
        },
        candidates: [{
          kind: 'plugin_engine',
          ownerId: GEMINI_PLUGIN_ID,
          provenance: 'first_party',
          pluginId: GEMINI_PLUGIN_ID,
        }],
      },
      diagnostics: [],
      backendPluginId: GEMINI_PLUGIN_ID,
      backendDaemonEntryPath: '@happier-dev/plugins-gemini',
    });

    const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
      credentials: createTestCredentials(),
      directory: '/tmp/gemini',
      permissionMode: 'safe-yolo',
    });

    expect(plan).toMatchObject({
      kind: 'hostSessionRuntimePlan',
      providerId: GEMINI_BACKEND_ID,
      config: {
        providerName: 'Gemini CLI',
        agentMessageType: 'gemini',
      },
    });
    expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));

    const executionRunRuntime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
      backendId: GEMINI_BACKEND_ID,
      cwd: '/tmp/gemini',
      permissionMode: 'read_only',
      accountSettings: null,
    });

    expect(isExecutionRunHostRuntime(executionRunRuntime)).toBe(true);
  });
});
