import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from '../../../plugins/projection/registry/types';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const QWEN_BACKEND_ID = 'qwen';
const QWEN_PLUGIN_ID = 'happier.agent.qwen';

function createQwenOnlyContributionRegistry(): ResolvedContributionRegistry {
  const builtInContributions = resolveBuiltInContributions();
  const provider = builtInContributions.providers.find((entry) => entry.id === QWEN_BACKEND_ID);
  const backend = builtInContributions.backends.find((entry) => entry.id === QWEN_BACKEND_ID);
  const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === QWEN_PLUGIN_ID) ?? [];

  if (!provider || !backend || activationTargets.length !== 1) {
    throw new Error('Expected generated Qwen provider, backend, and activation target contributions');
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

describe('engineRegistry (qwen runtimeCore)', () => {
  it('resolves the bundled Qwen ACP plugin runtimeCore through production dispatch', async () => {
    const contributes = createQwenOnlyContributionRegistry();
    const resolution = await resolveBackendEngineAdapterResolution('qwen', {
      contributes,
    });

    expect(resolution).toMatchObject({
      backendId: 'qwen',
      providerId: 'qwen',
      selectedSource: 'plugin',
      backend: {
        pluginId: 'happier.agent.qwen',
        daemonEntryPath: '@happier-dev/plugins-qwen',
      },
    });

    const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
      credentials: createTestCredentials(),
      directory: '/tmp/qwen',
      permissionMode: 'safe-yolo',
    });

    expect(plan).toMatchObject({
      kind: 'hostSessionRuntimePlan',
      providerId: 'qwen',
      config: {
        backendDisplayName: 'Qwen Code',
        providerName: 'Qwen Code',
        agentMessageType: 'qwen',
      },
    });
    expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));
  });
});
