import { getAgentAuthProbeConfig, type AgentId } from '@happier-dev/agents';

import type { CliDetectSpec } from '@/backends/types';

export function createCatalogDefinedCliDetect(agentId: AgentId): CliDetectSpec {
  const authConfig = getAgentAuthProbeConfig(agentId);

  return {
    versionArgsToTry: [['--version'], ['version'], ['-v']],
    loginStatusArgs: authConfig.statusCommand ?? null,
  };
}
