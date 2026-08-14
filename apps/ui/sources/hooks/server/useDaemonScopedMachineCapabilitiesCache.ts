import { useMachineCliDetectionTarget } from '@/sync/domains/state/storage';
import { useMachineCapabilitiesCache, type MachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';


export function resolveDaemonCapabilitiesCacheKeySalt(machine: Readonly<{ daemonStateVersion?: number }> | null | undefined): number {
    return typeof machine?.daemonStateVersion === 'number' ? machine.daemonStateVersion : 0;
}

export function useDaemonScopedMachineCapabilitiesCache(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    enabled: boolean;
    staleMs?: number;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
    /**
     * Optional override; when omitted, falls back to the machine store's daemonStateVersion.
     */
    daemonStateVersion?: number | null;
}>): { state: MachineCapabilitiesCacheState; refresh: (next?: { request?: CapabilitiesDetectRequest; timeoutMs?: number; bypassCache?: boolean }) => void } {
    // Subscribe to the narrow, reference-stable CLI-detection projection rather than the whole
    // machine record: presence heartbeats rewrite `activeAt`/`updatedAt`/`seq` constantly, and a
    // wide subscription re-renders every consumer (including every machine picker row) for fields
    // this cache key never reads.
    const machineTarget = useMachineCliDetectionTarget(params.machineId ?? null);
    const cacheKeySalt =
        typeof params.daemonStateVersion === 'number'
            ? params.daemonStateVersion
            : resolveDaemonCapabilitiesCacheKeySalt(machineTarget);

    return useMachineCapabilitiesCache({
        machineId: params.machineId,
        serverId: params.serverId,
        cacheKeySalt,
        enabled: params.enabled,
        staleMs: params.staleMs,
        request: params.request,
        timeoutMs: params.timeoutMs,
    });
}
