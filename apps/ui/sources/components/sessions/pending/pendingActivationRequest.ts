import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/**
 * Re-arms (Process when online) or keeps queued the exact held input through the existing
 * `session.pending.action.set`. The composer's banner and the Inbox's wake Retry both call it.
 * Returns false when the Account changed before the answer; failures throw for the caller to present.
 */
export async function submitPendingActivationRequest(input: Readonly<{
    actionExecutor: Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'>;
    lifetime: ServerAccountScopeLifetime;
    sessionId: string;
    row: PendingMessage & Readonly<{ localId: string }>;
    action: 'process_when_online' | 'keep_queued';
    signal: AbortSignal;
    onApprovalPending: (registration: ActionApprovalContinuation) => void;
}>): Promise<boolean> {
    const { lifetime, row, action } = input;
    const requestedAction = row.pendingRequestedAction;
    const actionInput = { sessionId: input.sessionId, localId: row.localId, serverId: lifetime.scope.serverId,
        requestedAction: action === 'keep_queued' && requestedAction?.kind === 'send_now'
            ? { v: 1, kind: 'enqueue' } : requestedAction ?? { v: 1, kind: 'enqueue' },
        resumeWhenAvailable: action === 'process_when_online' };
    const initial = await input.actionExecutor.execute('session.pending.action.set', actionInput, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: input.signal,
    });
    if (!lifetime.isCurrent()) return false;
    requireActionSuccess(await resumeActionExecutionResult({ result: initial, actionId: 'session.pending.action.set',
        actionInput, scope: lifetime.scope, signal: input.signal, onApprovalPending: input.onApprovalPending }));
    return lifetime.isCurrent();
}
