import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

export function isNewSessionDraftLaunchOperationInCustody(params: Readonly<{
    accountId: string;
    launchUserAttemptId: string | null | undefined;
    operation: ActionOperationSnapshotV1 | null;
}>): boolean {
    const { launchUserAttemptId, operation } = params;
    return Boolean(
        launchUserAttemptId
        && operation
        && operation.requestId === launchUserAttemptId
        && operation.scope.accountId === params.accountId
        && operation.actionId === 'session.spawn_new'
        && (operation.state === 'accepted' || operation.state === 'running' || operation.state === 'succeeded')
    );
}

export function isNewSessionDraftLaunchInCustody(params: Readonly<{
    accountId: string;
    launchUserAttemptId?: string;
    operations: readonly ActionOperationProjection[];
}>): boolean {
    if (!params.launchUserAttemptId) return false;
    return params.operations.some(({ snapshot }) => isNewSessionDraftLaunchOperationInCustody({
        accountId: params.accountId,
        launchUserAttemptId: params.launchUserAttemptId,
        operation: snapshot,
    }));
}
