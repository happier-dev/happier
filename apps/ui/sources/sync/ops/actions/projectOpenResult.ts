import { OpenProjectResultV1Schema, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

/** UI Open completes when its committed Workspace is usable through the one pushed row owner. */
export async function completeUiProjectOpenResult(account: LazyActionAccountContext | undefined, response: unknown, signal?: AbortSignal): Promise<OpenProjectResultV1 | ActionApprovalRequestCreatedResult> {
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response);
    if (approval.success && approval.data.actionId === 'projects.open') return approval.data;
    const result = OpenProjectResultV1Schema.parse(response);
    if (account && result.kind === 'opened') {
        await withActionAccountRequestSignal(account, signal,
            ownedSignal => createUiProjectAccountRowsClient(account).waitForWorkspaceRef(result.workspace, ownedSignal));
    }
    return result;
}
