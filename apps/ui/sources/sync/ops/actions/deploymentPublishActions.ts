import { DeploymentPublishPrepareInputV1Schema, DeploymentPublishPrepareResultV1Schema,
    type DeploymentPublishPrepareInputV1, type DeploymentPublishPrepareResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ActionApprovalRequestCreatedResultSchema,
    type ActionExecuteFailure, type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { MountedAuthoringActionExecute } from './sessionAuthoringActions';

/** Store and New app enter the existing Publish owner with the unchanged pinned operand. */
export async function prepareCatalogAppPublish(input: DeploymentPublishPrepareInputV1,
    lifetime: ServerAccountScopeLifetime, executeAction: MountedAuthoringActionExecute,
    signal?: AbortSignal): Promise<DeploymentPublishPrepareResultV1 | ActionApprovalRequestCreatedResult | ActionExecuteFailure> {
    const stale = (): ActionExecuteFailure => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
    if (!lifetime.isCurrent()) return stale();
    const result = await executeAction('deployments.publish.prepare', DeploymentPublishPrepareInputV1Schema.parse(input), { signal });
    if (!lifetime.isCurrent()) return stale();
    if (!result.ok) return result;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success && approval.data.actionId === 'deployments.publish.prepare') return approval.data;
    const parsed = DeploymentPublishPrepareResultV1Schema.safeParse(result.result);
    return parsed.success ? parsed.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
}
