import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions';
import { isActionOutcomeUnknownErrorCodeV1, type ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildTargetActionApprovalDecisionResult } from '@happier-dev/protocol/actions/targetActionApprovalDecision';

/** Unknown means an effect may have happened; it never grants another execution. */
export function targetActionOutcomeUnknown(request: TargetActionApprovalRequestV1, now = Date.now()): TargetActionApprovalRequestV1 {
  const executedAtMs = Math.max(now, request.updatedAtMs);
  return { ...request, status: 'outcome_unknown', updatedAtMs: executedAtMs,
    execution: { executedAtMs, ok: false, effectAttempted: true,
      errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown',
      ...(request.execution?.operationCredentialUses?.length
        ? { operationCredentialUses: request.execution.operationCredentialUses } : {}) } };
}

/** One receipt-write policy for daemon and original-invocation custody. */
export async function persistTargetActionReceipt(input: Readonly<{
  request: TargetActionApprovalRequestV1;
  write(request: TargetActionApprovalRequestV1): Promise<boolean>;
}>): Promise<TargetActionApprovalRequestV1 | null> {
  const settled = !input.request.execution?.ok && isActionOutcomeUnknownErrorCodeV1(input.request.execution?.errorCode)
    ? targetActionOutcomeUnknown(input.request, input.request.updatedAtMs) : input.request;
  try {
    if (await input.write(settled)) return settled;
  } catch { /* A lost receipt cannot authorize another effect. */ }
  try { await input.write(targetActionOutcomeUnknown(settled, settled.updatedAtMs)); }
  catch { /* The owning execution lifecycle retains the unresolved claim. */ }
  return null;
}

/** Both the receipt and its unknown-outcome settlement use the incumbent CAS writer. */
export async function settleTargetActionExecution(input: Readonly<{
  request: TargetActionApprovalRequestV1;
  result: ActionExecuteResult;
  operationCredentialUses: readonly ActionOperationCredentialUseV1[];
  persist(request: TargetActionApprovalRequestV1): Promise<ActionExecuteResult | null>;
  executedAtMs: number;
}>): Promise<ActionExecuteResult> {
  const { request, result, operationCredentialUses, persist, executedAtMs } = input;
  const terminal: TargetActionApprovalRequestV1 = { ...request,
    status: result.ok ? 'executed' : 'failed', updatedAtMs: executedAtMs,
    execution: result.ok ? { executedAtMs, ok: true, result: result.result }
      : { executedAtMs, ok: false, errorCode: result.errorCode, error: result.error,
          ...(result.effectAttempted === undefined ? {} : { effectAttempted: result.effectAttempted }),
          ...(result.failureCause === undefined ? {} : { failureCause: result.failureCause }) } };
  if (operationCredentialUses.length && terminal.execution) {
    terminal.execution = { ...terminal.execution, effectAttempted: true, operationCredentialUses: [...operationCredentialUses] };
  }
  const settled = await persistTargetActionReceipt({ request: terminal,
    write: async request => (await persist(request)) === null });
  if (!settled) {
    return { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' };
  }
  return result.ok || settled.status === 'outcome_unknown' ? buildTargetActionApprovalDecisionResult(settled)
    : operationCredentialUses.length ? { ...result, operationCredentialUses: [...operationCredentialUses] } : result;
}
