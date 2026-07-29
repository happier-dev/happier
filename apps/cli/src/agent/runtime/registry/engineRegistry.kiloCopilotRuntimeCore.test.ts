import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from '../../../plugins/projection/registry/types';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

type StageETier2Agent = Readonly<{
  backendId: 'kilo' | 'copilot';
  pluginId: string;
  packageName: string;
  displayName: string;
}>;

const STAGE_E_TIER2_AGENTS: readonly StageETier2Agent[] = Object.freeze([
  {
    backendId: 'kilo',
    pluginId: 'happier.agent.kilo',
    packageName: '@happier-dev/plugins-kilo',
    displayName: 'Kilo CLI',
  },
  {
    backendId: 'copilot',
    pluginId: 'happier.agent.copilot',
    packageName: '@happier-dev/plugins-copilot',
    displayName: 'GitHub Copilot CLI',
  },
]);

function createContributionRegistry(agent: StageETier2Agent): ResolvedContributionRegistry {
  const builtInContributions = resolveBuiltInContributions();
  const agentContribution = builtInContributions.agents.find((entry) => entry.id === agent.backendId);
  const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === agent.pluginId) ?? [];

  if (!agentContribution || activationTargets.length !== 1) {
    throw new Error(`Expected generated ${agent.backendId} Agent and activation target contributions`);
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

describe('engineRegistry (Kilo/Copilot runtimeCore)', () => {
  it.each(STAGE_E_TIER2_AGENTS)(
    'resolves bundled $backendId ACP plugin runtimeCore through production dispatch',
    async (agent) => {
      const contributes = createContributionRegistry(agent);
      const resolution = await resolveBackendEngineAdapterResolution(agent.backendId, {
        contributes,
      });

      expect(resolution).toMatchObject({
        backendId: agent.backendId,
        agentId: agent.backendId,
        selectedSource: 'plugin',
        backend: {
          pluginId: agent.pluginId,
          daemonEntryPath: agent.packageName,
        },
      });

      const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
        credentials: createTestCredentials(),
        directory: `/tmp/${agent.backendId}`,
        permissionMode: 'safe-yolo',
      });

      expect(plan).toMatchObject({
        kind: 'hostSessionRuntimePlan',
        agentId: agent.backendId,
        config: {
          backendDisplayName: agent.displayName,
          providerName: agent.displayName,
          agentMessageType: agent.backendId,
        },
      });
      expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));
    },
  );
});
