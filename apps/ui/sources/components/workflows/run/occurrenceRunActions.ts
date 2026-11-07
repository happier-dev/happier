import type { AutomationOccurrenceActionId, AutomationOccurrenceInput } from '@happier-dev/protocol/actions';
import type { WorkflowRunCancelRequestV1 } from '@happier-dev/protocol/workflows';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** The displayed Home/Account lifetime remains authoritative while approval is pending. */
export async function executeOccurrenceRunAction<TAction extends AutomationOccurrenceActionId | 'workflow.run.cancel'>(
    actionId: TAction,
    input: TAction extends 'workflow.run.cancel' ? WorkflowRunCancelRequestV1 : AutomationOccurrenceInput,
    lifetime: ServerAccountScopeLifetime | null,
): Promise<boolean> {
    if (!lifetime?.isCurrent()) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    const cancellation = new AbortController();
    const retirement = lifetime.onRetire(() => cancellation.abort());
    try {
        const result = await createDefaultActionExecutor().execute(actionId, input, {
            surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
            expectedAccountId: lifetime.scope.accountId, signal: cancellation.signal,
        });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode, details: result.details });
        return !ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success;
    } finally { retirement.dispose(); }
}
