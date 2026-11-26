import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import type { MachineAvailabilityDiagnosticV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { readMachineIrohEndpointAuthorityV1, type MachineOperationProtocolCapabilityNameV1, type MachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';

export type MachineAvailabilityState = "available" | "revoked" | "replaced" | "missing";

export const MACHINE_OFFLINE_AVAILABILITY_DIAGNOSTIC = {
    reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine',
} as const satisfies MachineAvailabilityDiagnosticV1;

/** The stored observation is written by the managed Machine provider owner. */
export function readManagedMachineDisconnectedDiagnostic(observation: unknown): MachineAvailabilityDiagnosticV1 | undefined {
    const power = observation && typeof observation === 'object' && 'power' in observation ? observation.power : undefined;
    if (power !== 'stopped' && power !== 'suspended') return undefined;
    return { ...MACHINE_OFFLINE_AVAILABILITY_DIAGNOSTIC, reason: power === 'stopped' ? 'machine_stopped' : 'machine_suspended' };
}

/** For admissions that require the published online observation. */
export function readMachineOnlineAvailabilityDiagnostic(machine: Readonly<{ active: boolean }>, requireOnline?: boolean): MachineAvailabilityDiagnosticV1 | undefined {
    return requireOnline === true && !machine.active
        ? MACHINE_OFFLINE_AVAILABILITY_DIAGNOSTIC : undefined;
}

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
    installationId?: string;
    requiredCapability?: MachineOperationProtocolCapabilityNameV1;
}>): Promise<MachineIrohEndpointAuthorityV1 | null> {
    return readCurrentMachineIrohEndpointAuthority(params);
}

/** Transport identity only: the receiving prepared job owns filesystem access. */
export async function readAvailableMachineIrohTransportEndpointAuthority(params: Readonly<{
    machineId: string;
}>): Promise<MachineIrohEndpointAuthorityV1 | null> {
    return readCurrentMachineIrohEndpointAuthority(params);
}

async function readCurrentMachineIrohEndpointAuthority(params: Readonly<{
    accountId?: string;
    machineId: string;
    installationId?: string;
    requiredCapability?: MachineOperationProtocolCapabilityNameV1;
}>): Promise<MachineIrohEndpointAuthorityV1 | null> {
    const machine = await db.machine.findFirst({
        where: {
            id: params.machineId,
            ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
            ...(params.installationId === undefined ? {} : { installationId: params.installationId }),
        },
        select: {
            revokedAt: true,
            replacedByMachineId: true,
            operationProtocolCapabilities: true,
            operationProtocolCapabilitiesRevision: true,
        },
    });
    if (classifyMachineAvailabilityState(machine) !== "available" || machine === null) return null;
    return readMachineIrohEndpointAuthorityV1({
        capabilities: machine.operationProtocolCapabilities,
        revision: machine.operationProtocolCapabilitiesRevision,
        requiredCapability: params.requiredCapability,
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
