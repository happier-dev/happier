import type { TargetActionApprovalRequestV1 } from './targetActionApprovalRequestV1.js';
import { preservesApprovalAutomaticChecksV1 } from './approvalRequestTransition.js';
import { isApprovalRequestExecutionApproved } from './approvalAutomaticChecks.js';
import { readSettledApprovalInputCustodyV1 } from './approvalInputCustody.js';

/** Terminal receipts retain admission evidence, never the live invocation's raw operands.
 * A reader comparing an original proposal with a stored receipt supplies that receipt's status.
 */
export function settleTargetActionApprovalReplayInputs(
  request: TargetActionApprovalRequestV1,
  settlementStatus: TargetActionApprovalRequestV1['status'] = request.status,
): TargetActionApprovalRequestV1 {
  if (readSettledApprovalInputCustodyV1({ ...request, status: settlementStatus }) !== 'live_only') return request;
  const withoutInput = (decision: NonNullable<TargetActionApprovalRequestV1['decision']>) => {
    const { narrowedInput: _input, ...receipt } = decision;
    return receipt;
  };
  const originReceipt = request.executionOriginV1 ? (() => {
    const { originalActionEnvelope: _envelope, ...receipt } = request.executionOriginV1;
    return receipt;
  })() : undefined;
  return { ...request, input: null,
    ...(request.decision ? { decision: withoutInput(request.decision) } : {}),
    ...(request.automaticChecks?.humanDecision ? { automaticChecks: { ...request.automaticChecks,
      humanDecision: withoutInput(request.automaticChecks.humanDecision) } } : {}),
    ...(originReceipt ? { executionOriginV1: originReceipt } : {}),
  };
}

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
    inputFields: request.inputFields,
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
    ...(request.automaticChecks ? { automaticChecks: {
      selected: request.automaticChecks.selected, subjects: request.automaticChecks.subjects,
      selectionStatus: request.automaticChecks.selectionStatus, humanApprovalRequired: request.automaticChecks.humanApprovalRequired,
    } } : {}),
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
  // An idempotent retry may still carry the caller's original live operands.
  let receiptAlreadySettled = true;
  if (readSettledApprovalInputCustodyV1(existing) === 'live_only') {
    const receipt = settleTargetActionApprovalReplayInputs(existing);
    receiptAlreadySettled = targetActionApprovalRequestsEqual(existing, receipt);
    existing = receipt;
    request = settleTargetActionApprovalReplayInputs(request, existing.status);
  }
  if (!targetActionApprovalSubjectsEqual(existing, request)
    || !preservesApprovalAutomaticChecksV1(existing.automaticChecks, request.automaticChecks)) {
    return { ok: false, errorCode: 'subject_mismatch', error: 'target_action_approval_subject_mismatch' };
  }
  const invalid = { ok: false, errorCode: 'invalid_transition', error: 'target_action_approval_invalid_transition' } as const;
  if (targetActionApprovalRequestsEqual(existing, request)) {
    return existing.status === 'executing' ? invalid : { ok: true, unchanged: receiptAlreadySettled };
  }
  const isOpenDecision = existing.status === 'open'
    && (request.status === 'approved' || request.status === 'rejected' || request.status === 'canceled');
  const isAutomaticProgress = existing.status === 'open' && request.status === 'open'
    && existing.automaticChecks !== undefined && request.automaticChecks !== undefined;
  const isAutomaticRefusal = existing.status === 'open' && request.status === 'failed'
    && request.automaticChecks?.phase === 'refused' && request.execution?.effectAttempted === false;
  const isApprovedExecution = existing.status === 'approved' && request.status === 'executing'
    && isApprovalRequestExecutionApproved(request) && request.execution === undefined;
  const isApprovedStale = existing.status === 'approved' && request.status === 'failed'
    && isApprovalRequestExecutionApproved(request) && request.execution?.ok === false && (request.execution.errorCode === 'approval_stale'
      || request.execution.errorCode === 'approval_origin_unavailable' && request.execution.effectAttempted === false);
  const isApprovedCancellation = existing.status === 'approved' && request.status === 'failed'
    && isApprovalRequestExecutionApproved(request) && request.execution?.ok === false
    && request.execution.errorCode === 'approval_canceled' && request.execution.effectAttempted === false
    && stable(existing.decision) === stable(request.decision);
  const isExecutingTerminal = existing.status === 'executing'
    && (request.status === 'executed' || request.status === 'failed' || request.status === 'outcome_unknown')
    && isApprovalRequestExecutionApproved(request) && request.execution !== undefined
    // A cancellation receipt cannot settle custody another invocation claimed.
    && !(request.execution.errorCode === 'approval_canceled' && request.execution.effectAttempted === false);
  return (!isOpenDecision && !isAutomaticProgress && !isAutomaticRefusal && !isApprovedExecution && !isApprovedStale && !isApprovedCancellation && !isExecutingTerminal)
    || request.updatedAtMs < existing.updatedAtMs ? invalid : { ok: true, unchanged: false };
}

