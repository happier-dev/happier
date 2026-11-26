import { decodeMachineStoredContent, withMachineContentSelect } from '@/storage/sessionMachineStoredContent';
import type { Prisma } from '@prisma/client';
import { resolveManagedWakeAvailabilityV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { readMachineAudienceAccountIdsForMachinesInTx } from '@/app/machines/machineRecipientWork';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { readManagedController } from './managedMachineProjection';

const CONTROLLER_PRESENCE_SELECT = {
    id: true, installationId: true, active: true, revokedAt: true, replacedByMachineId: true, replacedAt: true,
} as const;
type ControllerPresence = Prisma.MachineGetPayload<{ select: typeof CONTROLLER_PRESENCE_SELECT }>;
type ManagedWakeResource = Readonly<{ id: string; homeId: string; controllerMachineId?: string | null; controllerInstallationId?: string | null }>;

/** Exact projection demand shares one installed-controller read, never its private identity with recipients. */
export async function withManagedWakeAvailabilityInTx<T extends Readonly<{ managedResource: ManagedWakeResource | null }>>(
    tx: Tx, rows: readonly T[], loadedMachines: readonly ControllerPresence[] = [],
) {
    const controllerIds = [...new Set(rows.flatMap(row => row.managedResource?.controllerMachineId
        ? [row.managedResource.controllerMachineId] : []))];
    const controllers = new Map(loadedMachines.map(machine => [machine.id, machine]));
    const missingControllerIds = controllerIds.filter(id => !controllers.has(id));
    for (const ids of portableQueryChunks({ values: missingControllerIds, bindingsPerValue: 1 })) {
        for (const controller of await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: withMachineContentSelect(CONTROLLER_PRESENCE_SELECT) }).then(decodeMachineStoredContent)) {
            controllers.set(controller.id, controller);
        }
    }
    return rows.map(row => {
        const resource = row.managedResource;
        const assigned = resource ? readManagedController({ controllerMachineId: resource.controllerMachineId ?? null,
            controllerInstallationId: resource.controllerInstallationId ?? null }) : undefined;
        const controller = assigned ? controllers.get(assigned.machineId) : undefined;
        return { ...row, managedWakeAvailability: resolveManagedWakeAvailabilityV1(assigned, controller ? {
            id: controller.id, installationId: controller.installationId, online: controller.active,
            revokedAt: controller.revokedAt?.getTime() ?? null, replacedByMachineId: controller.replacedByMachineId,
            replacedAt: controller.replacedAt,
        } : undefined) };
    });
}

/** The structural guest audience shared by admission and semantic controller publication. */
async function readManagedWakeControllerAudiencesInTx(tx: Tx, controllerMachineIds: readonly string[]) {
    const enrolledMachineIds: string[] = [];
    for (const ids of portableQueryChunks({ values: [...new Set(controllerMachineIds)], bindingsPerValue: 1 })) {
        const resources = await tx.managedMachine.findMany({
            where: { controllerMachineId: { in: [...ids] }, enrolledMachineId: { not: null } },
            select: { enrolledMachineId: true },
        });
        for (const resource of resources) {
            if (resource.enrolledMachineId) enrolledMachineIds.push(resource.enrolledMachineId);
        }
    }
    return readMachineAudienceAccountIdsForMachinesInTx(tx, enrolledMachineIds);
}

export async function readManagedWakeControllerPublicationAccountIdsInTx(tx: Tx, controllerMachineIds: readonly string[]): Promise<string[]> {
    const audiences = await readManagedWakeControllerAudiencesInTx(tx, controllerMachineIds);
    return [...new Set([...audiences.values()].flat())];
}

/** Semantic controller transitions wake existing exact guest readers, never ordinary heartbeat renewal. */
export async function invalidateManagedWakeControllerInTx(tx: Tx, controllerMachineId: string): Promise<void> {
    for (const [machineId, accountIds] of await readManagedWakeControllerAudiencesInTx(tx, [controllerMachineId])) await markAccountsChanged(tx, {
        accountIds, kind: 'machine', entityId: machineId,
    });
}
