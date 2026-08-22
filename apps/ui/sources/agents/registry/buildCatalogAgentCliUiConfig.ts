import { getAgentLocalCliConfig, type BundledAgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from '@/agents/registry/registryCore';

import { buildAgentCliInstallBanner } from './buildAgentCliInstallBanner';

export function buildCatalogAgentCliUiConfig(
  agentId: BundledAgentId,
): AgentCoreConfig['cli'] {
  const localCliConfig = getAgentLocalCliConfig(agentId);

  return {
    detectKey: localCliConfig.detectKey,
    machineLoginKey: localCliConfig.machineLoginKey,
    installBanner: buildAgentCliInstallBanner(agentId),
    spawnAgent: agentId,
  };
}
