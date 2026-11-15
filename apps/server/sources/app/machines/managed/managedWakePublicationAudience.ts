import { areCurrentSessionInputMachineTargetsInTx, readStoredCommittedSessionInputMachineTarget } from '@/app/session/messages/sessionInputAdmission';
import { getDbProviderFromEnv } from '@/storage/db';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { readManagedWakeTargetBindingsInTx } from './managedWakeBinding';
import { readManagedWakeSessionsInTx, readPendingManagedWakeTargetsInTx } from './managedWakePlacement';

/** Exact wake publication audience; admission owners project one captured set of current facts. */
export async function readManagedWakePublicationAccountIdsInTx(tx: Tx, input: Readonly<{
    machineTargets: readonly Readonly<{ accountId: string; machineId: string }>[];
    sessionIds: readonly string[];
}>): Promise<string[]> {
    const targets = new Map(input.machineTargets.map(target => [JSON.stringify(target), target]));
    const sessions = await readManagedWakeSessionsInTx(tx, input.sessionIds);
    const committed = sessions.flatMap(session => {
        const target = readStoredCommittedSessionInputMachineTarget(session);
        return target ? [target] : [];
    });
    const currentness = await areCurrentSessionInputMachineTargetsInTx(tx, committed);
    for (const [index, placement] of committed.entries()) if (currentness[index]) {
        const target = { accountId: placement.accountId, machineId: placement.machineId };
        targets.set(JSON.stringify(target), target);
    }
    // A stale committed placement never falls back to pending accepted input.
    const pending = await readPendingManagedWakeTargetsInTx(tx,
        sessions.filter(session => session.archivedAt === null && session.runtimeMachineTarget == null));
    for (const session of sessions) {
        const placement = pending.get(session.id);
        if (placement) {
            const target = { accountId: session.accountId, machineId: placement.enrolledMachineId };
            targets.set(JSON.stringify(target), target);
        }
    }
    const targetList = [...targets.values()];
    const machineIds = [...new Set(targetList.map(target => target.machineId))];
    const accountIds = new Set<string>();
    if (machineIds.length > 0 && getDbProviderFromEnv(process.env, 'postgres') === 'postgres') {
        const machines = await tx.$queryRawUnsafe<Array<{ accountId: string }>>(
            'SELECT "accountId" FROM "Machine" WHERE "id" = ANY($1::text[])', machineIds);
        for (const machine of machines) accountIds.add(machine.accountId);
    } else for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        const machines = await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: { accountId: true } });
        for (const machine of machines) accountIds.add(machine.accountId);
    }
    const bindings = await readManagedWakeTargetBindingsInTx(tx,
        targetList.map(target => ({ actorAccountId: target.accountId, machineId: target.machineId })));
    for (const binding of bindings) if (binding?.controllerRole === 'manage' && binding.controllerAccountId) {
        accountIds.add(binding.controllerAccountId);
    }
    return [...accountIds].sort();
}
