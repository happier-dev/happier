import { isWorkspaceSyncRelationshipWriteActionId } from '../actions/actionIds.js';
import { ActionIdSchema } from '../actions/actionIds.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '../json/strictJsonValue.js';
import { ApprovalRequestUpdateSchema, ApprovalRequestV2Schema, isHistoricalPublishApprovalRequestV2, type ApprovalRequest, type ApprovalRequestV2, type CurrentApprovalRequest, type StoredApprovalRequestV2 } from './approvalRequestV1.js';
import { actionAutomationTriggerKeyV1, isApprovalRequestExecutionApproved } from './approvalAutomaticChecks.js';
export { createApprovalRequestArtifact, deriveApprovalRequestArtifactId, assertApprovalRequestCreationBinding, ApprovalRequestConflict } from './creation.js';

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
export function settleApprovalRequestReplayInputs(request: ApprovalRequestV2): ApprovalRequestV2;
export function settleApprovalRequestReplayInputs(request: StoredApprovalRequestV2): StoredApprovalRequestV2;
export function settleApprovalRequestReplayInputs(request: CurrentApprovalRequest): CurrentApprovalRequest;
export function settleApprovalRequestReplayInputs(request: ApprovalRequest): ApprovalRequest;
export function settleApprovalRequestReplayInputs(request: ApprovalRequest): ApprovalRequest {
  if (isHistoricalPublishApprovalRequestV2(request)) return request;
  const actionArgs = settleApprovalRequestActionArgs(request);
  const decision = settleApprovalRequestDecision(request);
  if (request.v !== 2) return { ...request, actionArgs, decision };
  const { originalActionEnvelope: _envelope, ...executionOriginV1 } = request.executionOriginV1;
  const automaticChecks = request.automaticChecks;
  const humanDecision = automaticChecks?.humanDecision;
  return { ...request, actionArgs, decision, executionOriginV1,
    ...(automaticChecks ? { automaticChecks: { ...automaticChecks,
      ...(humanDecision ? { humanDecision: settleApprovalRequestDecision({ ...request, decision: humanDecision }) } : {}) } } : {}) };
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
    automaticChecks: _automaticChecks,
    ...subject
  } = request;
  const automatic = request.v === 2 ? request.automaticChecks : undefined;
  return { ...subject, actionArgs, ...(automatic ? { automaticChecks: {
    selected: automatic.selected, subjects: automatic.subjects, selectionStatus: automatic.selectionStatus,
    humanApprovalRequired: automatic.humanApprovalRequired,
  } } : {}) };
}

/** Admission facts and answered decisions survive every pending continuation. */
function preservesAutomaticChecks(existing: ApprovalRequest, next: ApprovalRequest): boolean {
  const prior = existing.v === 2 ? existing.automaticChecks : undefined;
  const following = next.v === 2 ? next.automaticChecks : undefined;
  return preservesApprovalAutomaticChecksV1(prior, following);
}

export function preservesApprovalAutomaticChecksV1(
  prior: import('./approvalAutomaticChecks.js').ApprovalAutomaticChecksV1 | undefined,
  following: import('./approvalAutomaticChecks.js').ApprovalAutomaticChecksV1 | undefined,
): boolean {
  if (!prior || !following) return prior === following;
  if (prior.humanDecision && !durablyEqual(prior.humanDecision, following.humanDecision)) return false;
  if (prior.results.length && !durablyEqual(prior.results, following.results)) return false;
  if (prior.notices.some(notice => !following.notices.some(candidate => durablyEqual(candidate, notice)))) return false;
  if (prior.runs.some(run => !following.runs.some(candidate => durablyEqual(candidate, run)))) return false;
  if (prior.consents.length !== following.consents.length || prior.consents.some(consent => !following.consents.some(candidate =>
    actionAutomationTriggerKeyV1(candidate) === actionAutomationTriggerKeyV1(consent)
      && (consent.decision === 'pending' || durablyEqual(candidate, consent))))) return false;
  if (prior.phase === 'passed' || prior.phase === 'refused') return durablyEqual(prior, following);
  if (prior.phase === 'checking' && following.phase === 'consent') return false;
  if (prior.phase === 'override' && following.phase !== 'override' && following.phase !== 'passed') return false;
  return true;
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
  options?: Readonly<{ expectedStatus?: ApprovalRequest['status'] }>,
): ApprovalRequestTransitionDecision {
  if (options?.expectedStatus !== undefined && existing.status !== options.expectedStatus) return INVALID_TRANSITION;
  const settling = !isSettled(existing.status) && isSettled(next.status);
  const expected = settling ? settleApprovalRequestReplayInputs(existing) : existing;
  if (!durablyEqual(immutableSubject(expected, expected.actionArgs), immutableSubject(next, next.actionArgs))) {
    return SUBJECT_MISMATCH;
  }
  if (!preservesAutomaticChecks(expected, next)) return SUBJECT_MISMATCH;
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
  // A decision outside the stored-request reader's update schema is refused here, never committed unreadable.
  const isOpenDecision = existing.status === 'open'
    && (next.status === 'approved' || next.status === 'rejected' || next.status === 'canceled')
    && (next.v !== 2 || ApprovalRequestUpdateSchema.safeParse(next).success);
  const isAutomaticPendingDecision = existing.v === 2 && next.v === 2
    && existing.status === 'open' && next.status === 'open'
    && existing.automaticChecks !== undefined && next.automaticChecks !== undefined
    && ApprovalRequestV2Schema.safeParse(next).success;
  const isAutomaticRefusal = existing.v === 2 && next.v === 2 && existing.status === 'open'
    && next.status === 'failed' && next.automaticChecks?.phase === 'refused'
    && next.execution?.ok === false && next.execution.effectAttempted === false;
  // Only current V2 carries the executing claim. Released ApprovalRequestV1
  // has terminal execution results, but no intermediate `executing` state.
  const isApprovedExecution = existing.v === 2
    && existing.status === 'approved'
    && next.v === 2
    && next.status === 'executing'
    && isApprovalRequestExecutionApproved(next)
    && next.execution === undefined;
  // A definitive replay-currentness/context failure happens before an Action
  // effect starts, so it settles an approved V2 request directly.
  const isApprovedPreExecutionFailure = existing.v === 2
    && existing.status === 'approved'
    && next.v === 2
    && (next.status === 'failed' || next.status === 'outcome_unknown')
    && isApprovalRequestExecutionApproved(next)
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
    && isApprovalRequestExecutionApproved(next)
    && next.execution !== undefined
    // Cancellation owns only unclaimed custody. The writer may have re-read
    // an execution claim after the canceling caller read `approved`.
    && !(next.execution.errorCode === 'approval_canceled' && next.execution.effectAttempted === false);
  // Read-back may settle the original admitted worker link, but can never
  // grant another effect claim or rewrite its subject, decision or start time.
  const isWorkspaceLinkReadBack = existing.v === 2 && next.v === 2
    && isWorkspaceSyncRelationshipWriteActionId(existing.actionId)
    && existing.status === 'outcome_unknown' && existing.execution !== undefined && next.execution !== undefined
    && existing.execution.effectAttempted !== false
    && next.execution.effectAttempted === existing.execution.effectAttempted
    && next.execution.executedAtMs === existing.execution.executedAtMs
    && (next.status === 'executed' && next.execution.ok === true
      || next.status === 'failed' && next.execution.ok === false);
  if (
    (!isOpenDecision
      && !isAutomaticPendingDecision
      && !isAutomaticRefusal
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
