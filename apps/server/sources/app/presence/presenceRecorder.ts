import { afterTx, inTx, type Tx } from '@/storage/inTx';
import { lockMachinePresenceInTx, persistMachinePresence, type MachinePresenceRow } from './persistMachinePresence';
import { resolvePresenceTimeoutConfig, renewLocalMachinePresenceDeadline } from './timeout';
import { publishPresenceDeadline } from './presenceRedisQueue';
import { retainMachinePresenceTransitionInTx } from './machinePresenceTransitions';
import { db } from '@/storage/db';
import type { AccountChangePublication } from '@/app/changes/markAccountChanged';

export interface MachineAliveAdmission {
    recipientAccountIds: string[];
    wasOffline: boolean;
    lastActiveAt: Date;
    /** This Machine's publication already queued by the semantic writer. */
    accountChanges?: readonly AccountChangePublication[];
}

/** The containing semantic writer may share the same admitted observation. */
export async function recordMachineAliveInTx(
    tx: Tx,
    params: Readonly<{ accountId: string; machineId: string; timestamp: number }>,
    admitInTx: (tx: Tx, machine: MachinePresenceRow) => Promise<MachineAliveAdmission | null>,
    alreadyLockedRow?: MachinePresenceRow,
): Promise<MachineAliveAdmission | null> {
    const machine = await lockMachinePresenceInTx(tx, params.machineId, alreadyLockedRow);
    if (!machine) return null;
    const current = await admitInTx(tx, machine);
    // Admission may wait for authority or a row lock. An expired beat cannot
    // manufacture a recovery after that wait; future stored facts never regress.
    if (!current || !Number.isFinite(params.timestamp)
        || params.timestamp + resolvePresenceTimeoutConfig().machineTimeoutMs <= Date.now()
        || params.timestamp < current.lastActiveAt.getTime()
        || await persistMachinePresence(tx, params) !== 1) return null;
    if (current.wasOffline) await retainMachinePresenceTransitionInTx(tx, {
        machineId: params.machineId, active: true, occurredAt: params.timestamp,
        recipientAccountIds: current.recipientAccountIds.filter(accountId =>
            !current.accountChanges?.some(publication => publication.accountId === accountId)),
    });
    afterTx(tx, () => {
        renewLocalMachinePresenceDeadline({ ...params, lastActiveAt: new Date(params.timestamp) });
        if (current.wasOffline) void publishPresenceDeadline({ kind: 'machine', accountId: params.accountId,
            id: params.machineId, activeAt: params.timestamp });
    });
    return current;
}

export async function recordMachineAlive(
    params: Readonly<{ accountId: string; machineId: string; timestamp: number }>,
    admitInTx: (tx: Tx, machine: MachinePresenceRow) => Promise<MachineAliveAdmission | null>,
    currentPublisher?: Readonly<{ installationId: string | null }>,
): Promise<MachineAliveAdmission | null> {
    if (currentPublisher) {
        // Socket ingress already admitted ownership and local cancellation.
        // Lifecycle and installation are fenced by the monotonic write.
        if (Number.isFinite(params.timestamp)
            && params.timestamp + resolvePresenceTimeoutConfig().machineTimeoutMs > Date.now()
            && await persistMachinePresence(db, params, currentPublisher) === 1) {
            renewLocalMachinePresenceDeadline({ ...params, lastActiveAt: new Date(params.timestamp) });
            return {
                recipientAccountIds: [],
                wasOffline: false, lastActiveAt: new Date(params.timestamp),
            };
        }
        // Offline recovery still owns its locked transition and notification.
        // A refused/future observation reaches that same owner without renewal.
    }
    return await inTx(tx => recordMachineAliveInTx(tx, params, admitInTx));
}
