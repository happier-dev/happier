import { db } from "@/storage/db";

export type MachineAvailabilityState = "available" | "revoked" | "replaced" | "missing";

export async function readMachineAvailabilityState(params: Readonly<{
    accountId: string;
    machineId: string;
}>): Promise<MachineAvailabilityState> {
    const machine = await db.machine.findFirst({
        where: { accountId: params.accountId, id: params.machineId },
        select: { revokedAt: true, replacedByMachineId: true },
    });
    if (!machine) return "missing";
    if (machine.revokedAt) return "revoked";
    if (machine.replacedByMachineId) return "replaced";
    return "available";
}
