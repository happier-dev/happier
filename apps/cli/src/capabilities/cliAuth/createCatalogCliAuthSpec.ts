import {
  getProviderCliRuntimeSpec,
  isAgentId,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import type { CatalogAgentLookupId } from '@/backends/types';

import type { CliAuthSpec } from './types';

function resolveProviderCliRuntimeSpecForLookupId(agentId: CatalogAgentLookupId) {
  if (isAgentId(agentId)) {
    return getProviderCliRuntimeSpec(agentId);
  }
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpProviderCliRuntimeSpec();
  }
  throw new Error(`Unsupported provider CLI runtime lookup id '${agentId}'`);
}

export function createCatalogCliAuthSpec(
  agentId: CatalogAgentLookupId,
  spec: Omit<CliAuthSpec, 'binaryNames'>,
): CliAuthSpec {
  return {
    binaryNames: [resolveProviderCliRuntimeSpecForLookupId(agentId).binaryName],
    ...spec,
  };
}
