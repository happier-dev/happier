import { getAgentLocalCliConfig, type BundledAgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from '@/agents/registry/registryCore';

import { buildAgentCliInstallBanner } from './buildAgentCliInstallBanner';

export function buildCatalogAgentCliUiConfig(
  agentId: BundledAgentId,
): AgentCoreConfig['cli'] {
  const localCliConfig = getAgentLocalCliConfig(agentId);
  if (!localCliConfig) return null;
  const installBanner = buildAgentCliInstallBanner(agentId);
  if (!installBanner) return null;

  return {
    detectKey: localCliConfig.detectKey,
    machineLoginKey: localCliConfig.machineLoginKey,
    installBanner,
    spawnAgent: agentId,
  };
}
