import {
  getAgentAuthProbeConfig,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import type { CatalogAgentLookupId } from '@/agent/catalog/types';

import type { CliDetectSpec } from '@/agent/catalog/types';

export function createBuiltInCliDetect(agentId: CatalogAgentLookupId): CliDetectSpec {
  const authConfig = getAgentAuthProbeConfig(agentId)
    ?? (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)
      ? legacyCustomAcpCompat.getLegacyCustomAcpAgentAuthProbeConfig()
      : null);
  if (!authConfig) {
    throw new Error(`Unsupported built-in CLI detect lookup id '${agentId}'`);
  }

  return {
    versionArgsToTry: [['--version'], ['version'], ['-v']],
    loginStatusArgs: authConfig.statusCommand ?? null,
  };
}
