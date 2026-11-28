import type { ApprovalExecutionV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions';
import { isActionOutcomeUnknownErrorCodeV1, type ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildTargetActionApprovalDecisionResult } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { projectDatabaseReadAccessCreateApprovalRecoveryV1 } from '@happier-dev/protocol/actions/databaseActionMetadata';

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
  execution: Omit<ApprovalExecutionV2, 'executedAtMs'>;
  failureDetails?: unknown;
  executedAtMs: number;
  write(request: TargetActionApprovalRequestV1): Promise<boolean>;
}>): Promise<TargetActionApprovalRequestV1 | null> {
  const { request, execution, executedAtMs } = input;
  const { details, ...receipt } = execution;
  const recovery = execution.ok ? undefined : projectDatabaseReadAccessCreateApprovalRecoveryV1(
    request.qualifiedActionId, execution.errorCode, details ?? input.failureDetails);
  const terminal: TargetActionApprovalRequestV1 = {
    ...request, status: execution.ok ? 'executed' : 'failed', updatedAtMs: executedAtMs,
    execution: { ...receipt, executedAtMs, ...(recovery ?? (details === undefined ? {} : { details })),
      ...(execution.ok || execution.operationCredentialUses?.length ? { effectAttempted: true } : {}) },
  };
  const settled = !execution.ok && isActionOutcomeUnknownErrorCodeV1(execution.errorCode)
    ? targetActionOutcomeUnknown(terminal, executedAtMs) : terminal;
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
  const execution = result.ok ? { ok: true, result: result.result }
    : { ok: false, errorCode: result.errorCode, error: result.error,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
        ...(result.effectAttempted === undefined ? {} : { effectAttempted: result.effectAttempted }),
        ...(result.failureCause === undefined ? {} : { failureCause: result.failureCause }) };
  const settled = await persistTargetActionReceipt({ request, executedAtMs,
    ...(result.ok || result.details === undefined ? {} : { failureDetails: result.details }),
    execution: { ...execution, ...(operationCredentialUses.length ? { operationCredentialUses: [...operationCredentialUses] } : {}) },
    write: async request => (await persist(request)) === null });
  if (!settled) {
    return { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' };
  }
  return result.ok || settled.status === 'outcome_unknown' ? buildTargetActionApprovalDecisionResult(settled)
    : operationCredentialUses.length ? { ...result, operationCredentialUses: [...operationCredentialUses] } : result;
}
