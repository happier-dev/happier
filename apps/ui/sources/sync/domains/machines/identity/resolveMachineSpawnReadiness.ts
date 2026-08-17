import { isMachineOnline } from '@/utils/sessions/machineUtils';

import { isMachineReplaced, type MachineWithReplacement } from './machineIdentityTypes';

export type MachineSpawnReadiness =
    | { status: 'ready'; machineId: string }
    | { status: 'missing' }
    | { status: 'revoked'; machineId: string }
    | { status: 'replaced'; machineId: string; replacedByMachineId: string }
    | { status: 'offline'; machineId: string }
    | { status: 'unknown'; machineId: string }
    | { status: 'probing'; machineId: string }
    | { status: 'rpcUnavailable'; machineId: string }
    | { status: 'keyUnavailable'; machineId: string };

type MachineReadinessProbeState = boolean | 'unknown' | 'probing' | null | undefined;

/** The picker needs display/presence facts, not daemon-owned machine state. */
export type MachineSpawnReadinessMachine = Readonly<{
    id: string;
    active: boolean;
    activeAt?: number | null;
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
}>;

export function resolveMachineSpawnReadiness(params: Readonly<{
    selectedMachineId?: string | null;
    machine?: MachineSpawnReadinessMachine | null;
    rpcAvailable?: MachineReadinessProbeState;
    keyAvailable?: MachineReadinessProbeState;
    requireExactSpawnReadiness?: boolean;
    nowMs?: number;
}>): MachineSpawnReadiness {
    const selectedMachineId = typeof params.selectedMachineId === 'string' ? params.selectedMachineId.trim() : '';
    const machine = params.machine as MachineWithReplacement | null | undefined;
    if (!selectedMachineId || !machine) return { status: 'missing' };

    const revokedAt = typeof machine.revokedAt === 'number' ? machine.revokedAt : 0;
    if (Number.isFinite(revokedAt) && revokedAt > 0) {
        return { status: 'revoked', machineId: selectedMachineId };
    }

    if (isMachineReplaced(machine)) {
        return {
            status: 'replaced',
            machineId: selectedMachineId,
            replacedByMachineId: String(machine.replacedByMachineId ?? '').trim(),
        };
    }

    if (!isMachineOnline(machine, params.nowMs)) {
        return { status: 'offline', machineId: selectedMachineId };
    }

    if (params.requireExactSpawnReadiness === true && (
        params.keyAvailable === undefined
        || params.rpcAvailable === undefined
    )) {
        return { status: 'unknown', machineId: selectedMachineId };
    }

    if (params.keyAvailable === 'probing' || params.rpcAvailable === 'probing') {
        return { status: 'probing', machineId: selectedMachineId };
    }

    if (
        params.keyAvailable === 'unknown'
        || params.rpcAvailable === 'unknown'
        || params.keyAvailable === null
        || params.rpcAvailable === null
    ) {
        return { status: 'unknown', machineId: selectedMachineId };
    }

    if (params.keyAvailable === false) {
        return { status: 'keyUnavailable', machineId: selectedMachineId };
    }

    if (params.rpcAvailable === false) {
        return { status: 'rpcUnavailable', machineId: selectedMachineId };
    }

    return { status: 'ready', machineId: selectedMachineId };
}

export function canAttemptMachineSpawn(params: Readonly<{
    selectedMachineId?: string | null;
    machine?: Parameters<typeof resolveMachineSpawnReadiness>[0]['machine'];
    spawnReadiness?: MachineSpawnReadiness | null;
    nowMs?: number;
}>): boolean {
    const readiness = params.spawnReadiness ?? resolveMachineSpawnReadiness({
        selectedMachineId: params.selectedMachineId,
        machine: params.machine,
        requireExactSpawnReadiness: true,
        nowMs: params.nowMs,
    });

    if (readiness.status === 'ready') return true;
    if (readiness.status === 'unknown' || readiness.status === 'probing') {
        return Boolean(params.machine && isMachineOnline(params.machine, params.nowMs));
    }
    return false;
}
