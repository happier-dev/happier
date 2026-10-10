import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { FilesystemMutationOutputSchema, type FilesystemMutationActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { WorkspaceFileSystemTarget } from './directoryBrowsing';

export type WorkspaceFileSystemMutationResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string; approvalArtifactId?: string }>;

/** Admission owns policy and approval; its existing terminal owns the Machine RPC. */
export async function invokeWorkspaceFileSystemMutation(
    target: WorkspaceFileSystemTarget,
    actionId: Exclude<FilesystemMutationActionId, 'daemon.filesystem.copy'>,
    input: unknown,
): Promise<WorkspaceFileSystemMutationResponse> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    const serverId = target.serverId || lifetime?.scope.serverId;
    if (!serverId) return { success: false, errorCode: 'action_home_not_found', error: 'action_home_not_found' };
    const activeTarget = lifetime && areServerProfileIdentifiersEquivalent(serverId, lifetime.scope.serverId);
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    if (activeTarget && !lifetime.isCurrent()) return { success: false,
        errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
    const result = await createFrontDoorActionExecute(createDefaultActionExecutor())(actionId, input, {
        surface: 'ui', authority: 'present_user',
        serverId,
        ...(activeTarget ? { expectedAccountId: lifetime.scope.accountId } : {}),
        externalActionTarget: { kind: 'machine', machineId: target.machineId },
    });
    if (!result.ok) return { success: false, error: result.error, errorCode: result.errorCode };
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return { success: false, errorCode: 'approval_required',
        error: 'The Action awaits approval.', approvalArtifactId: approval.data.artifactId };
    const parsed = FilesystemMutationOutputSchema.safeParse(result.result);
    return parsed.success ? parsed.data : { success: false, errorCode: 'invalid_action_output',
        error: 'The filesystem Action response could not be validated.' };
}
