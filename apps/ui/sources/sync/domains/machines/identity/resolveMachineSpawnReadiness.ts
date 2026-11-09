import { isMachineReachable, resolveMachineReachability, type MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';

import { resolveMachineSpawnReadinessV1, type MachineSpawnReadinessV1, type MachineReadinessProbeStateV1 } from '@happier-dev/protocol/machines/machineSpawnReadinessV1';

export type MachineSpawnReadiness = MachineSpawnReadinessV1;

/** The picker needs display/presence facts, not daemon-owned machine state. */
export type MachineSpawnReadinessMachine = Readonly<{
    id: string;
    active: boolean;
    activeAt?: number | null;
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
    availability?: Readonly<{ kind: 'available' | 'locked' }> | null;
}>;

export function resolveMachineSpawnReadiness(params: Readonly<{
    selectedMachineId?: string | null;
    machine?: MachineSpawnReadinessMachine | null;
    scope?: MachineReachabilityScope | null;
    rpcAvailable?: MachineReadinessProbeStateV1;
    keyAvailable?: MachineReadinessProbeStateV1;
    requireExactSpawnReadiness?: boolean;
    /** A restrictive caller veto; true never overrides current scoped reachability. */
    machineReachable?: boolean;
    nowMs?: number;
}>): MachineSpawnReadiness {
    const reachability = params.machine ? resolveMachineReachability(params.scope, params.machine, params.nowMs) : 'unknown';
    const readiness = resolveMachineSpawnReadinessV1({ ...params,
        machineReachable: params.machineReachable !== false && reachability === 'reachable',
    });
    // The protocol still owns missing/replaced/revoked/key/probe decisions.
    // A caller veto can close admission, but cannot prove an unobserved Machine offline.
    return readiness.status === 'offline' && reachability === 'unknown'
        ? { status: 'unknown', machineId: readiness.machineId } : readiness;
}

export function canAttemptMachineSpawn(params: Readonly<{
    selectedMachineId?: string | null;
    machine?: Parameters<typeof resolveMachineSpawnReadiness>[0]['machine'];
    scope?: MachineReachabilityScope | null;
    spawnReadiness?: MachineSpawnReadiness | null;
    machineReachable?: boolean;
    nowMs?: number;
}>): boolean {
    if (!params.machine || !isMachineReachable(params.scope, params.machine, params.nowMs)) return false;
    const currentReadiness = resolveMachineSpawnReadiness({
        selectedMachineId: params.selectedMachineId,
        machine: params.machine,
        scope: params.scope,
        requireExactSpawnReadiness: true,
        machineReachable: params.machineReachable,
        nowMs: params.nowMs,
    });
    if (currentReadiness.status !== 'ready' && currentReadiness.status !== 'unknown') return false;
    // Retain only exact probe refusals. Presence and identity are projections
    // of current Machine facts, so an older readiness snapshot cannot veto recovery.
    const readiness = params.spawnReadiness?.status === 'rpcUnavailable' || params.spawnReadiness?.status === 'keyUnavailable'
        ? params.spawnReadiness : currentReadiness;
    return readiness.status === 'ready' || readiness.status === 'unknown';
}
