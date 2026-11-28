import type { ExecutionRunProfileDescriptor } from '@happier-dev/protocol/plugins/contributions/executionRunProfiles';
import {
  evaluateContributionAvailability,
  resolveInvocationContributionPolicyFacts,
} from '@/plugins/runtime/policy/evaluate';

import { listExecutionRunProfileContributionDescriptors, type ExecutionRunProfileContributionCatalog } from './intentRegistry';

export function projectExecutionRunProfileDescriptors(
  catalog: ExecutionRunProfileContributionCatalog,
  sessionId: string | null,
): readonly ExecutionRunProfileDescriptor[] {
  return listExecutionRunProfileContributionDescriptors(catalog)
    .flatMap((profile) => {
      const compatibleAgentIds = profile.compatibleAgents.map((reference) => (
        typeof reference === 'string' ? reference : reference.localId
      ));
      const decision = profile.availability
        ? evaluateContributionAvailability({
            availability: profile.availability,
            facts: resolveInvocationContributionPolicyFacts({
              ...(sessionId ? { sessionId } : {}),
              facts: {
                ...(compatibleAgentIds[0] ? { 'session.agentId': compatibleAgentIds[0] } : {}),
              },
            }),
          })
        : { outcome: 'visible' as const, code: 'plugin_contribution_visible' };
      if (decision.outcome === 'hidden') return [];
      return [{
        ...profile,
        compatibleAgents: compatibleAgentIds,
        available: decision.outcome === 'visible',
        ...(decision.outcome === 'visible' ? {} : { unavailableCode: decision.code }),
      }];
    });
}
