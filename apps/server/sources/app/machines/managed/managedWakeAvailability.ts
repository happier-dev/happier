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
    tx: Tx, rows: readonly T[],
) {
    const controllerIds = [...new Set(rows.flatMap(row => row.managedResource?.controllerMachineId
        ? [row.managedResource.controllerMachineId] : []))];
    const controllers = new Map<string, ControllerPresence>();
    for (const ids of portableQueryChunks({ values: controllerIds, bindingsPerValue: 1 })) {
        for (const controller of await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: CONTROLLER_PRESENCE_SELECT })) {
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

/** Semantic controller transitions wake existing exact guest readers, never ordinary heartbeat renewal. */
export async function invalidateManagedWakeControllerInTx(tx: Tx, controllerMachineId: string): Promise<void> {
    const resources = await tx.managedMachine.findMany({ where: { controllerMachineId, enrolledMachineId: { not: null } },
        select: { enrolledMachineId: true } });
    const machineIds = resources.flatMap(resource => resource.enrolledMachineId ? [resource.enrolledMachineId] : []);
    const audiences = await readMachineAudienceAccountIdsForMachinesInTx(tx, machineIds);
    for (const machineId of machineIds) await markAccountsChanged(tx, {
        accountIds: audiences.get(machineId) ?? [], kind: 'machine', entityId: machineId,
    });
}
