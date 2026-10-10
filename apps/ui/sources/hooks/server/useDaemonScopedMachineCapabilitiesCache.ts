import * as React from 'react';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getMachineContributionRegistryProjectionRevision, subscribeMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { useMachineCapabilitiesCache, type MachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';


export function resolveDaemonCapabilitiesCacheKeySalt(machine: Readonly<{ id: string }> | null | undefined, serverId?: string | null): number {
    return machine ? getMachineContributionRegistryProjectionRevision({ machineId: machine.id, serverId: serverId ?? null }) : 0;
}

export function useDaemonScopedMachineCapabilitiesCache(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    enabled: boolean;
    staleMs?: number;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}>): { state: MachineCapabilitiesCacheState; cacheKeySalt: number; refresh: (next?: { request?: CapabilitiesDetectRequest; timeoutMs?: number; bypassCache?: boolean }) => void } {
    const activeServer = useActiveServerSnapshot(!params.serverId);
    const serverId = params.serverId?.trim() || activeServer.serverId;
    const machineId = params.machineId;
    // Reuse the existing daemon/registry currentness owner. Workspace sync and
    // local-service publications do not invalidate these capability answers.
    const subscribe = React.useCallback((listener: () => void) => machineId
        ? subscribeMachineContributionRegistryProjectionInvalidation({ machineId, serverId }, listener)
        : () => {}, [machineId, serverId]);
    const read = React.useCallback(() => machineId
        ? getMachineContributionRegistryProjectionRevision({ machineId, serverId })
        : 0, [machineId, serverId]);
    const cacheKeySalt = React.useSyncExternalStore(subscribe, read, read);

    const cache = useMachineCapabilitiesCache({
        machineId: params.machineId,
        serverId,
        cacheKeySalt,
        enabled: params.enabled,
        staleMs: params.staleMs,
        request: params.request,
        timeoutMs: params.timeoutMs,
    });
    return { ...cache, cacheKeySalt };
}
