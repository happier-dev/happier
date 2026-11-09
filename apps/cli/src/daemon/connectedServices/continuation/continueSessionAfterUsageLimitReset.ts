import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
} from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { hasSameUsageLimitRecoveryIdentity } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';
import { readLatestUsageLimitFailureIssue } from '@/session/usageLimitRecoveryControls/readLatestUsageLimitFailureIssue';
import { resolveUsageLimitRecoverySelectedAuthFromIssue } from '@/session/usageLimitRecoveryControls/usageLimitRecoverySelectedAuth';

import { createConnectedServiceContinuationMessageDispatcher } from './createConnectedServiceContinuationMessageDispatcher';
import { isCurrentUsageLimitRecoveryAccount } from '../runtimeAuth/isCurrentUsageLimitRecoveryAccount';
import type { ConnectedServiceRuntimeFailureClassification } from '../runtimeAuth/types';
import type { ConnectedServiceRuntimeBindingIdentity } from '../runtimeRegistry/target';

export type UsageLimitContinuationResult = Readonly<{
  status: 'continued' | 'suppressed' | 'disabled' | 'superseded' | 'not_ready';
}>;

export async function continueAccountQualifiedSessionAfterUsageLimitReset(input: Readonly<{
  continuation: Parameters<typeof continueSessionAfterUsageLimitReset>[0];
  classification: ConnectedServiceRuntimeFailureClassification;
  readAccount: () => Promise<Readonly<{ providerAccountId: string | null; providerOrganizationId?: string | null; requiresProviderOrganizationId?: boolean; credentialRevision: string | null }> | null>;
  readActiveBinding: () => ConnectedServiceRuntimeBindingIdentity | undefined;
}>): Promise<Readonly<{
  status: 'continuation_enqueued' | 'continuation_cancelled' | 'recovery_superseded';
  credentialRevision?: string | null;
}>> {
  const result = await continueSessionAfterUsageLimitReset({
    ...input.continuation,
    isCurrent: async () => {
      if (!(await input.continuation.isCurrent())) return false;
      const freshAccount = await input.readAccount();
      return Boolean(freshAccount
        && isCurrentUsageLimitRecoveryAccount({ classification: input.classification, ...freshAccount })
        && await input.continuation.isCurrent());
    },
  });
  if (result.status !== 'continued') {
    return result.status === 'suppressed' || result.status === 'disabled'
      ? { status: 'continuation_cancelled' }
      : { status: 'recovery_superseded' };
  }
  const account = await input.readAccount();
  if (!account || !isCurrentUsageLimitRecoveryAccount({ classification: input.classification, ...account })
    || !(await input.continuation.isCurrent())) return { status: 'recovery_superseded' };
  // An incumbent may accept a refresh while Pending is being admitted. Capture its
  // settled binding now; an inactive session instead activates with the qualified row.
  return {
    status: 'continuation_enqueued',
    credentialRevision: input.readActiveBinding()?.credentialRevision ?? account.credentialRevision,
  };
}

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
  const parsed = createStoredReadSchema(ConnectedServiceBindingsV2IngressSchema).safeParse(metadata.connectedServices);
  if (!parsed.success) return false;
  if (auth.kind === 'native') {
    const binding = auth.serviceId ? parsed.data.bindingsByServiceId[auth.serviceId] : undefined;
    return auth.serviceId
      ? !binding || binding.source === 'native'
      : !Object.values(parsed.data.bindingsByServiceId).some((binding) => binding.source !== 'native');
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
  credentials: StoredCredentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  recovery: SessionUsageLimitRecoveryV1;
  resolveResumePromptMode?: () => Promise<SessionUsageLimitRecoveryV1['resumePromptMode']>;
  customResumePrompt?: string | null;
  readiness?: 'provider_ready';
  nowMs: number;
  isCurrent: () => boolean | Promise<boolean>;
}>): Promise<UsageLimitContinuationResult> {
  const recovery = input.recovery;
  if (isTerminal(recovery) || !(await input.isCurrent())) return { status: 'superseded' };
  const currentValue = input.metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY];
  const currentParsed = createStoredReadSchema(SessionUsageLimitRecoveryV1Schema).safeParse(currentValue);
  if (currentValue !== undefined && !currentParsed.success) return { status: 'superseded' };
  if (currentParsed.success) {
    const current = currentParsed.data;
    if (isTerminal(current) || !hasSameUsageLimitRecoveryIdentity(current, recovery) || current.resetAtMs !== recovery.resetAtMs
      || !matchesAuth(current.selectedAuth, recovery.selectedAuth)) return { status: 'superseded' };
    if (current.resumePromptMode === 'off') return { status: 'disabled' };
  }
  if (!input.resolveResumePromptMode && recovery.resumePromptMode === 'off') return { status: 'disabled' };

  const issue = input.rawSession.latestTurnStatus === 'failed'
    ? readLatestUsageLimitFailureIssue(input.rawSession) : null;
  if (!issue?.usageLimit || input.rawSession.id !== input.sessionId || input.rawSession.archivedAt != null
    || issue.usageLimit.recoverability === 'manual' || issue.usageLimit.recoverability === 'switch_account'
    || (issue.usageLimit.resetAtMs !== null && issue.usageLimit.resetAtMs !== recovery.resetAtMs)
    || !matchesCurrentBinding(input.metadata, recovery.selectedAuth)) return { status: 'superseded' };
  const failedAuth = resolveUsageLimitRecoverySelectedAuthFromIssue({ issue, connectedServices: input.metadata.connectedServices ?? null });
  if (!failedAuth || !matchesAuth(failedAuth, recovery.selectedAuth)) return { status: 'superseded' };

  const fallbackAgentId = recovery.issueFingerprint.startsWith('usage-limit:')
    ? recovery.issueFingerprint.split(':', 3)[1] : undefined;
  const fingerprint = buildUsageLimitIssueFingerprint(issue, fallbackAgentId);
  const owned = Boolean(recovery.runtimeAuthRecoveryAttemptId);
  if (issue.occurredAt > recovery.armedAtMs || (!owned && fingerprint !== recovery.issueFingerprint)) return { status: 'superseded' };
  const interruptedOriginId = issue.agentTurnId
    ?? input.rawSession.latestTurnId
    ?? (fingerprint === recovery.issueFingerprint ? fingerprint : null);
  if (!interruptedOriginId) return { status: 'superseded' };
  const dueAtMs = owned ? recovery.resetAtMs : recovery.nextCheckAtMs ?? recovery.resetAtMs
    ?? (recovery.status === 'paused' ? input.nowMs : null);
  if (input.readiness !== 'provider_ready' && (dueAtMs === null || input.nowMs < dueAtMs)) return { status: 'not_ready' };
  // The wait may outlive a policy change. A failed policy read remains retryable
  // through the recovery scheduler rather than silently enabling continuation.
  const resumePromptMode = await input.resolveResumePromptMode?.() ?? recovery.resumePromptMode;
  if (resumePromptMode === 'off') return { status: 'disabled' };
  const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials: input.credentials });
  const enqueued = await dispatcher.enqueueInterruptedOriginContinuation({
    sessionId: input.sessionId,
    attemptId: recovery.runtimeAuthRecoveryAttemptId ?? JSON.stringify([recovery.issueFingerprint, recovery.armedAtMs]),
    interruptedOriginId,
    interruption: 'provider_failed_turn',
    resumePromptMode,
    customResumePrompt: input.customResumePrompt,
    recoveryKind: 'usage_limit',
    afterUsageLimitReset: true,
    isCurrent: async ({ rawSession, metadata }) => {
      if (!(await input.isCurrent()) || rawSession.id !== input.sessionId || rawSession.latestTurnStatus !== 'failed'
        || rawSession.archivedAt != null || !metadata || rawSession.latestTurnId !== input.rawSession.latestTurnId) return false;
      const freshIssue = readLatestUsageLimitFailureIssue(rawSession);
      if (!freshIssue || buildUsageLimitIssueFingerprint(freshIssue, fallbackAgentId) !== fingerprint
        || !matchesCurrentBinding(metadata, recovery.selectedAuth)) return false;
      const source = issue.usageLimit?.connectedService;
      const freshSource = freshIssue.usageLimit?.connectedService;
      if (source?.serviceId !== freshSource?.serviceId || source?.profileId !== freshSource?.profileId
        || source?.groupId !== freshSource?.groupId) return false;
      const current = createStoredReadSchema(SessionUsageLimitRecoveryV1Schema).safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
      return (!current.success && metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] === undefined)
        || (current.success && !isTerminal(current.data) && current.data.resumePromptMode !== 'off'
        && current.data.armedAtMs <= recovery.armedAtMs
        && (!current.data.runtimeAuthRecoveryAttemptId || current.data.runtimeAuthRecoveryAttemptId === recovery.runtimeAuthRecoveryAttemptId));
    },
  });
  if (!(await input.isCurrent())) return { status: 'superseded' };
  if (enqueued.status === 'suppressed_newer_user_input') return { status: 'suppressed' };
  if (enqueued.status !== 'enqueued') return { status: 'disabled' };
  // Ordinary Pending admission owns activation, including adoption after a stale active projection.
  return { status: 'continued' };
}
