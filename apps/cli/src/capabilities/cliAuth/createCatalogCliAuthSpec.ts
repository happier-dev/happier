import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { resolveAgentCliRuntimeSpecForLookupId } from '@/packagedRuntime/managedTools/requireAgentCliCommand';

import type { CliAuthSpec } from './types';

export function createCatalogCliAuthSpec(
  agentId: CatalogAgentLookupId,
  spec: Omit<CliAuthSpec, 'binaryNames'>,
): CliAuthSpec {
  return {
    binaryNames: [resolveAgentCliRuntimeSpecForLookupId(agentId).binaryName],
    ...spec,
  };
}
