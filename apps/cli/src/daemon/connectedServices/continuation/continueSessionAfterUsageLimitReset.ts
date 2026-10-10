import {
  ConnectedServiceBindingsV1Schema,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { buildUsageLimitIssueFingerprint } from '@/session/usageLimitRecoveryControls/buildUsageLimitIssueFingerprint';
import { hasSameUsageLimitRecoveryIdentity } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';
import { readLatestUsageLimitFailureIssue } from '@/session/usageLimitRecoveryControls/readLatestUsageLimitFailureIssue';
import { resolveUsageLimitRecoverySelectedAuthFromIssue } from '@/session/usageLimitRecoveryControls/usageLimitRecoverySelectedAuth';

import { createConnectedServiceContinuationMessageDispatcher } from './createConnectedServiceContinuationMessageDispatcher';

export type UsageLimitContinuationResult = Readonly<{
  status: 'continued' | 'suppressed' | 'disabled' | 'superseded' | 'not_ready' | 'runtime_unavailable';
}>;

function matchesAuth(left: SessionUsageLimitRecoveryV1['selectedAuth'], right: SessionUsageLimitRecoveryV1['selectedAuth']): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'native' && right.kind === 'native') {
    return !left.serviceId || !right.serviceId || left.serviceId === right.serviceId;
  }
  if (left.serviceId !== right.serviceId) return false;
  if (left.kind === 'profile' && right.kind === 'profile') return left.profileId === right.profileId;
  return left.kind === 'group' && right.kind === 'group'
    && left.groupId === right.groupId && left.profileId === right.profileId;
}

function matchesCurrentBinding(metadata: Record<string, unknown>, auth: SessionUsageLimitRecoveryV1['selectedAuth']): boolean {
  if (metadata.connectedServices === undefined) return auth.kind === 'native';
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(metadata.connectedServices);
  if (!parsed.success) return false;
  if (auth.kind === 'native') {
    return auth.serviceId
      ? parsed.data.bindingsByServiceId[auth.serviceId]?.source !== 'connected'
      : !Object.values(parsed.data.bindingsByServiceId).some((binding) => binding.source === 'connected');
  }
  const binding = parsed.data.bindingsByServiceId[auth.serviceId];
  if (binding?.source !== 'connected') return false;
  return auth.kind === 'profile'
    ? binding.selection === 'profile' && binding.profileId === auth.profileId
    : binding.selection === 'group' && binding.groupId === auth.groupId
      && (binding.profileId === undefined || binding.profileId === auth.profileId);
}

function isTerminal(recovery: SessionUsageLimitRecoveryV1): boolean {
  // Unowned backoff controls project ready as paused; daemon-owned paused means recovered.
  return recovery.status === 'cancelled' || recovery.status === 'exhausted'
    || (recovery.status === 'paused' && Boolean(recovery.runtimeAuthRecoveryAttemptId));
}

