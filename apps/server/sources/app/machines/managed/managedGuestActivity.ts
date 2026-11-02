import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    type ManagedActivityRpcRequestV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import type { Tx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { ManagedMachineError, readManagedMachineInTx, readManagedEnrollmentAccountId, projectManagedMachine,
    readManagedController, sameManagedInput, resolveManagedMachineRoleInTx,
    requireManagedControllerInTx, inManagedMachinePublicationTx, invalidateManagedMachineInTx, type StoredManagedMachine } from './managedRows';

type ManagedGuestPublisher = Readonly<{ accountId: string; machineId: string; installationId: string }>;

/** Exact enrolled publisher correlation; ordinary Machine data stays with its recipients. */
export async function readManagedGuestActivityPublicationRowInTx(tx: Tx, input: ManagedGuestPublisher): Promise<StoredManagedMachine | null> {
    const row = await tx.managedMachine.findFirst({ where: { enrolledMachineId: input.machineId } });
    if (!row || row.homeId !== await readCurrentServerIdentityId(process.env, tx)
        || readManagedEnrollmentAccountId(row) !== input.accountId || row.custodianAccountId === input.accountId
        || row.creationState !== 'active' || row.archivedAt !== null) return null;
    const guest = await tx.machine.findUnique({ where: { id: input.machineId },
        select: { accountId: true, installationId: true, revokedAt: true, replacedByMachineId: true } });
    return guest && guest.accountId === input.accountId && guest.installationId === input.installationId
        && guest.revokedAt === null && guest.replacedByMachineId === null ? row : null;
}

/** A newly available guest handler wakes its native policy through the existing feed. */
export async function publishManagedGuestActivityAvailable(input: ManagedGuestPublisher): Promise<void> {
    const target = await db.managedMachine.findFirst({ where: { enrolledMachineId: input.machineId },
        select: { homeId: true, id: true } });
    if (!target) return;
    await inManagedMachinePublicationTx({ homeId: target.homeId, managedId: target.id }, async tx => {
        const row = await readManagedGuestActivityPublicationRowInTx(tx, input);
        if (!row || row.id !== target.id) return;
        await invalidateManagedMachineInTx(tx, row);
    });
}

/** Native custody admits only content-free activity/drain on this exact enrolled resource. */
export async function resolveManagedGuestActivityAdmissionInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; machineId: string; rpcMethod: string;
    target: ManagedActivityRpcRequestV1; requireOnline?: boolean;
}>) {
    if (input.rpcMethod !== MANAGED_ACTIVITY_READ_RPC_METHOD && input.rpcMethod !== MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD
        || input.rpcMethod === MANAGED_ACTIVITY_READ_RPC_METHOD && 'action' in input.target) return null;
    try {
        const row = await readManagedMachineInTx(tx, input.target);
        const release = input.rpcMethod === MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD
            && 'action' in input.target && input.target.action === 'resume';
        if (row.enrolledMachineId !== input.machineId || !sameManagedInput(readManagedController(row), input.target.controller)
            || !release && (row.intentRevision !== input.target.expectedRevision || row.creationState !== 'active'
                || row.archivedAt !== null || row.allocation !== 'bound' || row.resource === null)) return null;
        if (await resolveManagedMachineRoleInTx(tx, row, input.actorAccountId) !== 'manage') return null;
        await requireManagedControllerInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId,
            controller: input.target.controller });
        const enrollmentAccountId = readManagedEnrollmentAccountId(row);
        const unusedRetention = projectManagedMachine(row).retention.kind === 'unused';
        if (enrollmentAccountId !== row.custodianAccountId && !release && !unusedRetention
            && !(row.desiredWhen === 'after-idle' && ['stop', 'suspend', 'delete'].includes(row.desired))) return null;
        // Validate the guest through its actual owner without exposing its private
        // Machine record or giving the native custodian an ordinary guest grant.
        const guest = await resolveMachineAdmissionInTx(tx, { actorAccountId: enrollmentAccountId,
            machineId: input.machineId, rpcMethod: input.rpcMethod, requireOnline: input.requireOnline });
        return guest.kind === 'admitted' && guest.custodianAccountId === enrollmentAccountId
            ? { ...guest, actorAccountId: input.actorAccountId } : null;
    } catch (error) {
        if (error instanceof ManagedMachineError) return null;
        throw error;
    }
}
