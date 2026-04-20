import {
  getAgentAuthProbeConfig,
  isAgentId,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import type { CatalogAgentLookupId } from '@/backends/types';

import type { CliDetectSpec } from '@/backends/types';

export function createBuiltInCliDetect(agentId: CatalogAgentLookupId): CliDetectSpec {
  const authConfig = isAgentId(agentId)
    ? getAgentAuthProbeConfig(agentId)
    : legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)
      ? legacyCustomAcpCompat.getLegacyCustomAcpAgentAuthProbeConfig()
      : null;
  if (!authConfig) {
    throw new Error(`Unsupported built-in CLI detect lookup id '${agentId}'`);
  }

  return {
    versionArgsToTry: [['--version'], ['version'], ['-v']],
    loginStatusArgs: authConfig.statusCommand ?? null,
  };
}
