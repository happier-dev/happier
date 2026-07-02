import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from '../../../plugins/projection/registry/types';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const AUGGIE_BACKEND_ID = 'auggie';
const AUGGIE_PLUGIN_ID = 'happier.agent.auggie';

function createAuggieOnlyContributionRegistry(): ResolvedContributionRegistry {
  const builtInContributions = resolveBuiltInContributions();
  const provider = builtInContributions.providers.find((entry) => entry.id === AUGGIE_BACKEND_ID);
  const backend = builtInContributions.backends.find((entry) => entry.id === AUGGIE_BACKEND_ID);
  const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === AUGGIE_PLUGIN_ID) ?? [];

  if (!provider || !backend || activationTargets.length !== 1) {
    throw new Error('Expected generated Auggie provider, backend, and activation target contributions');
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

describe('engineRegistry (auggie runtimeCore)', () => {
  it('resolves the bundled Auggie ACP plugin runtimeCore through production dispatch', async () => {
    const contributes = createAuggieOnlyContributionRegistry();
    const resolution = await resolveBackendEngineAdapterResolution('auggie', {
      contributes,
    });

    expect(resolution).toMatchObject({
      backendId: 'auggie',
      providerId: 'auggie',
      selectedSource: 'plugin',
      backend: {
        pluginId: 'happier.agent.auggie',
        daemonEntryPath: '@happier-dev/plugins-auggie',
      },
    });

    const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
      credentials: createTestCredentials(),
      directory: '/tmp/auggie',
      permissionMode: 'safe-yolo',
    });

    expect(plan).toMatchObject({
      kind: 'hostSessionRuntimePlan',
      providerId: 'auggie',
      config: {
        backendDisplayName: 'Auggie',
        providerName: 'Auggie',
        agentMessageType: 'auggie',
      },
    });
    expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));
  });
});
