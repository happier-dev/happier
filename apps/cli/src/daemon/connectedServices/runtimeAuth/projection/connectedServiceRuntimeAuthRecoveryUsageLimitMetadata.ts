import { readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import type { RuntimeAuthRecoveryIntent } from '../RuntimeAuthRecoveryScheduler';

/** Presentation only; the existing usage-limit field merge owns arrival-time arbitration. */
export function buildRuntimeAuthUsageLimitRecoveryProjection(
  intent: RuntimeAuthRecoveryIntent,
): SessionUsageLimitRecoveryV1 | null {
  const attemptId = intent.attemptId;
  const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(intent.classification.serviceId);
  if (intent.classification.kind !== 'usage_limit' || !attemptId || !intent.profileId || !serviceId) return null;
  const status: SessionUsageLimitRecoveryV1['status'] = intent.status === 'recovered'
    ? 'paused'
    : intent.status === 'resumed_awaiting_proof' ? 'waiting' : intent.status;
  return {
    v: 1,
    status,
    issueFingerprint: attemptId,
    runtimeAuthRecoveryAttemptId: attemptId,
    armedAtMs: intent.armedAtMs,
    resetAtMs: intent.classification.resetsAtMs ?? null,
    nextCheckAtMs: status === 'cancelled' || status === 'exhausted' || status === 'paused' ? null : intent.nextRetryAtMs,
    attemptCount: intent.attemptCount,
    maxAttempts: intent.maxAttempts,
    lastProbeError: intent.lastError,
    resumePromptMode: intent.resumePromptMode ?? 'standard',
    selectedAuth: intent.groupId
      ? { kind: 'group', serviceId, groupId: intent.groupId, profileId: intent.profileId }
      : { kind: 'profile', serviceId, profileId: intent.profileId },
  };
}
