import { ActionIdSchema } from '../actions/actionIds.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '../json/strictJsonValue.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from './approvalRequestV1.js';

/**
 * The one approval subject/transition contract for built-in approval Artifacts.
 *
 * Every Artifact adapter (the CLI/daemon store and the UI writer) asks this
 * owner whether a proposed body may replace the stored one, then commits it with
 * the revision it read (Artifact CAS). The immutable subject is everything except
 * the lifecycle fields and validated append-only Storage retry receipts; the lifecycle is
 *
 *   open -> approved -> executing -> executed | failed
 *   open -> rejected | canceled
 *   approved -> failed            (definitive pre-execution failure)
 *
 * The signed admitted operands (`actionArgs`) stay immutable during replay.
 * A person's spec-admitted choice lives separately on the decision. Execution
 * validates that choice against the original operands after origin verification.
 * Settlement replaces both inputs with the Action's private review or observation
 * projection (`settleApprovalRequestActionArgs`), never with caller-authored
 * arguments, so no durable history keeps write-only secrets after replay.
 * A new UI Storage retry may append only its settled result; it never changes
 * the original terminal execution or grants replay authority.
 */

type ApprovalRequestStatus = ApprovalRequest['status'];

const SETTLED_STATUSES: ReadonlySet<ApprovalRequestStatus> = new Set([
  'rejected',
  'canceled',
  'executed',
  'failed',
  'outcome_unknown',
]);

function isSettled(status: ApprovalRequestStatus): boolean {
  return SETTLED_STATUSES.has(status);
}

/**
 * The operands a settled approval durably keeps: the Action's declared
 * private `approvalPresentation.projectInput` when its spec declares
 * `retainInputOnSettlement`, or otherwise `projectObservationInput`,
 * of the admitted input. Review history keeps exactly the declared operands people approved,
 * without widening what shared Action observations disclose. A request that is already
 * settled, an Action with live-only input custody (its record already holds that
 * projection since creation), a historical Action id with no current spec, and
 * an Action without a projection keep their stored operands unchanged, so the
 * projection is applied exactly once and never to its own output.
 */
export function settleApprovalRequestActionArgs(request: ApprovalRequest): unknown {
  if (isSettled(request.status)) return request.actionArgs;
  const actionId = ActionIdSchema.safeParse(request.actionId);
  if (!actionId.success) return request.actionArgs;
  const spec = getActionSpec(actionId.data);
  if (spec.approvalInputCustody === 'live_only') return request.actionArgs;
  if (spec.approvalPresentation?.retainInputOnSettlement && spec.approvalPresentation.projectInput
    && spec.inputSchema.safeParse(request.actionArgs).success) {
    const review = spec.approvalPresentation.projectInput(request.actionArgs);
    return spec.approvalPresentation.inputSchema ? spec.approvalPresentation.inputSchema.parse(review) : review;
  }
  if (!spec.projectObservationInput) return request.actionArgs;
  return spec.projectObservationInput(request.actionArgs);
}

/** The decision choice shares the existing terminal secret-projection contract. */
export function settleApprovalRequestDecision(request: ApprovalRequest): ApprovalRequest['decision'] {
  if (request.v !== 2 || request.decision?.narrowedInput === undefined || isSettled(request.status)) return request.decision;
  return { ...request.decision, narrowedInput: projectNativeJsonValueForTransport(
    settleApprovalRequestActionArgs({ ...request, actionArgs: request.decision.narrowedInput }),
  ) };
}

/** Raw replay operands share one lifetime, including the original finite invocation envelope. */
export function settleApprovalRequestReplayInputs(request: ApprovalRequest): ApprovalRequest {
  const actionArgs = settleApprovalRequestActionArgs(request);
  const decision = settleApprovalRequestDecision(request);
  if (request.v !== 2) return { ...request, actionArgs, decision };
  const { originalActionEnvelope: _envelope, ...executionOriginV1 } = request.executionOriginV1;
  return { ...request, actionArgs, decision, executionOriginV1 };
}

/** Input admission only, shared by the transition writer and the replay executor. */
export function resolveApprovalRequestExecutionInput(request: ApprovalRequest):
  | Readonly<{ ok: true; input: unknown }>
  | Readonly<{ ok: false; errorCode: 'invalid_parameters'; error: 'invalid_parameters' }> {
  if (request.v !== 2 || request.decision?.narrowedInput === undefined) return { ok: true, input: request.actionArgs };
  const actionId = ActionIdSchema.safeParse(request.actionId);
  const spec = actionId.success ? getActionSpec(actionId.data) : null;
  if (request.decision.kind === 'approve' && request.decision.authority === 'present_user' && spec?.approvalNarrowing) {
    const narrowed = spec.approvalNarrowing.narrow(request.actionArgs, request.decision.narrowedInput);
    const admitted = narrowed === null ? null : spec.inputSchema.safeParse(narrowed);
    if (admitted?.success) return { ok: true, input: admitted.data };
  }
  return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
}

/** Compare the JSON both adapters actually persist (absent and `undefined` fields agree). */
function durablyEqual(left: unknown, right: unknown): boolean {
  const durable = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return sameStrictJsonValue(durable(left), durable(right));
}

function immutableSubject(request: ApprovalRequest, actionArgs: unknown): Readonly<Record<string, unknown>> {
  const {
    status: _status,
    updatedAtMs: _updatedAtMs,
    decision: _decision,
    execution: _execution,
    actionArgs: _actionArgs,
    storageRetryResults: _storageRetryResults,
    ...subject
  } = request;
  return { ...subject, actionArgs };
}

