import { readSessionRuntimeIssueCode, type SessionRuntimeIssueV1 } from './runtimeIssueV1.js';

/** Clear transport gets recovery facts only; full diagnostics stay in the content channel. */
export function projectSessionRuntimeIssueMetadataV1(issue: SessionRuntimeIssueV1): SessionRuntimeIssueV1 {
  const { usageLimit, temporaryThrottle, failureCause } = issue;
  return {
    v: issue.v, scope: issue.scope, status: issue.status,
    code: readSessionRuntimeIssueCode(issue.code) ?? issue.source,
    source: issue.source, occurredAt: issue.occurredAt,
    ...(issue.sessionSeq === undefined ? {} : { sessionSeq: issue.sessionSeq }),
    ...(issue.agentId === undefined ? {} : { agentId: issue.agentId }),
    ...(usageLimit ? { usageLimit: {
      v: usageLimit.v, resetAtMs: usageLimit.resetAtMs, retryAfterMs: usageLimit.retryAfterMs,
      quotaScope: usageLimit.quotaScope, recoverability: usageLimit.recoverability,
    } } : {}),
    ...(temporaryThrottle ? { temporaryThrottle } : {}),
    ...(failureCause ? { failureCause: {
      phase: failureCause.phase, failureReason: failureCause.failureReason,
      ...(failureCause.code === undefined ? {} : { code: failureCause.code }),
      ...(failureCause.retryable === undefined ? {} : { retryable: failureCause.retryable }),
      ...(failureCause.httpStatus === undefined ? {} : { httpStatus: failureCause.httpStatus }),
      ...(failureCause.providerErrorCode === undefined ? {} : { providerErrorCode: failureCause.providerErrorCode }),
      ...(failureCause.reason === undefined ? {} : { reason: failureCause.reason }),
    } } : {}),
  };
}
