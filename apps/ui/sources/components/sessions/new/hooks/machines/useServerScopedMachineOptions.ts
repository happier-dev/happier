import * as React from 'react';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { listServerProfiles, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { useMachineListByServerId, useMachineListStatusByServerId } from '@/sync/domains/state/storage';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { resolveMachineSpawnReadiness, type MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';

export type ServerScopedMachine = Machine & Readonly<{
    serverId: string;
    serverName: string;
    spawnReadinessStatus: MachineSpawnReadiness['status'];
}>;

export type ServerScopedMachineGroup = Readonly<{
    serverId: string;
    serverName: string;
    machines: ServerScopedMachine[];
    loading: boolean;
    signedOut: boolean;
}>;

type UseServerScopedMachineOptionsParams = Readonly<{
    allowedServerIds: ReadonlyArray<string>;
    activeServerId: string;
    activeMachines: ReadonlyArray<Machine>;
    refreshToken?: number;
}>;

function normalizeServerIds(ids: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const raw of ids) {
        const id = String(raw ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        next.push(id);
    }
    return next;
}

function buildServerScopedMachine(machine: Machine, params: Readonly<{ serverId: string; serverName: string }>): ServerScopedMachine {
    return {
        ...machine,
        serverId: params.serverId,
        serverName: params.serverName,
        spawnReadinessStatus: resolveMachineSpawnReadiness({
            selectedMachineId: machine.id,
            machine,
            requireExactSpawnReadiness: true,
        }).status,
    };
}

export function useServerScopedMachineOptions(params: UseServerScopedMachineOptionsParams): ServerScopedMachineGroup[] {
    const allowedServerIds = React.useMemo(
        () => normalizeServerIds(params.allowedServerIds),
        [params.allowedServerIds],
    );
    const serverProfiles = React.useMemo(() => {
        const byId = new Map<string, ServerProfile>();
        for (const profile of listServerProfiles()) {
            byId.set(profile.id, profile);
        }
        return byId;
    }, [params.refreshToken, allowedServerIds.join(',')]);
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();

    return React.useMemo(() => {
        const activeServerId = String(params.activeServerId ?? '').trim();
        return allowedServerIds.map((serverId) => {
            const profile = serverProfiles.get(serverId);
            const serverName = profile?.name ?? serverId;
            const status = machineListStatusByServerId[serverId] ?? 'idle';
            const hasCachedRemote = Object.prototype.hasOwnProperty.call(machineListByServerId, serverId);
            const isActive = Boolean(activeServerId) && serverId === activeServerId;
            const signedOut = status === 'signedOut';
            const loading = !isActive && !signedOut && (status === 'loading' || !hasCachedRemote);

            const baseMachines = resolveServerScopedMachines({
                serverId,
                activeServerId,
                activeMachines: params.activeMachines,
                machineListByServerId,
            }) ?? [];
            const machines = (baseMachines ?? [])
                .filter(isMachineVisibleForLaunchSelection)
                .map((machine) => buildServerScopedMachine(machine, { serverId, serverName }));
            return {
                serverId,
                serverName,
                machines,
                loading,
                signedOut,
            };
        });
    }, [
        allowedServerIds,
        machineListByServerId,
        machineListStatusByServerId,
        params.activeMachines,
        params.activeServerId,
        serverProfiles,
    ]);
}
