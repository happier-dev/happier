import type { TargetActionApprovalRequestV1 } from './targetActionApprovalRequestV1.js';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function subject(request: TargetActionApprovalRequestV1): unknown {
  return {
    v: request.v,
    kind: request.kind,
    createdAtMs: request.createdAtMs,
    createdBy: request.createdBy,
    requestedSurface: request.requestedSurface,
    qualifiedActionId: request.qualifiedActionId,
    input: request.input,
    secretInputPaths: request.secretInputPaths,
    secretInputLabels: request.secretInputLabels,
    approvalInputCustody: request.approvalInputCustody,
    accountId: request.accountId,
    resourceId: request.resourceId,
    sourceCustody: request.sourceCustody,
    policyFingerprint: request.policyFingerprint,
    subjectFingerprint: request.subjectFingerprint,
    replayPlacement: request.replayPlacement,
    executionOriginV1: request.executionOriginV1,
    requesterConfirmation: request.requesterConfirmation,
    summary: request.summary,
    detail: request.detail,
  };
}

export function targetActionApprovalSubjectsEqual(
  left: TargetActionApprovalRequestV1,
  right: TargetActionApprovalRequestV1,
): boolean {
  return stable(subject(left)) === stable(subject(right));
}

export function targetActionApprovalRequestsEqual(
  left: TargetActionApprovalRequestV1,
  right: TargetActionApprovalRequestV1,
): boolean {
  return stable(left) === stable(right);
}

/** Canonical admission before an Artifact owner's revision CAS. */
export function admitTargetActionApprovalTransition(
  existing: TargetActionApprovalRequestV1,
  request: TargetActionApprovalRequestV1,
): Readonly<{ ok: true; unchanged: boolean } | { ok: false; errorCode: string; error: string }> {
  if (!targetActionApprovalSubjectsEqual(existing, request)) {
    return { ok: false, errorCode: 'subject_mismatch', error: 'target_action_approval_subject_mismatch' };
  }
  const invalid = { ok: false, errorCode: 'invalid_transition', error: 'target_action_approval_invalid_transition' } as const;
  if (targetActionApprovalRequestsEqual(existing, request)) {
    return existing.status === 'executing' ? invalid : { ok: true, unchanged: true };
  }
  const isOpenDecision = existing.status === 'open'
    && (request.status === 'approved' || request.status === 'rejected' || request.status === 'canceled');
  const isApprovedExecution = existing.status === 'approved' && request.status === 'executing'
    && request.decision?.kind === 'approve' && request.execution === undefined;
  const isApprovedStale = existing.status === 'approved' && request.status === 'failed'
    && request.decision?.kind === 'approve' && request.execution?.ok === false && request.execution.errorCode === 'approval_stale';
  const isApprovedCancellation = existing.status === 'approved' && request.status === 'failed'
    && request.decision?.kind === 'approve' && request.execution?.ok === false
    && request.execution.errorCode === 'approval_canceled' && request.execution.effectAttempted === false
    && stable(existing.decision) === stable(request.decision);
  const isExecutingTerminal = existing.status === 'executing'
    && (request.status === 'executed' || request.status === 'failed' || request.status === 'outcome_unknown')
    && request.decision?.kind === 'approve' && request.execution !== undefined
    // A cancellation receipt cannot settle custody another invocation claimed.
    && !(request.execution.errorCode === 'approval_canceled' && request.execution.effectAttempted === false);
  return (!isOpenDecision && !isApprovedExecution && !isApprovedStale && !isApprovedCancellation && !isExecutingTerminal)
    || request.updatedAtMs < existing.updatedAtMs ? invalid : { ok: true, unchanged: false };
}

