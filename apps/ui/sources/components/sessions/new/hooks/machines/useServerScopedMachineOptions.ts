import * as React from 'react';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { listServerProfiles, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { useMachineListByServerId, useMachineListStatusByServerId } from '@/sync/domains/state/storage';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';

import { useStableValueBySignature } from '@/hooks/ui/useStableValueBySignature';

export type ServerScopedMachine = Machine & Readonly<{
    serverId: string;
    serverName: string;
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
    refreshToken?: string | number;
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
    };
}

function buildMachineOptionSignature(machine: Machine): string {
    const metadata = machine.metadata;
    return [
        machine.id,
        String(machine.active === true),
        String(machine.activeAt ?? ''),
        String(machine.updatedAt ?? ''),
        String(machine.daemonStateVersion ?? ''),
        String(machine.revokedAt ?? ''),
        String(machine.replacedByMachineId ?? ''),
        String(metadata?.displayName ?? ''),
        String(metadata?.host ?? ''),
        String(metadata?.homeDir ?? ''),
        String(metadata?.platform ?? ''),
    ].join('|');
}

function buildMachineListSignature(machines: ReadonlyArray<Machine>): string {
    return machines.map(buildMachineOptionSignature).join('\n');
}

function buildScopedMachineListsSignature(
    serverIds: ReadonlyArray<string>,
    machineListByServerId: Readonly<Record<string, ReadonlyArray<Machine> | null | undefined>>,
    machineListStatusByServerId: Readonly<Record<string, string | undefined>>,
): string {
    return serverIds.map((serverId) => {
        const hasCached = Object.prototype.hasOwnProperty.call(machineListByServerId, serverId);
        const machines = machineListByServerId[serverId];
        const machineSignature = Array.isArray(machines) ? buildMachineListSignature(machines) : '';
        return [
            serverId,
            String(hasCached),
            String(machineListStatusByServerId[serverId] ?? ''),
            machineSignature,
        ].join('|');
    }).join('\n');
}

function buildServerProfilesSignature(profilesById: ReadonlyMap<string, ServerProfile>): string {
    return Array.from(profilesById.values())
        .map((profile) => [
            profile.id,
            profile.name,
        ].join('|'))
        .sort()
        .join('\n');
}

export function useServerScopedMachineOptions(params: UseServerScopedMachineOptionsParams): ServerScopedMachineGroup[] {
    const allowedServerIdsKey = React.useMemo(
        () => normalizeServerIds(params.allowedServerIds).join('\n'),
        [params.allowedServerIds],
    );
    const allowedServerIds = React.useMemo(
        () => allowedServerIdsKey ? allowedServerIdsKey.split('\n') : [],
        [allowedServerIdsKey],
    );
    const rawServerProfiles = React.useMemo(() => {
        const byId = new Map<string, ServerProfile>();
        for (const profile of listServerProfiles()) {
            byId.set(profile.id, profile);
        }
        return byId;
    }, [allowedServerIdsKey, params.refreshToken]);
    const serverProfilesSignature = React.useMemo(
        () => buildServerProfilesSignature(rawServerProfiles),
        [rawServerProfiles],
    );
    const serverProfiles = useStableValueBySignature(rawServerProfiles, serverProfilesSignature);
    const rawMachineListByServerId = useMachineListByServerId();
    const rawMachineListStatusByServerId = useMachineListStatusByServerId();
    const scopedMachineListsSignature = React.useMemo(
        () => buildScopedMachineListsSignature(allowedServerIds, rawMachineListByServerId, rawMachineListStatusByServerId),
        [allowedServerIds, rawMachineListByServerId, rawMachineListStatusByServerId],
    );
    const machineListByServerId = useStableValueBySignature(rawMachineListByServerId, scopedMachineListsSignature);
    const machineListStatusByServerId = useStableValueBySignature(rawMachineListStatusByServerId, scopedMachineListsSignature);
    const activeMachinesSignature = React.useMemo(
        () => buildMachineListSignature(params.activeMachines),
        [params.activeMachines],
    );

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

            const baseMachines = isActive
                ? params.activeMachines
                : (machineListByServerId[serverId] ?? []);
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
        activeMachinesSignature,
        machineListByServerId,
        machineListStatusByServerId,
        params.activeServerId,
        serverProfiles,
    ]);
}
