import type { ProviderBrokerAdmissionFailureCodeV1, ProviderBrokerConsumerV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { hasCurrentSessionScopedMachineAccessInTx } from '@/app/api/socket/sessionScopedBinding';
import type { Tx } from '@/storage/inTx';
import { readMachineIrohEndpointAuthorityV1, type MachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';

export type ProviderBrokerConsumerCurrentness = Readonly<{
    parentSessionId: string | null;
    occurrenceId: string;
}>;

type AdmittedConsumerSession = Readonly<{
    accountId: string;
    active: boolean;
    archivedAt: Date | null;
    primaryTeamId: string | null;
    latestTurnId: string | null;
    latestTurnStatus: string | null;
}>;

/** Presence expiry preserves the current publisher fence so its next heartbeat
 * can restore reachability. Both refusals keep the broker closed. */
export function classifyProviderBrokerSessionPresence(session: Readonly<{
    active: boolean;
    publisherFenceCurrent: boolean;
}>): 'session_not_active' | 'broker_unavailable' | null {
    if (session.active) return null;
    return session.publisherFenceCurrent ? 'broker_unavailable' : 'session_not_active';
}

/** Capture custody during preparation, then admit the complete Account cohort
 * before final deciding reads. Serializing admission excludes grant/lifecycle
 * publication (NO KEY UPDATE) and physical erasure (UPDATE), while reusing the
 * existing sorted Account owner. Callers recheck custody under these locks. */
export async function acquireProviderBrokerConsumerAdmissionInTx(tx: Tx, input: Readonly<{
    accountIds: readonly string[];
    custodianAccountIds: readonly string[];
}>): Promise<void> {
    await acquireAccountChangePublicationLocksInTx(tx, [...input.accountIds, ...input.custodianAccountIds], {
        includeSingleAccount: true, intent: 'serializing',
    });
}

/** A Machine can broker through its own active carrier admission. Endpoint
 * identity must agree with Machine identity: another Machine cannot claim that
 * endpoint, and a self placement cannot redirect to a different endpoint.
 * Endpoint availability remains the transport admission owner's separate check. */
export function admitProviderBrokerTopology(
    initiator: Readonly<{ machineId: string; endpointId: string }>,
    target: Readonly<{ machineId: string; endpointId: string | null }>,
): Readonly<{ ok: true }> | Readonly<{ ok: false; reasonCode: 'resource_unavailable' }> {
    return (initiator.machineId === target.machineId) !== (initiator.endpointId === target.endpointId)
        ? { ok: false, reasonCode: 'resource_unavailable' }
        : { ok: true };
}

/** Endpoint custody is independent of requester identity. Session consumers
 * already prove Machine Use through the exact AccessKey at consumer admission;
 * sessionless Runs need their own admission here. Both source arms use this reader. */
export async function readProviderBrokerInitiatorEndpointInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; machineId: string; sessionId: string | null }>,
): Promise<(MachineIrohEndpointAuthorityV1 & Readonly<{ machineKind: string; custodianAccountId: string }>) | null> {
    const machine = await tx.machine.findUnique({
        where: { id: input.machineId },
        select: {
            accountId: true,
            kind: true,
            revokedAt: true,
            replacedByMachineId: true,
            operationProtocolCapabilities: true,
            operationProtocolCapabilitiesRevision: true,
        },
    });
    if (!machine || classifyMachineAvailabilityState(machine) !== 'available') return null;
    if (machine.accountId !== input.accountId && input.sessionId === null) {
        const admission = await resolveMachineAdmissionInTx(tx, {
            actorAccountId: input.accountId, machineId: input.machineId,
        });
        if (admission.kind !== 'admitted') return null;
    }
    const endpoint = readMachineIrohEndpointAuthorityV1({
        capabilities: machine.operationProtocolCapabilities,
        revision: machine.operationProtocolCapabilitiesRevision,
    });
    return endpoint ? { ...endpoint, machineKind: machine.kind, custodianAccountId: machine.accountId } : null;
}

/** Session/Run identity and Machine access are independent of the source arm.
 * Team entitlement and the hub's private catalog remain their own authorities. */
export async function admitProviderBrokerConsumerInTx(tx: Tx, input: Readonly<{
    accountId: string;
    initiatorMachineId: string;
    consumer: ProviderBrokerConsumerV1;
    executionRun: ProviderBrokerConsumerCurrentness | null;
}>): Promise<Readonly<{ ok: true; executionRunOccurrenceId: string | null; session: AdmittedConsumerSession | null }> | Readonly<{ ok: false; reasonCode: ProviderBrokerAdmissionFailureCodeV1 }>> {
    if (input.consumer.kind === 'execution_run' && !input.executionRun) {
        return { ok: false, reasonCode: 'execution_run_authority_unavailable' };
    }
    const sessionId = input.consumer.kind === 'session' ? input.consumer.sessionId : input.executionRun?.parentSessionId;
    let session: AdmittedConsumerSession | null = null;
    if (sessionId) {
        const observed = await tx.session.findUnique({ where: { id: sessionId }, select: {
            accountId: true, active: true, archivedAt: true, primaryTeamId: true, latestTurnId: true, latestTurnStatus: true,
            lastActiveAt: true, publisherGenerationLastActiveAt: true,
        } });
        if (!observed || observed.accountId !== input.accountId || observed.archivedAt !== null) {
            return { ok: false, reasonCode: 'session_not_active' };
        }
        const { lastActiveAt, publisherGenerationLastActiveAt, ...sessionFacts } = observed;
        const refusal = classifyProviderBrokerSessionPresence({
            active: sessionFacts.active,
            publisherFenceCurrent: publisherGenerationLastActiveAt?.getTime() === lastActiveAt.getTime(),
        });
        if (refusal) return { ok: false, reasonCode: refusal };
        session = sessionFacts;
        if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, accountId: input.accountId,
            machineId: input.initiatorMachineId, sessionId })) return { ok: false, reasonCode: 'resource_forbidden' };
    }
    return { ok: true, executionRunOccurrenceId: input.consumer.kind === 'execution_run' ? input.executionRun!.occurrenceId : null, session };
}
