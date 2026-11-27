import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { resolvePendingMutationIdentity } from '@/sync/engine/pending/pendingQueueV2';
import { sync } from '@/sync/sync';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Retained input and confirmed provider-direct cleanup have one Action owner. */
export function createUiPendingSendNowAction(
    account: LazyActionAccountContext,
    deliverHeldOriginal: (input: Parameters<NonNullable<ActionExecutorDeps['sessionPendingSendNow']>>[0],
        target: NonNullable<Awaited<ReturnType<typeof resolvePendingMutationIdentity>>['target']>) => Promise<unknown>,
): NonNullable<ActionExecutorDeps['sessionPendingSendNow']> {
    return async input => {
        account.assertCurrent();
        const { target, localId } = await resolvePendingMutationIdentity(input.sessionId, input.localId,
            account.accountLifetime.scope, input.targetExecutionRunId);
        account.assertCurrent();
        if (!target) return { ok: false, errorCode: 'pending_message_not_loaded', error: 'pending_message_not_loaded' };
        if (input.deliveryIntent === 'deliver_and_resume') return await deliverHeldOriginal(input, target);
        const owner = { serverId: account.serverId, accountLifetime: account.accountLifetime,
            ...(input.targetExecutionRunId ? { targetExecutionRunId: input.targetExecutionRunId } : {}) };
        const result = await sync.sendPendingMessageNow(input.sessionId, {
            localId, createdAt: target.createdAt, rawRecord: target.rawRecord, text: target.text,
            displayText: target.displayText, deliveryIntent: input.deliveryIntent,
        }, owner);
        account.assertCurrent();
        // Only positively confirmed legacy provider delivery retires a legacy row.
        // Durable/acceptance-pending inputs keep their existing custody settlement.
        if (result.type === 'committed' && result.persistence === 'provider_direct' && result.providerAcceptancePending !== true) {
            try { await sync.deletePendingMessage(input.sessionId, target.id, owner); }
            catch (deleteError) {
                account.assertCurrent();
                try { await sync.discardPendingMessage(input.sessionId, target.id, owner); }
                catch { throw deleteError; }
            }
        }
        return result;
    };
}
