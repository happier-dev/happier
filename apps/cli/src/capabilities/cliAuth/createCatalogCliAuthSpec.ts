import {
  getAgentCliRuntimeSpec,
  isAgentId,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';

import type { CliAuthSpec } from './types';

function resolveAgentCliRuntimeSpecForLookupId(agentId: CatalogAgentLookupId) {
  if (isAgentId(agentId)) {
    return getAgentCliRuntimeSpec(agentId);
  }
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec();
  }
  throw new Error(`Unsupported provider CLI runtime lookup id '${agentId}'`);
}

export function createCatalogCliAuthSpec(
  agentId: CatalogAgentLookupId,
  spec: Omit<CliAuthSpec, 'binaryNames'>,
): CliAuthSpec {
  return {
    binaryNames: [resolveAgentCliRuntimeSpecForLookupId(agentId).binaryName],
    ...spec,
  };
}
