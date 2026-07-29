import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from '../../../plugins/projection/registry/types';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const KIMI_BACKEND_ID = 'kimi';
const KIMI_PLUGIN_ID = 'happier.agent.kimi';

function createKimiOnlyContributionRegistry(): ResolvedContributionRegistry {
  const builtInContributions = resolveBuiltInContributions();
  const agentContribution = builtInContributions.agents.find((entry) => entry.id === KIMI_BACKEND_ID);
  const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === KIMI_PLUGIN_ID) ?? [];

  if (!agentContribution || activationTargets.length !== 1) {
    throw new Error('Expected generated Kimi Agent and activation target contributions');
  }

  return {
    agents: Object.freeze([agentContribution]),
        actions: Object.freeze([]),
    resources: Object.freeze([]),
    uiViewsV2: Object.freeze([]),
    uiRenderersV2: Object.freeze([]),
    uiTranslationsV2: Object.freeze([]),
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
        catalogEntriesById: Object.freeze(agentContribution.catalogEntry ? { [agentContribution.catalogEntry.id]: agentContribution.catalogEntry } : {}),
    agentDefinitionsById: new Map([[agentContribution.id, agentContribution]]),
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