export async function continueSessionAfterUsageLimitReset(input: Readonly<{
  credentials: Credentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  recovery: SessionUsageLimitRecoveryV1;
  customResumePrompt?: string | null;
  nowMs: number;
  isCurrent: () => boolean | Promise<boolean>;
  ensureRuntime: () => Promise<boolean>;
  sendMessage?: typeof sendSessionMessage;
}>): Promise<UsageLimitContinuationResult> {
  const recovery = input.recovery;
  if (isTerminal(recovery) || !(await input.isCurrent())) return { status: 'superseded' };
  const currentValue = input.metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY];
  const currentParsed = SessionUsageLimitRecoveryV1Schema.safeParse(currentValue);
  if (currentValue !== undefined && !currentParsed.success) return { status: 'superseded' };
  if (currentParsed.success) {
    const current = currentParsed.data;
    if (isTerminal(current) || !hasSameUsageLimitRecoveryIdentity(current, recovery) || current.resetAtMs !== recovery.resetAtMs
      || !matchesAuth(current.selectedAuth, recovery.selectedAuth)) return { status: 'superseded' };
    if (current.resumePromptMode === 'off') return { status: 'disabled' };
  }
  if (recovery.resumePromptMode === 'off') return { status: 'disabled' };

  const issue = input.rawSession.latestTurnStatus === 'failed'
    ? readLatestUsageLimitFailureIssue(input.rawSession) : null;
  if (!issue?.usageLimit || input.rawSession.archivedAt != null
    || issue.usageLimit.recoverability === 'manual' || issue.usageLimit.recoverability === 'switch_account'
    || issue.usageLimit.resetAtMs !== recovery.resetAtMs
    || !matchesCurrentBinding(input.metadata, recovery.selectedAuth)) return { status: 'superseded' };
  const failedAuth = resolveUsageLimitRecoverySelectedAuthFromIssue({ issue, connectedServices: input.metadata.connectedServices ?? null });
  if (!failedAuth || !matchesAuth(failedAuth, recovery.selectedAuth)) return { status: 'superseded' };

  const fingerprint = buildUsageLimitIssueFingerprint(issue);
  const owned = Boolean(recovery.runtimeAuthRecoveryAttemptId);
  // Rearming allocates a new lifecycle epoch; the fingerprint still identifies the failed issue.
  if (issue.occurredAt > recovery.armedAtMs || (!owned && fingerprint !== recovery.issueFingerprint)) return { status: 'superseded' };
  const interruptedOriginId = issue.providerTurnId
    ?? input.rawSession.latestTurnId
    ?? (fingerprint === recovery.issueFingerprint ? fingerprint : null);
  if (!interruptedOriginId) return { status: 'superseded' };

  // A manual daemon-owned retry is authorized by the provider reset; local backoff only schedules wakes.
  const dueAtMs = owned ? recovery.resetAtMs : recovery.nextCheckAtMs ?? recovery.resetAtMs
    ?? (recovery.status === 'paused' ? input.nowMs : null);
  if (dueAtMs === null || input.nowMs < dueAtMs) return { status: 'not_ready' };
  const dispatcher = createConnectedServiceContinuationMessageDispatcher({
    credentials: input.credentials, sendMessage: input.sendMessage,
  });
  const enqueued = await dispatcher.enqueueInterruptedOriginContinuation({
    sessionId: input.sessionId,
    attemptId: recovery.runtimeAuthRecoveryAttemptId ?? JSON.stringify([recovery.issueFingerprint, recovery.armedAtMs]),
    interruptedOriginId,
    interruption: 'provider_failed_turn',
    resumePromptMode: recovery.resumePromptMode,
    customResumePrompt: input.customResumePrompt,
    recoveryKind: 'usage_limit',
    isCurrent: async ({ rawSession, metadata }) => {
      if (!(await input.isCurrent()) || rawSession.latestTurnStatus !== 'failed' || rawSession.archivedAt != null || !metadata
        || rawSession.latestTurnId !== input.rawSession.latestTurnId) return false;
      const freshIssue = readLatestUsageLimitFailureIssue(rawSession);
      if (!freshIssue || buildUsageLimitIssueFingerprint(freshIssue) !== fingerprint || !matchesCurrentBinding(metadata, recovery.selectedAuth)) return false;
      const source = issue.usageLimit?.connectedService;
      const freshSource = freshIssue.usageLimit?.connectedService;
      if (source?.serviceId !== freshSource?.serviceId || source?.profileId !== freshSource?.profileId
        || source?.groupId !== freshSource?.groupId) return false;
      const current = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
      return (!current.success && metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] === undefined)
        || (current.success && !isTerminal(current.data) && (owned || current.data.resumePromptMode !== 'off')
        && current.data.armedAtMs <= recovery.armedAtMs
        && (!current.data.runtimeAuthRecoveryAttemptId || current.data.runtimeAuthRecoveryAttemptId === recovery.runtimeAuthRecoveryAttemptId));
    },
  });
  if (!(await input.isCurrent())) return { status: 'superseded' };
  if (enqueued.status === 'suppressed_newer_user_input') return { status: 'suppressed' };
  if (enqueued.status !== 'enqueued') return { status: 'disabled' };
  // Pending owns the wake. Canonical ensure adopts a healthy runner or resumes an absent one;
  // the server's active projection can outlive a local process.
  if (!(await input.ensureRuntime())) return { status: 'runtime_unavailable' };
  return { status: 'continued' };
}
