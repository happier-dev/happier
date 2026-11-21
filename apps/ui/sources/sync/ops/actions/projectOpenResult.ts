import { OpenProjectResultV1Schema, projectOpenProjectRefusalV1, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

/** UI Open completes when its committed Workspace is usable through the one pushed row owner. */
export async function completeUiProjectOpenResult(account: LazyActionAccountContext | undefined, response: unknown,
    options: Readonly<{ signal?: AbortSignal; requestId?: string }>): Promise<OpenProjectResultV1 | ActionApprovalRequestCreatedResult | ActionExecuteFailure> {
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response);
    if (approval.success && approval.data.actionId === 'projects.open') return approval.data;
    const result = OpenProjectResultV1Schema.parse(response);
    if (account && result.kind === 'opened') {
        await withActionAccountRequestSignal(account, options.signal,
            ownedSignal => createUiProjectAccountRowsClient(account).waitForWorkspaceRef(result.workspace, ownedSignal));
    }
    // Leave the native review operand to the Action's existing confirmation path.
    if (result.kind === 'refused' && result.code !== 'workspace_private_checkout_review_required' && options.requestId) {
        return { ...projectOpenProjectRefusalV1(result), requestId: options.requestId };
    }
    return result;
}
