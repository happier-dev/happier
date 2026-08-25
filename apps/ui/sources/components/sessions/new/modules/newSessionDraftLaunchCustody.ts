import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

export function isNewSessionDraftLaunchInCustody(params: Readonly<{
    accountId: string;
    launchUserAttemptId?: string;
    operations: readonly ActionOperationProjection[];
}>): boolean {
    if (!params.launchUserAttemptId) return false;
    return params.operations.some(({ snapshot }) => (
        snapshot.requestId === params.launchUserAttemptId
        && snapshot.scope.accountId === params.accountId
        && snapshot.actionId === 'session.spawn_new'
        && (snapshot.state === 'accepted' || snapshot.state === 'running' || snapshot.state === 'succeeded')
    ));
}
