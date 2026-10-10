import type { ProviderBrokerAdmissionFailureCodeV1, ProviderBrokerConsumerV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { hasCurrentSessionScopedMachineAccessInTx } from '@/app/api/socket/sessionScopedBinding';
import type { Tx } from '@/storage/inTx';

export type ProviderBrokerConsumerCurrentness = Readonly<{
    parentSessionId: string | null;
    occurrenceId: string;
}>;

/** Session/Run identity and Machine access are independent of the source arm.
 * Team entitlement and the hub's private catalog remain their own authorities. */
export async function admitProviderBrokerConsumerInTx(tx: Tx, input: Readonly<{
    accountId: string;
    initiatorMachineId: string;
    consumer: ProviderBrokerConsumerV1;
    executionRun: ProviderBrokerConsumerCurrentness | null;
}>): Promise<Readonly<{ ok: true; executionRunOccurrenceId: string | null }> | Readonly<{ ok: false; reasonCode: ProviderBrokerAdmissionFailureCodeV1 }>> {
    if (input.consumer.kind === 'execution_run' && !input.executionRun) {
        return { ok: false, reasonCode: 'execution_run_authority_unavailable' };
    }
    const sessionId = input.consumer.kind === 'session' ? input.consumer.sessionId : input.executionRun?.parentSessionId;
    if (sessionId) {
        const session = await tx.session.findUnique({ where: { id: sessionId }, select: { accountId: true, active: true } });
        if (!session || session.accountId !== input.accountId || !session.active) return { ok: false, reasonCode: 'session_not_active' };
        if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, accountId: input.accountId,
            machineId: input.initiatorMachineId, sessionId })) return { ok: false, reasonCode: 'resource_forbidden' };
    }
    return { ok: true, executionRunOccurrenceId: input.consumer.kind === 'execution_run' ? input.executionRun!.occurrenceId : null };
}
