import { getAgentLocalCliConfig, type AgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from '@/agents/registry/registryCore';

import { buildAgentCliInstallBanner } from './buildAgentCliInstallBanner';

export function buildCatalogAgentCliUiConfig(
  agentId: AgentId,
): AgentCoreConfig['cli'] {
  const localCliConfig = getAgentLocalCliConfig(agentId);

  return {
    detectKey: localCliConfig.detectKey,
    machineLoginKey: localCliConfig.machineLoginKey,
    installBanner: buildAgentCliInstallBanner(agentId),
    spawnAgent: agentId,
  };
}
