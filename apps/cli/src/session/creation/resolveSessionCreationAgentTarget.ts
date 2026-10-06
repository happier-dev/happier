import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AgentExecutionTargetV1, BackendTargetRefV2 } from '@happier-dev/protocol';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import {
  indexAgentRoutingIdsByContributionIdentity,
  readAgentRoutingIdForContributionIdentity,
} from '@/plugins/projection/registry/agentRoutingIdentity';

/** Canonical installed-Agent projection shared by every authored Session creator. */
export function resolveSessionCreationAgentTarget(agentTarget: AgentExecutionTargetV1): Readonly<{
  agentId: string;
  backendTarget: BackendTargetRefV2;
}> | null {
  const catalog = readAgentCatalogSnapshot();
  const agentId = readAgentRoutingIdForContributionIdentity(
    indexAgentRoutingIdsByContributionIdentity([...catalog.agentDefinitionsById.values()]),
    agentTarget.identity,
  );
  const agentContribution = agentId ? catalog.agentDefinitionsById.get(agentId) : null;
  if (!agentContribution) return null;

  try {
    return {
      agentId: agentContribution.id,
      backendTarget: readBackendTargetRefV2({
        kind: 'backend',
        backendId: agentContribution.id,
        sourceKind: 'built_in',
      }),
    };
  } catch {
    return null;
  }
}
