import { useMachine } from '@/sync/domains/state/storage';
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
    const machine = useMachine(params.machineId ?? '');
    const cacheKeySalt =
        typeof params.daemonStateVersion === 'number'
            ? params.daemonStateVersion
            : resolveDaemonCapabilitiesCacheKeySalt(machine);

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
