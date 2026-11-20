import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';

/**
 * Continue after a failed resume makes a new Session that is the same Session to the person, so
 * its "allow for this Session" rows move (never copy) to the child, as the person's own write
 * through the policy Action. A failed move is visible and recoverable: the person is asked again.
 */
export async function moveSessionApprovalConsentsOnContinue(input: Readonly<{
    scope: ServerAccountScope; fromSessionId: string; toSessionId: string;
}>): Promise<void> {
    if (input.fromSessionId === input.toSessionId) return;
    const execute = createFrontDoorActionExecute();
    await execute('actions.policy.set', { sessionConsentsMove: { fromSessionId: input.fromSessionId, toSessionId: input.toSessionId } }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: input.scope.serverId, expectedAccountId: input.scope.accountId,
    });
}
