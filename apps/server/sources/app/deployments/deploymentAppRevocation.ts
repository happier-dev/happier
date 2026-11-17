import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { revokeMachineInTx } from '@/app/machines/machineMutations';

/** Disposition selects App children; the existing Machine owner withdraws their credentials and sockets. */
export async function revokeDeploymentAppMachinesInTx(tx: Tx, input: Readonly<{
    environmentId: string; targetLinkId?: string;
    removedMachines?: readonly Readonly<{ machineId: string; installationId: string }>[];
}>): Promise<void> {
    const receipts = await tx.deployment.findMany({ where: { environmentId: input.environmentId,
        ...(input.targetLinkId ? { targetLinkId: input.targetLinkId } : {}) },
        select: { id: true, acceptedControllerMachineId: true, acceptedControllerInstallationId: true } });
    const ids = receipts.filter(receipt => !input.removedMachines || input.removedMachines.some(member =>
        member.machineId === receipt.acceptedControllerMachineId
        && member.installationId === receipt.acceptedControllerInstallationId)).map(receipt => receipt.id);
    for (const chunk of portableQueryChunks({ values: ids, bindingsPerValue: 1 })) {
        const machines = await tx.machine.findMany({ where: { deploymentAppDeploymentId: { in: [...chunk] }, revokedAt: null },
            select: { id: true, accountId: true } });
        for (const machine of machines) await revokeMachineInTx(tx, { accountId: machine.accountId, machineId: machine.id });
    }
}
