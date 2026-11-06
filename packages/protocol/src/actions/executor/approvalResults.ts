import { settleApprovalRequestReplayInputs } from '../../approvals/approvalRequestTransition.js';
import { projectApprovalExecutionFailureV2 } from '../../approvals/approvalExecutionFailure.js';
import { isActionOutcomeUnknownErrorCodeV1 } from '../actionExecutionResult.js';
import { ActionIdSchema, type ActionId } from '../actionIds.js';
import type { ActionExecuteResult, ActionExecutorContext } from './types.js';
import { getActionSpec } from '../actionSpecs.js';
import { requiresExactDaemonApprovalReplay, type ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import type { ApprovalRequestPublicRead } from '../../approvals/approvalRequestPublicRead.js';
import type { ActionExecuteFailure } from './types.js';
import { normalizeId } from './inputReading.js';
import { readApprovalExecutionFailure, ApprovalStaleFailureDetailsSchema } from '../../approvals/approvalExecutionFailure.js';
import { projectApprovalExecutionForObservation } from '../actionApprovalPresentation.js';
import { projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import type { ApprovalStaleReason } from '../../approvals/approvalExecutionFailure.js';
import { normalizeActionExecutorThrownError } from './resultProjection.js';
import { ActionExecuteResultSchema } from '../actionExecutionResult.js';

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

/** The input-side sibling: this Action's own observation-safe view of its input. */
export function projectActionObservationInput(actionId: ActionId, input: unknown): unknown {
  const project = getActionSpec(actionId).projectObservationInput;
  return project ? project(input) : input;
}

export function readUnavailableApprovalReplayOrigin(request: ApprovalRequest): ActionExecuteFailure | null {
  if (request.v !== 2 || !requiresExactDaemonApprovalReplay(request)
    || normalizeId(request.executionOriginV1.machineId)) return null;
  return {
    ok: false,
    errorCode: 'approval_origin_unavailable',
    error: 'Cannot run: origin unavailable. This action needs its originating daemon or agent session. Request it from that session again.',
  };
}

export function buildApprovalDecisionResult(request: ApprovalRequest, liveResult?: ActionExecuteResult): ActionExecuteResult {
  // Lost live input is a terminal refusal, not a successful Approve control.
  // Keep ordinary execution receipts and live-only result custody unchanged.
  if (request.v === 2 && request.execution?.effectAttempted === false
    && request.execution.errorCode === 'approval_stale'
    && getActionSpec(request.actionId).approvalInputCustody === 'live_only') {
    const details = ApprovalStaleFailureDetailsSchema.safeParse(request.execution.details);
    if (details.success && details.data.reason === 'live_invocation_unavailable') {
      return { ok: false, errorCode: 'approval_stale', error: 'approval_stale', details: details.data };
    }
  }
  const observedExecution = projectApprovalExecutionForObservation(request);
  try {
    return {
      ok: true,
      // Typed Action results can retain native optional members. The decision
      // is a strict JSON observation, after the target's custody projection.
      result: projectNativeJsonValueForTransport({
        ok: true,
        status: request.status,
        ...(observedExecution ? { execution: observedExecution } : {}),
        ...(liveResult?.ok ? { liveExecution: liveResult } : {}),
      }),
    };
  } catch {
    return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  }
}

export function buildActionExecuteResultFromRecordedApprovalExecution(request: ApprovalRequest | ApprovalRequestPublicRead): ActionExecuteResult | null {
  if (!request.execution) return null;
  const operationCredentialUses = request.v === 2 || !('actionId' in request)
    ? request.execution.operationCredentialUses : undefined;
  if (request.execution.ok) {
    const actionId = ActionIdSchema.safeParse('actionId' in request ? request.actionId : undefined);
    if (actionId.success && getActionSpec(actionId.data).approvalResultCustody === 'live_only') {
      return { ok: false, errorCode: 'approval_result_held', error: 'approval_result_held',
        ...(operationCredentialUses?.length ? { operationCredentialUses } : {}) };
    }
    return { ok: true, result: request.execution.result,
      ...(operationCredentialUses?.length ? { operationCredentialUses } : {}) };
  }
  const failure = readApprovalExecutionFailure(request);
  return failure && operationCredentialUses?.length
    ? { ...failure, operationCredentialUses } : failure;
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
  let reason: ApprovalStaleReason = 'origin_not_current';
  try {
    const current = await args.check(value => { reason = value; });
    return current ? { status: 'current' } : { status: 'stale', reason };
  } catch (error) {
    const failure = normalizeActionExecutorThrownError(error);
    if (failure.errorCode === 'project_requester_home_unavailable') {
      return { status: 'requester_home_unavailable', error };
    }
    return { status: 'read_failed', error, failure };
  }
}

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
  // Only an explicit typed failed result can refine the dispatch fact. A
  // missing value or a thrown failure's normalization retains uncertainty.
  const effectAttempted = !exec.ok && typeof exec.effectAttempted === 'boolean'
    ? exec.effectAttempted : args.dispatchEffectAttempted;
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
      ? { executedAtMs, effectAttempted, ok: true, result: persistedExec.result }
      : request.v === 2
        ? projectApprovalExecutionFailureV2({ request, failure: persistedExec, executedAtMs, effectAttempted })
        : { executedAtMs, ok: false, errorCode: persistedExec.errorCode, error: persistedExec.error },
  };
  const nextExecuted: ApprovalRequest = settledRequest.v === 2
    ? { ...settledRequest, ...executionReceipt,
        status: exec.ok ? 'executed' : effectAttempted && isActionOutcomeUnknownErrorCodeV1(exec.errorCode) ? 'outcome_unknown' : 'failed' }
    : { ...settledRequest, ...executionReceipt, status: exec.ok ? 'executed' : 'failed' };
  if (nextExecuted.v === 2 && effectAttempted && persistedExec.operationCredentialUses?.length) {
    nextExecuted.execution = { ...nextExecuted.execution!, operationCredentialUses: [...persistedExec.operationCredentialUses] };
  }
  return { request: nextExecuted, exec };
}
