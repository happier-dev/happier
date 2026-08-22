import {
  TranscriptRawAgentEventV1Schema,
} from '@happier-dev/protocol';

import type { DaemonSessionMutationCustody } from '../usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';

import type { ConnectedServiceQuotaLifecycleTransition } from './ConnectedServiceQuotasCoordinator';
import { buildQuotaLifecycleTranscriptEventId } from './quotaLifecycleEventIdentity';

function buildQuotaLifecycleTranscriptEvent(
  transition: ConnectedServiceQuotaLifecycleTransition,
): unknown | null {
  if (transition.phase === 'blocked') {
    if (typeof transition.resetAtMs !== 'number' || !Number.isFinite(transition.resetAtMs) || transition.resetAtMs < 0) {
      return null;
    }
    return {
      type: 'agent-quota-wait',
      serviceId: transition.serviceId,
      ...(transition.activeProfileId ? { profileId: transition.activeProfileId } : {}),
      groupId: transition.groupId,
      resetAtMs: Math.trunc(transition.resetAtMs),
      reason: transition.reason,
    };
  }
  return {
    type: 'agent-quota-recovered',
    serviceId: transition.serviceId,
    ...(transition.activeProfileId ? { profileId: transition.activeProfileId } : {}),
    groupId: transition.groupId,
    reason: transition.reason,
  };
}

export async function commitConnectedServiceQuotaLifecycleSessionEvents(params: Readonly<{
  mutationCustody: Pick<DaemonSessionMutationCustody, 'stageTranscriptEvent'>;
  transition: ConnectedServiceQuotaLifecycleTransition;
}>): Promise<void> {
  const rawEvent = buildQuotaLifecycleTranscriptEvent(params.transition);
  if (rawEvent === null) return;
  const parsedEvent = TranscriptRawAgentEventV1Schema.safeParse(rawEvent);
  if (!parsedEvent.success) return;

  const eventId = buildQuotaLifecycleTranscriptEventId({
    eventType: parsedEvent.data.type,
    issueFingerprint: params.transition.issueFingerprint || `${params.transition.serviceId}:${params.transition.groupId}`,
    resetAtMs: params.transition.resetAtMs,
    cycleId: params.transition.cycleId,
    reason: params.transition.reason,
  });
  await Promise.all(params.transition.sessionIds.map(async (sessionId) => {
    await params.mutationCustody.stageTranscriptEvent({
      sessionId,
      eventId,
      data: parsedEvent.data,
    });
  }));
}
