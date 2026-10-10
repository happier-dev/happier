import { ActionOperationCancelV1ResponseSchema, type ActionOperationCancelV1Response } from '@happier-dev/protocol/actions/operations/v1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

export type ActionOperationStopTarget = Pick<ActionOperationProjection, 'serverId' | 'snapshot'>;
export type ActionOperationStopResponse = ActionOperationCancelV1Response | ReturnType<typeof ActionApprovalRequestCreatedResultSchema.parse>;
export type ActionOperationStopContext = Readonly<{ expectedAccountId?: string; signal?: AbortSignal }>;

export async function requestActionOperationStop(
    operation: ActionOperationStopTarget,
    context: ActionOperationStopContext = {},
): Promise<ActionOperationStopResponse> {
    if (!operation.serverId) return { kind: 'not_found' };
    if (context.expectedAccountId && context.expectedAccountId !== operation.snapshot.scope.accountId) {
        throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    }
    const result = await createDefaultActionExecutor().execute('action.operations.cancel', {
        machineId: operation.snapshot.scope.machineId,
        operationId: operation.snapshot.operationId,
        serverId: operation.serverId,
    }, { ...context, expectedAccountId: operation.snapshot.scope.accountId,
        surface: 'ui', authority: 'present_user', serverId: operation.serverId });
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return approval.data;
    return ActionOperationCancelV1ResponseSchema.parse(result.result);
}

export async function requestAcceptedActionOperationStop(operation: ActionOperationProjection, context?: ActionOperationStopContext): Promise<ActionOperationStopResponse> {
    const result = await requestActionOperationStop(operation, context);
    if (result.kind !== 'requested' && result.kind !== 'already_settled' && result.kind !== 'approval_request_created') {
        throw new Error(`Action operation stop was not accepted: ${result.kind}`);
    }
    return result;
}
