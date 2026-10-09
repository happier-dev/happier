import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { RuntimeActionExecute, RuntimeActionExecuteArgs } from '@happier-dev/protocol/actions/executor/types';
import { ProjectServiceRelocateResultV1Schema, type ProjectServiceRelocateInputV1, type ProjectServiceRelocateResultV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { executeLocalServiceActionWithAdmission, type LocalServiceActionAdmission } from '@/components/sessions/localServices/localServiceActionAdmission';

export type ServiceRelocationOutcome = ProjectServiceRelocateResultV1
  | Readonly<{ status: 'failed'; errorCode: string }>
  | Readonly<{ status: 'approval'; artifactId: string }>;

/** Consume the canonical Action result; the execute port is the addressed daemon/front door. */
export async function executeServiceRelocationAction(input: Readonly<{
  execute: RuntimeActionExecute;
  request: ProjectServiceRelocateInputV1;
  context: RuntimeActionExecuteArgs['context'];
  admission: LocalServiceActionAdmission;
}>): Promise<ServiceRelocationOutcome> {
  const value = await executeLocalServiceActionWithAdmission({ execute: input.execute,
    request: { actionId: 'projects.service.relocate', input: input.request, context: input.context }, admission: input.admission });
  const failure = ActionExecuteFailureSchema.safeParse(value);
  if (failure.success) return { status: 'failed', errorCode: failure.data.errorCode };
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(value);
  if (approval.success) return { status: 'approval', artifactId: approval.data.artifactId };
  const result = ProjectServiceRelocateResultV1Schema.safeParse(value);
  if (result.success && result.data.status === 'accepted' && (result.data.operation.scope.accountId !== input.admission.expectedAccountId
    || result.data.operation.actionId !== 'projects.service.relocate' || result.data.operation.requestId !== input.request.requestId)) {
    return { status: 'failed', errorCode: 'operation_binding_mismatch' };
  }
  return result.success ? result.data : { status: 'failed', errorCode: 'invalid_action_output' };
}
