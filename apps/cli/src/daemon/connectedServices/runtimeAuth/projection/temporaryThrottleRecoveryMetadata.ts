import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY as key, SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import {
  hasSameUsageLimitRecoveryIdentity,
  mergeUsageLimitRecoveryIntent,
} from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';
type ThrottleProjectionIntent = Readonly<{
  issueFingerprint: string; armedAtMs: number;
  status: 'waiting' | 'checking' | 'awaiting_outcome' | 'cancelled' | 'exhausted';
  serviceId?: string; profileId?: string | null; groupId?: string | null;
  nextRetryAtMs: number | null; resetAtMs: number | null;
  attemptCount: number; capacityFailureCount?: number; maxAttempts: number; lastError: string | null;
  continuation: Readonly<{ resumePromptMode: SessionUsageLimitRecoveryV1['resumePromptMode'] }> | null;
}>;
function projectionFingerprint(issueFingerprint: string): string {
  return issueFingerprint.startsWith('temporary-throttle:')
    ? issueFingerprint
    : `temporary-throttle:${issueFingerprint}`;
}
export function projectTemporaryThrottleRecoveryMetadata(
  metadata: Record<string, unknown>, intent: ThrottleProjectionIntent | null,
  previous: ThrottleProjectionIntent | null,
): Record<string, unknown> {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[key]);
  const current = parsed.success ? parsed.data : null;
  if (!intent) {
    if (!previous || !current || !hasSameUsageLimitRecoveryIdentity(current, {
      issueFingerprint: projectionFingerprint(previous.issueFingerprint), armedAtMs: previous.armedAtMs,
    })) return metadata;
    const next = { ...metadata };
    delete next[key];
    return next;
  }
  // Old intents without a selected service cannot truthfully claim native authentication.
  if (!intent.serviceId) return metadata;
  const candidate = SessionUsageLimitRecoveryV1Schema.safeParse({
    v: 1,
    // An unbounded scheduler retains superseded work as an inactive hold,
    // not as evidence that a retry allowance was exhausted.
    status: intent.status === 'exhausted' && intent.maxAttempts === 0
      ? 'paused'
      : intent.status === 'awaiting_outcome' ? 'waiting' : intent.status,
    issueFingerprint: projectionFingerprint(intent.issueFingerprint),
    armedAtMs: intent.armedAtMs,
    resetAtMs: null,
    nextCheckAtMs: intent.status === 'waiting' ? intent.nextRetryAtMs : null,
    attemptCount: intent.attemptCount,
    maxAttempts: intent.maxAttempts,
    lastProbeError: intent.lastError,
    resumePromptMode: intent.continuation?.resumePromptMode ?? 'standard',
    selectedAuth: intent.groupId
      ? { kind: 'group', serviceId: intent.serviceId, groupId: intent.groupId, profileId: intent.profileId ?? null }
      : intent.profileId
        ? { kind: 'profile', serviceId: intent.serviceId, profileId: intent.profileId }
        : { kind: 'native', serviceId: intent.serviceId },
  });
  if (!candidate.success) return metadata;
  const merged = mergeUsageLimitRecoveryIntent(current, candidate.data);
  if (!merged || JSON.stringify(merged) === JSON.stringify(current)) return metadata;
  return { ...metadata, [key]: merged };
}
