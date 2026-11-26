import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ProjectServiceRelocateResultV1Schema, type ProjectServiceRelocateInputV1, type ProjectServiceRelocateResultV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { executeLocalServiceActionWithAdmission, type LocalServiceActionAdmission } from '@/components/sessions/localServices/localServiceActionAdmission';
import type { FrontDoorRuntimeActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export type ServiceRelocationOutcome = ProjectServiceRelocateResultV1
  | (ActionExecuteFailure & Readonly<{ status: 'failed' }>);

/** Consume the canonical Action result; the execute port is the addressed daemon/front door. */
export async function executeServiceRelocationAction(input: Readonly<{
  execute: FrontDoorRuntimeActionExecute;
  request: ProjectServiceRelocateInputV1;
  context: Parameters<FrontDoorRuntimeActionExecute>[0]['context'];
  /** The mounted Move review disclosed this exact request and the person pressed Move. */
  confirmed?: true;
  admission: LocalServiceActionAdmission & Required<Pick<LocalServiceActionAdmission, 'onApprovalPending'>> & Readonly<{ expectedAccountId: string }>;
}>): Promise<ServiceRelocationOutcome> {
  const value = await executeLocalServiceActionWithAdmission({ execute: input.execute,
    request: { actionId: 'projects.service.relocate', input: input.request, context: input.context }, admission: input.admission,
    ...(input.confirmed ? { confirmation: async (review) => review.actionId === 'projects.service.relocate'
      && sameStrictJsonValue(review.input, input.request) } : {}) });
  const failure = readActionFailureEnvelope(value);
  if (failure) return { ...failure, status: 'failed' };
  const result = ProjectServiceRelocateResultV1Schema.safeParse(value);
  if (result.success && (result.data.status !== 'accepted' || (
    result.data.operation.scope.accountId === input.admission.expectedAccountId
    && result.data.operation.actionId === 'projects.service.relocate'
    && result.data.operation.requestId === input.request.requestId))) return result.data;
  const errorCode = result.success ? 'operation_binding_mismatch' : 'invalid_action_output';
  return { status: 'failed', ok: false, errorCode, error: errorCode };
}
