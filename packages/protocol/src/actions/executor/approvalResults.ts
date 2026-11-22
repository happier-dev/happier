import { buildApprovalOriginFailure } from '../../approvals/approvalStaleReason.js';
import { ActionIdSchema, type ActionId } from '../actionIds.js';
import type { ActionExecuteResult, ActionExecutorContext } from './types.js';
import { getActionSpec } from '../actionSpecs.js';
import type { ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import type { ApprovalRequestPublicRead } from '../../approvals/approvalRequestPublicRead.js';
import type { TargetActionApprovalRequestV1 } from '../../approvals/targetActionApprovalRequestV1.js';
import { resolveApprovalExecutor } from '../../approvals/resolveApprovalExecutor.js';
import type { ActionExecuteFailure } from './types.js';
import { normalizeId } from './inputReading.js';
import { readApprovalExecutionFailure, ApprovalStaleFailureDetailsSchema, projectApprovalExecutionFailureV2 } from '../../approvals/approvalExecutionFailure.js';
import { settleApprovalRequestReplayInputs } from '../../approvals/approvalRequestTransition.js';
import { projectApprovalExecutionForObservation } from '../actionApprovalPresentation.js';
import { projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import type { ApprovalStaleReason } from '../../approvals/approvalExecutionFailure.js';
import { normalizeActionExecutorThrownError } from './resultProjection.js';
import { ActionExecuteResultSchema, isActionOutcomeUnknownErrorCodeV1, withActionAutomationNoticesV1 } from '../actionExecutionResult.js';
import { RpcError } from '../../rpc/errors.js';
import { isHomeAdmittedPresentUserHostInvocation, isPresentUserHostInvocation } from '../invocationAuthority.js';
import { rejectUnavailableSessionInputV1, SessionInputAdmissionResultV1Schema, type SessionInputAdmissionResultV1 } from '../../sessions/messages/sessionInputAdmission.js';
import { SessionInputAdmissionRejectionCodeV1Schema } from '../../sessions/messages/sessionInputAdmissionRejectionV1.js';

/**
 * Delivery of an approved result to its asking Session is a fact separate from
 * the run. Every outcome of that delivery is the Session sender's own receipt:
 * a refusal keeps its typed code and sanitized cause, and an unproven one stays
 * outcome-unknown under the result's retry identity.
 */
export function projectApprovalResultDeliveryV1(response: unknown, localId: string): SessionInputAdmissionResultV1 {
  const receipt = SessionInputAdmissionResultV1Schema.safeParse(response);
  if (receipt.success) return receipt.data;
  const failure = ActionExecuteResultSchema.safeParse(response);
  if (!failure.success || failure.data.ok) return { status: 'outcomeUnknown', localId, code: 'invalid_action_output' };
  const code = SessionInputAdmissionRejectionCodeV1Schema.safeParse(failure.data.errorCode);
  if (code.success) {
    const cause = rejectUnavailableSessionInputV1('approval.result.delivery', failure.data).failureCause;
    return { status: 'rejected', code: code.data, failureCause: cause };
  }
  if (isActionOutcomeUnknownErrorCodeV1(failure.data.errorCode)) {
    return { status: 'outcomeUnknown', localId, code: failure.data.errorCode.slice(0, 128) };
  }
  return rejectUnavailableSessionInputV1('approval.result.delivery', failure.data);
}

/**
 * A Session sender that throws its typed refusal keeps that refusal; any other
 * throw (a lost acknowledgement) leaves only the delivery outcome unknown.
 */
export function projectThrownApprovalResultDeliveryV1(error: unknown, localId: string): SessionInputAdmissionResultV1 {
  const failure = { ok: false as const, ...normalizeActionExecutorThrownError(error, 'approval.result.delivery') };
  return SessionInputAdmissionRejectionCodeV1Schema.safeParse(failure.errorCode).success
    ? projectApprovalResultDeliveryV1(failure, localId)
    : { status: 'outcomeUnknown', localId, code: 'session_input_settlement_outcome_unknown' };
}

/** The decision answers with its run record; the delivery receipt rides beside it. */
export function withApprovalResultDeliveryV1(result: ActionExecuteResult,
  delivery: SessionInputAdmissionResultV1 | undefined): ActionExecuteResult {
  if (!delivery || !result.ok || typeof result.result !== 'object' || result.result === null
    || Array.isArray(result.result)) return result;
  return { ...result, result: { ...result.result, delivery } };
}

/** Project settled producer evidence and dispatch uncertainty into one receipt. */
export function projectSettledApprovalExecution(args: Readonly<{
  request: ApprovalRequest;
  actionId: ActionId | null;
  exec: ActionExecuteResult;
  dispatchEffectAttempted: boolean;
  executedAtMs: number;
}>): Readonly<{ request: ApprovalRequest; exec: ActionExecuteResult }> {
  const { request, actionId, executedAtMs } = args;
  // An adapter may successfully return a declared domain refusal. Use the
  // same catalog-validated owner as retained reads before choosing a terminal
  // status; an opaque failure-looking payload is still ordinary Action data.
  const returnedFailure = args.exec.ok && actionId !== null
    ? readApprovalExecutionFailure({ ...request, execution: {
        executedAtMs, ok: true, result: args.exec.result,
      } }) : null;
  const exec: ActionExecuteResult = returnedFailure
    ? { ...returnedFailure, ...(args.exec.operationCredentialUses?.length
        ? { operationCredentialUses: args.exec.operationCredentialUses } : {}) }
    : args.exec;
  // Dispatch proves delivery only. Preserve the producer's effect evidence;
  // only a refusal before dispatch can be stamped false by settlement.
  const effectAttempted = !exec.ok && typeof exec.effectAttempted === 'boolean'
    ? exec.effectAttempted : args.dispatchEffectAttempted ? undefined : false;
  // Private Artifact custody carries ordinary typed results back to a caller
  // waiting on another host. Blocking flow alone does not make that result
  // live-only. Only declared live-only results use the safe projection here;
  // public reads and decisions independently apply the observation projection.
  const persistedExec = actionId !== null
    && getActionSpec(actionId).approvalResultCustody === 'live_only'
    ? projectActionExecutionObservation(actionId, exec)
    : exec;
  // Deferred replay has already read the raw arguments. Terminal history keeps
  // the Action's own observation projection instead of write-only secrets.
  const settledRequest = settleApprovalRequestReplayInputs(request);
  const executionReceipt = {
    updatedAtMs: Math.max(executedAtMs, request.updatedAtMs),
    execution: persistedExec.ok
      ? { executedAtMs, ...(effectAttempted !== undefined ? { effectAttempted } : {}), ok: true, result: persistedExec.result }
      : request.v === 2
        ? projectApprovalExecutionFailureV2({ request, failure: persistedExec, executedAtMs, effectAttempted })
        : { executedAtMs, ok: false, errorCode: persistedExec.errorCode, error: persistedExec.error },
  };
  const nextExecuted: ApprovalRequest = settledRequest.v === 2
    ? { ...settledRequest, ...executionReceipt,
        status: exec.ok ? 'executed' : effectAttempted !== false && isActionOutcomeUnknownErrorCodeV1(exec.errorCode) ? 'outcome_unknown' : 'failed' }
    : { ...settledRequest, ...executionReceipt, status: exec.ok ? 'executed' : 'failed' };
  if (nextExecuted.v === 2 && effectAttempted !== false && persistedExec.operationCredentialUses?.length) {
    nextExecuted.execution = { ...nextExecuted.execution!, operationCredentialUses: [...persistedExec.operationCredentialUses] };
  }
  return { request: nextExecuted, exec };
}

/** Replay crosses a process boundary; malformed acknowledgements prove no outcome. */
export function readApprovalReplayResult(result: unknown): ActionExecuteResult {
  const parsed = ActionExecuteResultSchema.safeParse(result);
  return parsed.success ? parsed.data : {
    ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output',
  };
}

export function projectActionExecutionObservation(actionId: ActionId, result: ActionExecuteResult): ActionExecuteResult {
  const project = getActionSpec(actionId).projectObservationOutput;
  return result.ok && project ? { ...result, result: project(result.result) } : result;
}

/** Consent permits the effect; the original caller still owns result custody. */
export function projectApprovalInvocationResult(actionId: ActionId, result: ActionExecuteResult,
  context: ActionExecutorContext): ActionExecuteResult {
  return result.ok && getActionSpec(actionId).approvalResultCustody === 'live_only'
    && !isPresentUserHostInvocation(context) && !isHomeAdmittedPresentUserHostInvocation(context, actionId)
    ? { ok: false, errorCode: 'approval_result_held', error: 'approval_result_held',
      ...(result.operationCredentialUses?.length ? { operationCredentialUses: result.operationCredentialUses } : {}) }
    : result;
}

/** The input-side sibling: this Action's own observation-safe view of its input. */
export function projectActionObservationInput(actionId: ActionId, input: unknown): unknown {
  const project = getActionSpec(actionId).projectObservationInput;
  return project ? project(input) : input;
}

export function readUnavailableApprovalReplayOrigin(request: ApprovalRequest): ActionExecuteFailure | null {
  const executor = resolveApprovalExecutor(request);
  if (executor.kind !== 'unavailable' || executor.reason !== 'missing_machine') return null;
  return {
    ok: false,
    errorCode: 'approval_origin_unavailable',
    error: 'Cannot run: origin unavailable. This action needs its originating daemon or agent session. Request it from that session again.',
  };
}

export function buildApprovalDecisionResult(request: ApprovalRequest, freshExecution?: Readonly<{
  exec: ActionExecuteResult;
  authority: ActionExecutorContext['authority'];
}>): ActionExecuteResult {
  const withNotices = (result: ActionExecuteResult) => withActionAutomationNoticesV1(result,
    request.v === 2 ? request.automaticChecks?.notices : undefined);
  const currentActionId = ActionIdSchema.safeParse(request.actionId);
  // Deferred execution has no original waiter. Its deciding human receives
  // the fresh result once, including when execution ran through daemon replay.
  // Blocking invocations and recorded reads retain their existing custody.
  const liveResult = freshExecution?.authority === 'present_user'
    && request.approval?.flow === 'deferred'
    && currentActionId.success && getActionSpec(currentActionId.data).approvalResultCustody === 'live_only'
    ? freshExecution.exec : undefined;
  // Lost live input is a terminal refusal, not a successful Approve control.
  // Keep ordinary execution receipts and live-only result custody unchanged.
  if (request.v === 2 && request.execution?.effectAttempted === false
    && request.execution.errorCode === 'approval_origin_unavailable'
    && currentActionId.success && getActionSpec(currentActionId.data).approvalInputCustody === 'live_only') {
    const details = ApprovalStaleFailureDetailsSchema.safeParse(request.execution.details);
    if (details.success && details.data.reason === 'live_invocation_unavailable') {
      return withNotices(buildApprovalOriginFailure(details.data.reason));
    }
  }
  const observedExecution = projectApprovalExecutionForObservation(request);
  try {
    return withNotices({
      ok: true,
      // Typed Action results can retain native optional members. The decision
      // is a strict JSON observation, after the target's custody projection.
      result: projectNativeJsonValueForTransport({
        ok: true,
        status: request.status,
        ...(observedExecution ? { execution: observedExecution } : {}),
        ...(liveResult?.ok ? { liveExecution: liveResult } : {}),
      }),
    });
  } catch {
    return withNotices({ ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
  }
}

export function buildActionExecuteResultFromRecordedApprovalExecution(request: ApprovalRequest | TargetActionApprovalRequestV1 | ApprovalRequestPublicRead): ActionExecuteResult | null {
  if (!request.execution) return null;
  const withNotices = (result: ActionExecuteResult) => withActionAutomationNoticesV1(result,
    request.v === 2 || !('actionId' in request) ? request.automaticChecks?.notices : undefined);
  const operationCredentialUses = request.v === 2 || !('actionId' in request)
    ? request.execution.operationCredentialUses : undefined;
  if (request.execution.ok) {
    const actionId = ActionIdSchema.safeParse('actionId' in request ? request.actionId : undefined);
    if (actionId.success && getActionSpec(actionId.data).approvalResultCustody === 'live_only') {
      return withNotices({ ok: false, errorCode: 'approval_result_held', error: 'approval_result_held',
        ...(operationCredentialUses?.length ? { operationCredentialUses } : {}) });
    }
    return withNotices({ ok: true, result: request.execution.result,
      ...(operationCredentialUses?.length ? { operationCredentialUses } : {}) });
  }
  const failure = readApprovalExecutionFailure(request);
  return failure ? withNotices(operationCredentialUses?.length ? { ...failure, operationCredentialUses } : failure) : null;
}

export function projectApprovalRequestPluginCaller(
  actionCaller: ActionExecutorContext['actionCaller'],
): Readonly<{ pluginId: string; contributionLocalId: string }> | null {
  if (actionCaller?.kind !== 'plugin') return null;
  const pluginId = PluginIdSchema.safeParse(actionCaller.pluginId);
  const contributionLocalId = PluginContributionLocalIdSchema.safeParse(actionCaller.contributionLocalId);
  if (!pluginId.success || !contributionLocalId.success) return null;
  return { pluginId: pluginId.data, contributionLocalId: contributionLocalId.data };
}

export async function classifyApprovalExecutionOriginCurrentness(args: Readonly<{
  check: (reportStale: (reason: ApprovalStaleReason) => void) => Promise<boolean>;
}>): Promise<Readonly<
  { status: 'current' }
  | { status: 'stale'; reason: ApprovalStaleReason }
  | { status: 'requester_home_unavailable'; error: unknown }
  | { status: 'read_failed'; error: unknown; failure: Readonly<{
      errorCode: string;
      error: string;
      details?: unknown;
    }> }
>> {
  let reason: ApprovalStaleReason | undefined;
  try {
    const current = await args.check(value => { reason = value; });
    if (current) return { status: 'current' };
    // An adapter that supplied no failed fact did not establish staleness.
    if (!reason) throw new RpcError('approval_context_unavailable', 'approval_context_unavailable');
    return { status: 'stale', reason };
  } catch (error) {
    const failure = normalizeActionExecutorThrownError(error);
    if (failure.errorCode === 'project_requester_home_unavailable') {
      return { status: 'requester_home_unavailable', error };
    }
    return { status: 'read_failed', error, failure };
  }
}
