import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useActiveSelectionMachineGroups } from '@/components/settings/machines/hooks/useActiveSelectionMachineGroups';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import {
    useAllMachines,
    useMachineListByServerId,
    useMachineListStatusByServerId,
    useSetting,
    useEndpointConnectivity,
    useSocketStatus,
    useSyncError,
} from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import { resolveConnectionHealthPresentation } from './connectionHealthPresentation';
import { resolveConnectionHealth } from './resolveConnectionHealth';

function isMachineReadyForConnectionHealth(machine: Readonly<{ daemonState?: unknown }>): boolean {
    const daemonState = machine.daemonState;
    if (!daemonState || typeof daemonState !== 'object') {
        return true;
    }
    const status = (daemonState as { status?: unknown }).status;
    if (typeof status !== 'string') {
        return true;
    }
    return status === 'running';
}

export function useConnectionHealth() {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const allMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const serverSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const serverSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');

    const activeServerSnapshot = useActiveServerSnapshot();
    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles().slice();
        } catch {
            return [];
        }
    }, [activeServerSnapshot.generation]);

    const activeSelectionMachineGroups = useActiveSelectionMachineGroups({
        activeServerSnapshot,
        allMachines,
        serverProfiles,
        machineListByServerId,
        machineListStatusByServerId,
        settings: {
            serverSelectionGroups,
            serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId,
        },
    });
    const activeSyncError = React.useMemo(() => {
        return selectSyncErrorForServer(syncError, activeServerSnapshot.serverId);
    }, [activeServerSnapshot.serverId, syncError]);

    const primaryMachineLabel = React.useMemo(() => {
        const byId = new Map<string, (typeof activeSelectionMachineGroups.visibleMachineGroups)[number]['machines'][number]>();
        for (const group of activeSelectionMachineGroups.visibleMachineGroups) {
            if (group.status === 'loading' || group.status === 'signedOut') continue;
            for (const machine of group.machines) {
                if (machine.revokedAt) continue;
                byId.set(machine.id, machine);
            }
        }
        if (byId.size !== 1) return null;
        const machine = [...byId.values()][0] ?? null;
        const metadata = machine?.metadata && typeof machine.metadata === 'object' ? machine.metadata as { displayName?: unknown; host?: unknown } : null;
        const displayName = typeof metadata?.displayName === 'string' ? metadata.displayName.trim() : '';
        if (displayName) return displayName;
        const host = typeof metadata?.host === 'string' ? metadata.host.trim() : '';
        if (host) return host;
        return machine?.id ?? null;
    }, [activeSelectionMachineGroups.visibleMachineGroups]);

    const health = React.useMemo(() => {
        return resolveConnectionHealth({
            socketStatus: socketStatus.status,
            endpointStatus: endpointConnectivity.status,
            endpointReason: endpointConnectivity.reason,
            hasSyncError: Boolean(activeSyncError),
            syncErrorKind: activeSyncError?.kind,
            machineGroups: activeSelectionMachineGroups.visibleMachineGroups.map((group) => {
                if (group.status === 'loading' || group.status === 'signedOut') {
                    return {
                        machineCount: null,
                        onlineCount: null,
                        status: group.status,
                    };
                }

                const visibleMachines = group.machines.filter((machine) => !machine.revokedAt);
                const onlineMachines = visibleMachines.filter((machine) => isMachineOnline(machine));
                return {
                    machineCount: visibleMachines.length,
                    onlineCount: onlineMachines.length,
                    readyCount: onlineMachines.filter((machine) => isMachineReadyForConnectionHealth(machine)).length,
                    status: group.status,
                };
            }),
        });
    }, [
        activeSelectionMachineGroups.visibleMachineGroups,
        activeSyncError,
        endpointConnectivity.reason,
        endpointConnectivity.status,
        socketStatus.status,
    ]);

    const presentation = React.useMemo(() => {
        return resolveConnectionHealthPresentation(health, {
            connected: theme.colors.status.connected,
            connecting: theme.colors.status.connecting,
            actionRequired: theme.colors.status.actionRequired,
            disconnected: theme.colors.status.disconnected,
            error: theme.colors.status.error,
            default: theme.colors.status.default,
        });
    }, [health, theme.colors.status]);

    return {
        ...health,
        ...presentation,
        primaryMachineLabel,
        endpointStatus: endpointConnectivity.status,
    };
}
