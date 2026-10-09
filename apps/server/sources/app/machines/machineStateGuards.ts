import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import {
    readMachineIrohEndpointAuthorityV1,
    MachineOperationProtocolCapabilitiesV1StoredReadSchema,
    type MachineOperationProtocolCapabilityNameV1,
    type MachineIrohEndpointAuthorityV1,
} from "@happier-dev/protocol";

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

/**
 * Reads the sole server-visible current daemon Iroh identity. The authenticated
 * Machine socket replaces this complete projection and the server assigns its
 * monotonic revision; encrypted daemonState is deliberately not consulted.
 */
export async function readAvailableMachineIrohEndpointAuthority(params: Readonly<{
    accountId: string;
    machineId: string;
    requiredCapability?: MachineOperationProtocolCapabilityNameV1;
}>): Promise<MachineIrohEndpointAuthorityV1 | null> {
    const machine = await db.machine.findFirst({
        where: { accountId: params.accountId, id: params.machineId },
        select: {
            revokedAt: true,
            replacedByMachineId: true,
            operationProtocolCapabilities: true,
            operationProtocolCapabilitiesRevision: true,
        },
    });
    if (classifyMachineAvailabilityState(machine) !== "available" || machine === null) return null;
    if (params.requiredCapability) {
        const capabilities = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(machine.operationProtocolCapabilities);
        if (!capabilities.success || !capabilities.data[params.requiredCapability]) return null;
    }
    return readMachineIrohEndpointAuthorityV1({
        capabilities: machine.operationProtocolCapabilities,
        revision: machine.operationProtocolCapabilitiesRevision,
    });
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
