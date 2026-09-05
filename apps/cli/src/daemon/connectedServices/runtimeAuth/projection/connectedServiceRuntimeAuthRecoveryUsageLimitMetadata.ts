import { ConnectedServiceIdSchema, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SessionUsageLimitRecoveryV1Schema, type SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import type { RuntimeAuthRecoveryIntent } from '../RuntimeAuthRecoveryScheduler';

/** Presentation of the daemon's recovery intent, never a second recovery decision. */
export function buildRuntimeAuthUsageLimitRecoveryMetadataUpdater(input: Readonly<{
  intent: RuntimeAuthRecoveryIntent;
}>): ((metadata: Record<string, unknown>) => Record<string, unknown>) | null {
  const intent = input.intent;
  const attemptId = intent.attemptId;
  const service = ConnectedServiceIdSchema.safeParse(intent.classification.serviceId);
  if (intent.classification.kind !== 'usage_limit' || !attemptId || !intent.profileId || !service.success) return null;
  const status: SessionUsageLimitRecoveryV1['status'] = intent.status === 'recovered'
    ? 'paused'
    : intent.status === 'resumed_awaiting_proof' ? 'waiting' : intent.status;
  const selectedAuth: SessionUsageLimitRecoveryV1['selectedAuth'] = intent.groupId
    ? { kind: 'group', serviceId: service.data, groupId: intent.groupId, profileId: intent.profileId }
    : { kind: 'profile', serviceId: service.data, profileId: intent.profileId };
  return (metadata) => {
    const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
    const current = parsed.success ? parsed.data : null;
    // A delayed visible-event delivery must not replace a newer attempt or undo Stop.
    if (current && (current.armedAtMs > intent.armedAtMs || (
      current.runtimeAuthRecoveryAttemptId === intent.attemptId
      && current.status === 'cancelled' && status !== 'cancelled'
    ))) return metadata;
    const sameAttempt = current?.runtimeAuthRecoveryAttemptId === intent.attemptId;
    return {
      ...metadata,
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
        v: 1, status,
        issueFingerprint: sameAttempt && current ? current.issueFingerprint : attemptId,
        runtimeAuthRecoveryAttemptId: attemptId,
        armedAtMs: intent.armedAtMs,
        resetAtMs: intent.classification.resetsAtMs ?? null,
        nextCheckAtMs: status === 'cancelled' || status === 'exhausted' || status === 'paused' ? null : intent.nextRetryAtMs,
        attemptCount: intent.attemptCount, maxAttempts: intent.maxAttempts,
        lastProbeError: intent.lastError,
        resumePromptMode: intent.resumePromptMode ?? 'standard', selectedAuth,
        ...(sameAttempt && current?.recoveryCredits ? { recoveryCredits: current.recoveryCredits } : {}),
      } satisfies SessionUsageLimitRecoveryV1,
    };
  };
}
