import { getAgentLocalCliConfig, type AgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from '@/agents/registry/registryCore';

import { buildProviderCliInstallBanner } from './buildProviderCliInstallBanner';

export function buildCatalogProviderCliUiConfig(
  agentId: AgentId,
): AgentCoreConfig['cli'] {
  const localCliConfig = getAgentLocalCliConfig(agentId);

  return {
    detectKey: localCliConfig.detectKey,
    machineLoginKey: localCliConfig.machineLoginKey,
    installBanner: buildProviderCliInstallBanner(agentId),
    spawnAgent: agentId,
  };
}
