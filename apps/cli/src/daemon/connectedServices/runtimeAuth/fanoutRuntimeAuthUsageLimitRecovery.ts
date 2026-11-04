import { ConnectedServiceIdSchema } from '@happier-dev/protocol';
import type { ConnectedServiceQuotasCoordinator } from '../quotas/ConnectedServiceQuotasCoordinator';
import { resolveCommittedGenerationFromRuntimeAuthRecovery } from '../sessionAuthSwitch/resolveCommittedGenerationFromRuntimeAuthRecovery';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

/** Carry the committed recovery decision through the canonical sibling-generation consumer. */
export async function fanoutRuntimeAuthUsageLimitRecovery(input: Readonly<{
  sessionId: string;
  classification: ConnectedServiceRuntimeFailureClassification;
  recovery: unknown;
  quotaCoordinator: ConnectedServiceQuotasCoordinator | null;
  supersedingSourceConverged: boolean;
}>): Promise<Awaited<ReturnType<ConnectedServiceQuotasCoordinator['recordRuntimeUsageLimitExhaustionAndFanout']>> | null> {
  const classification = input.classification;
  if (classification.kind !== 'usage_limit'
    || !classification.groupId?.trim() || !classification.profileId?.trim()) return null;
  const serviceId = ConnectedServiceIdSchema.safeParse(classification.serviceId);
  if (!serviceId.success || !input.quotaCoordinator) return null;
  const committedRecovery = resolveCommittedGenerationFromRuntimeAuthRecovery({
    serviceId: serviceId.data, groupId: classification.groupId, recovery: input.recovery,
  });
  return await input.quotaCoordinator.recordRuntimeUsageLimitExhaustionAndFanout({
    sourceSessionId: input.sessionId,
    serviceId: serviceId.data,
    groupId: classification.groupId,
    exhaustedProfileId: classification.profileId,
    resetAtMs: classification.resetsAtMs,
    sourceGroupGeneration: classification.groupGeneration ?? null,
    sourceProviderAccountId: classification.sourceProviderAccountId ?? null,
    sourceAccountLabel: classification.sourceAccountLabel ?? null,
    committedGeneration: committedRecovery?.committedGeneration ?? null,
    sourceRequiresConvergence: (committedRecovery?.sourceRequiresConvergence ?? false) && !input.supersedingSourceConverged,
  });
}
