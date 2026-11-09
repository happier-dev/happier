import type { ConnectedAccountServiceKey, SessionRuntimeIssueV1, SessionUsageLimitRecoveryResumePromptModeV1, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { deriveUsageLimitRecoveryTiming } from './deriveUsageLimitRecoveryTiming';
import { readLatestUsageLimitFailureIssue } from './readLatestUsageLimitFailureIssue';
import { resolveUsageLimitRecoverySelectedAuthFromIssue } from './usageLimitRecoverySelectedAuth';

type RecoveryIntentOptions = Readonly<{
  issueFingerprint?: string;
  providerId?: string;
  connectedServices?: unknown;
  defaultNativeServiceId?: ConnectedAccountServiceKey | null;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
}>;

export function buildRecoveryIntentFromLatestUsageLimitIssue(params: RecoveryIntentOptions & Readonly<{
  rawSession: RawSessionRecord;
}>): SessionUsageLimitRecoveryV1 | null {
  const issue = readLatestUsageLimitFailureIssue(params.rawSession);
  return issue ? buildRecoveryIntentFromUsageLimitIssue({ ...params, issue }) : null;
}

export function buildRecoveryIntentFromUsageLimitIssue(params: RecoveryIntentOptions & Readonly<{
  issue: SessionRuntimeIssueV1;
}>): SessionUsageLimitRecoveryV1 | null {
  const issue = params.issue;
  if (issue.source !== 'usage_limit' || !issue.usageLimit) return null;
  const selectedAuth = resolveUsageLimitRecoverySelectedAuthFromIssue({ issue,
    defaultNativeServiceId: params.defaultNativeServiceId,
    connectedServices: params.connectedServices ?? null }) ?? { kind: 'native' as const };
  const timing = deriveUsageLimitRecoveryTiming({ occurredAtMs: issue.occurredAt,
    resetAtMs: issue.usageLimit.resetAtMs, retryAfterMs: issue.usageLimit.retryAfterMs });
  return { v: 1, status: 'waiting', resumePromptMode: params.resumePromptMode ?? 'standard',
    issueFingerprint: params.issueFingerprint ?? buildUsageLimitIssueFingerprint(issue, params.providerId),
    armedAtMs: issue.occurredAt, resetAtMs: timing.resetAtMs, nextCheckAtMs: timing.nextCheckAtMs,
    attemptCount: 0, maxAttempts: 0, lastProbeError: null, selectedAuth };
}
