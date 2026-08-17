import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

export type MachineAvailabilityState = "available" | "revoked" | "replaced" | "missing";

export function classifyMachineAvailabilityState(
    machine: Readonly<{ revokedAt: Date | null; replacedByMachineId: string | null }> | null,
): MachineAvailabilityState {
    if (!machine) return "missing";
    if (machine.revokedAt) return "revoked";
    if (machine.replacedByMachineId) return "replaced";
    return "available";
}

export async function readMachineAvailabilityState(params: Readonly<{
    accountId: string;
    machineId: string;
}>): Promise<MachineAvailabilityState> {
    const machine = await db.machine.findFirst({
        where: { accountId: params.accountId, id: params.machineId },
        select: { revokedAt: true, replacedByMachineId: true },
    });
    return classifyMachineAvailabilityState(machine);
}

/** Transaction-bound form for domain consumers that must share one DB snapshot. */
export async function readMachineAvailabilityStateInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
}>): Promise<MachineAvailabilityState> {
    const machine = await params.tx.machine.findFirst({
        where: { accountId: params.accountId, id: params.machineId },
        select: { revokedAt: true, replacedByMachineId: true },
    });
    return classifyMachineAvailabilityState(machine);
}
