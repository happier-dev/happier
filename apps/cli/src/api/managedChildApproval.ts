import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import type { RecordedApprovalExecutionObservationArgs } from '@/session/actions/createCliActionExecutorHarness';

/** Observe the guest's existing approval; only its ordinary executor can decide and record it. */
export async function observeManagedChildApprovalExecution(input: Readonly<{
  execution: ActionExecuteResult;
  context?: ActionExecutorContext;
  signal?: AbortSignal;
  expectedOrigin: RecordedApprovalExecutionObservationArgs['expectedOrigin'];
  isCurrent: NonNullable<RecordedApprovalExecutionObservationArgs['isCurrent']>;
  observeRecordedApprovalExecution?: (args: RecordedApprovalExecutionObservationArgs) => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult> {
  if (!input.execution.ok) return input.execution;
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(input.execution.result);
  const signal = input.signal ?? input.context?.signal;
  if (!approval.success) return input.execution;
  if (!signal || !input.observeRecordedApprovalExecution) return {
    ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable',
  };
  input.context?.operationOwnerUpdate?.update({ progress: {
    phase: 'waiting_for_approval', label: 'Waiting for approval', approval: approval.data,
  } });
  try {
    return await input.observeRecordedApprovalExecution({ artifactId: approval.data.artifactId,
      expectedOrigin: input.expectedOrigin, signal, isCurrent: input.isCurrent });
  } finally {
    input.context?.operationOwnerUpdate?.update({ progress: { label: 'Continuing' } });
  }
}