export type ApprovalRequestTransitionDecision =
  | Readonly<{ ok: true; changed: boolean }>
  | Readonly<{ ok: false; errorCode: 'subject_mismatch'; error: 'approval_request_subject_mismatch' }>
  | Readonly<{ ok: false; errorCode: 'invalid_transition'; error: 'approval_request_invalid_transition' }>;

const SUBJECT_MISMATCH = {
  ok: false,
  errorCode: 'subject_mismatch',
  error: 'approval_request_subject_mismatch',
} as const;

const INVALID_TRANSITION = {
  ok: false,
  errorCode: 'invalid_transition',
  error: 'approval_request_invalid_transition',
} as const;

/**
 * Decide whether `next` may replace the stored `existing` request. `changed:
 * false` is an idempotent repeat of a non-claiming write; an identical
 * `executing` write is refused so a second executor can never believe it won the
 * effect claim.
 */
export function decideApprovalRequestTransition(
  existing: ApprovalRequest,
  next: ApprovalRequest,
): ApprovalRequestTransitionDecision {
  const settling = !isSettled(existing.status) && isSettled(next.status);
  const expected = settling ? settleApprovalRequestReplayInputs(existing) : existing;
  if (!durablyEqual(immutableSubject(expected, expected.actionArgs), immutableSubject(next, next.actionArgs))) {
    return SUBJECT_MISMATCH;
  }
  if (existing.status === 'open') {
    if (next.v === 2 && next.decision?.narrowedInput !== undefined
      && (next.status !== 'approved' || !resolveApprovalRequestExecutionInput(next).ok)) return SUBJECT_MISMATCH;
  } else if (!durablyEqual(expected.decision, next.decision)) {
    return SUBJECT_MISMATCH;
  }
  const isStorageRetryReceipt = existing.v === 2 && next.v === 2
    && existing.status === 'executed' && next.status === 'executed'
    && durablyEqual(existing.execution, next.execution)
    && ApprovalRequestV2Schema.safeParse(next).success
    && (next.storageRetryResults?.length ?? 0) > (existing.storageRetryResults?.length ?? 0)
    && durablyEqual(existing.storageRetryResults ?? [], next.storageRetryResults?.slice(0, existing.storageRetryResults?.length ?? 0));
  if (!durablyEqual(existing.storageRetryResults, next.storageRetryResults) && !isStorageRetryReceipt) return SUBJECT_MISMATCH;
  if (durablyEqual(existing, next)) {
    return existing.status === 'executing' ? INVALID_TRANSITION : { ok: true, changed: false };
  }
  const isOpenDecision = existing.status === 'open'
    && (next.status === 'approved' || next.status === 'rejected' || next.status === 'canceled');
  // Only current V2 carries the executing claim. Released ApprovalRequestV1
  // has terminal execution results, but no intermediate `executing` state.
  const isApprovedExecution = existing.v === 2
    && existing.status === 'approved'
    && next.v === 2
    && next.status === 'executing'
    && next.decision?.kind === 'approve'
    && next.execution === undefined;
  // A definitive replay-currentness/context failure happens before an Action
  // effect starts, so it settles an approved V2 request directly.
  const isApprovedPreExecutionFailure = existing.v === 2
    && existing.status === 'approved'
    && next.v === 2
    && (next.status === 'failed' || next.status === 'outcome_unknown')
    && next.decision?.kind === 'approve'
    && next.execution?.ok === false;
  // Released V1 has no replay authority or executing claim; the decision owner
  // may only close an approved V1 request with the fixed non-effectful stale
  // tombstone.
  const isLegacyApprovedStaleFailure = existing.v === 1
    && existing.status === 'approved'
    && next.v === 1
    && next.status === 'failed'
    && next.decision?.kind === 'approve'
    && next.execution?.ok === false
    && next.execution.errorCode === 'approval_stale'
    && next.execution.error === 'approval_stale';
  const isExecutingTerminal = existing.v === 2
    && existing.status === 'executing'
    && next.v === 2
    && (next.status === 'executed' || next.status === 'failed' || next.status === 'outcome_unknown')
    && next.decision?.kind === 'approve'
    && next.execution !== undefined
    // Cancellation owns only unclaimed custody. The writer may have re-read
    // an execution claim after the canceling caller read `approved`.
    && !(next.execution.errorCode === 'approval_canceled' && next.execution.effectAttempted === false);
  // Read-back may settle the original admitted worker link, but can never
  // grant another effect claim or rewrite its subject, decision or start time.
  const isWorkspaceLinkReadBack = existing.v === 2 && next.v === 2
    && existing.actionId === 'workspace.sync.relationship.create'
    && existing.status === 'outcome_unknown' && existing.execution?.effectAttempted === true
    && next.execution?.effectAttempted === true
    && next.execution.executedAtMs === existing.execution.executedAtMs
    && (next.status === 'executed' && next.execution.ok === true
      || next.status === 'failed' && next.execution.ok === false);
  if (
    (!isOpenDecision
      && !isApprovedExecution
      && !isApprovedPreExecutionFailure
      && !isLegacyApprovedStaleFailure
      && !isExecutingTerminal
      && !isWorkspaceLinkReadBack
      && !isStorageRetryReceipt)
    || next.updatedAtMs < existing.updatedAtMs
  ) {
    return INVALID_TRANSITION;
  }
  return { ok: true, changed: true };
}
