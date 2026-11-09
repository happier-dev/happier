import { db } from "@/storage/db";
import { classifyMachineDaemonPresence, getMachineDaemonPresenceInventory, type MachineDaemonPresenceSocketServer } from './machineDaemonPresence';

export async function hasExactMachineReadiness(accountId: string, machineId: string,
    io: MachineDaemonPresenceSocketServer): Promise<boolean> {
    const machine = await db.machine.findFirst({
        where: {
            accountId,
            id: machineId,
            revokedAt: null,
            replacedByMachineId: null,
        },
        select: { id: true },
    });
    if (!machine) return false;
    const inventory = await getMachineDaemonPresenceInventory({ accountId, io, machineIds: [machineId] });
    return classifyMachineDaemonPresence(inventory, machineId) === 'connected';
}
