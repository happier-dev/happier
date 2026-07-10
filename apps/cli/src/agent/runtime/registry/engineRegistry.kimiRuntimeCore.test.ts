import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from '../../../plugins/projection/registry/types';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const KIMI_BACKEND_ID = 'kimi';
const KIMI_PLUGIN_ID = 'happier.agent.kimi';

function createKimiOnlyContributionRegistry(): ResolvedContributionRegistry {
  const builtInContributions = resolveBuiltInContributions();
  const provider = builtInContributions.agents.find((entry) => entry.id === KIMI_BACKEND_ID);
  const backend = builtInContributions.agentRuntimes.find((entry) => entry.id === KIMI_BACKEND_ID);
  const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === KIMI_PLUGIN_ID) ?? [];

  if (!provider || !backend || activationTargets.length !== 1) {
    throw new Error('Expected generated Kimi provider, backend, and activation target contributions');
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

describe('engineRegistry (kimi runtimeCore)', () => {
  it('resolves the bundled Kimi ACP plugin runtimeCore through production dispatch', async () => {
    const contributes = createKimiOnlyContributionRegistry();
    const resolution = await resolveBackendEngineAdapterResolution('kimi', {
      contributes,
    });

    expect(resolution).toMatchObject({
      backendId: 'kimi',
      agentId: 'kimi',
      selectedSource: 'plugin',
      backend: {
        pluginId: 'happier.agent.kimi',
        daemonEntryPath: '@happier-dev/plugins-kimi',
      },
    });

    const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
      credentials: createTestCredentials(),
      directory: '/tmp/kimi',
      permissionMode: 'read-only',
    });

    expect(plan).toMatchObject({
      kind: 'hostSessionRuntimePlan',
      agentId: 'kimi',
      config: {
        backendDisplayName: 'Kimi',
        providerName: 'Kimi',
        agentMessageType: 'kimi',
      },
    });
    expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));
  });
});
