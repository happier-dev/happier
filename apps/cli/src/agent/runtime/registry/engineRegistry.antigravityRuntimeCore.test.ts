import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '../../../plugins/projection/registry/sources/generatedBundledPlugins';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from '../../../plugins/projection/registry/types';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const ANTIGRAVITY_BACKEND_ID = 'antigravity';
const ANTIGRAVITY_PLUGIN_ID = 'happier.agent.antigravity';

function createAntigravityOnlyContributionRegistry(): ResolvedContributionRegistry {
  const builtInContributions = resolveBuiltInContributions();
  const provider = builtInContributions.agents.find((entry) => entry.id === ANTIGRAVITY_BACKEND_ID);
  const backend = builtInContributions.agentRuntimes.find((entry) => entry.id === ANTIGRAVITY_BACKEND_ID);
  const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === ANTIGRAVITY_PLUGIN_ID) ?? [];

  if (!provider || !backend || activationTargets.length !== 1) {
    throw new Error('Expected generated Antigravity provider, backend, and activation target contributions');
  }

  return {
    agents: Object.freeze([provider]),
    agentRuntimes: Object.freeze([backend]),
    actions: Object.freeze([]),
    resources: Object.freeze([]),
    uiDescriptors: Object.freeze([]),
    notifications: Object.freeze([]),
    notificationChannels: Object.freeze([]),
    events: Object.freeze([]),
    executionRunProfiles: Object.freeze([]),
    managedDependencies: Object.freeze([]),
    requestInterceptors: Object.freeze([]),
    scmHostingProviders: Object.freeze([]),
    scmBackends: Object.freeze([]),
    connectedAccountDescriptors: Object.freeze([]),
    activationTargets: Object.freeze(activationTargets),
    hookRegistrations: Object.freeze([]),
    surfaceHandlersByBackendId: new Map(),
    catalogEntriesById: Object.freeze(provider.catalogEntry ? { [provider.catalogEntry.id]: provider.catalogEntry } : {}),
    agentDefinitionsById: new Map([[provider.id, provider]]),
    agentRuntimeDefinitionsById: new Map([[backend.id, backend]]),
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

describe('engineRegistry (antigravity runtimeCore)', () => {
  it('resolves bundled Antigravity runtime ownership through the plugin backend engine', async () => {
    const contributes = createAntigravityOnlyContributionRegistry();
    const activationTarget = contributes.activationTargets[0];
    expect({
      activationDaemonEntryPath: activationTarget?.daemonEntryPath,
      bundledPackageNamesIncludeAntigravity: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES.includes('@happier-dev/plugins-antigravity'),
    }).toEqual({
      activationDaemonEntryPath: '@happier-dev/plugins-antigravity',
      bundledPackageNamesIncludeAntigravity: true,
    });

    const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
      contributes,
      pluginIds: [ANTIGRAVITY_PLUGIN_ID],
    });

    expect({
      engines: [...runtimeRegistry.agentRuntimesByAgentId.entries()].map(([backendId, entry]) => ({
        backendId,
        pluginId: entry.pluginId,
      })),
      diagnostics: runtimeRegistry.pluginDiagnosticsByPluginId,
    }).toEqual({
      engines: [{
        backendId: ANTIGRAVITY_BACKEND_ID,
        pluginId: ANTIGRAVITY_PLUGIN_ID,
      }],
      diagnostics: {
        [ANTIGRAVITY_PLUGIN_ID]: [],
      },
    });

    const resolution = await resolveBackendEngineAdapterResolution(ANTIGRAVITY_BACKEND_ID, {
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
        backendId: ANTIGRAVITY_BACKEND_ID,
        selected: {
          kind: 'plugin_engine',
          ownerId: ANTIGRAVITY_PLUGIN_ID,
          provenance: 'first_party',
          pluginId: ANTIGRAVITY_PLUGIN_ID,
        },
        candidates: [{
          kind: 'plugin_engine',
          ownerId: ANTIGRAVITY_PLUGIN_ID,
          provenance: 'first_party',
          pluginId: ANTIGRAVITY_PLUGIN_ID,
        }],
      },
      diagnostics: [],
      backendPluginId: ANTIGRAVITY_PLUGIN_ID,
      backendDaemonEntryPath: '@happier-dev/plugins-antigravity',
    });

    const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
      credentials: createTestCredentials(),
      directory: '/tmp/antigravity',
      permissionMode: 'default',
      metadata: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: ANTIGRAVITY_BACKEND_ID,
          provider: { runtimeMode: 'cliPrint' },
        },
      },
    });

    expect(plan).toMatchObject({
      kind: 'hostSessionRuntimePlan',
      agentId: ANTIGRAVITY_BACKEND_ID,
      config: {
        providerName: 'Antigravity CLI',
        agentMessageType: ANTIGRAVITY_BACKEND_ID,
      },
    });
    expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));
  });
});
