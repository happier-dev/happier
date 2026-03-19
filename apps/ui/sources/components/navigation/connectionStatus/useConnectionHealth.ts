import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useActiveSelectionMachineGroups } from '@/components/settings/server/hooks/useActiveSelectionMachineGroups';
import { getActiveServerSnapshot, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import {
    useAllMachines,
    useMachineListByServerId,
    useMachineListStatusByServerId,
    useSetting,
    useSocketStatus,
    useSyncError,
} from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import { resolveConnectionHealthPresentation } from './connectionHealthPresentation';
import { resolveConnectionHealth } from './resolveConnectionHealth';

export function useConnectionHealth() {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();
    const syncError = useSyncError();
    const allMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const serverSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const serverSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');

    const activeServerSnapshot = getActiveServerSnapshot();
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

    const health = React.useMemo(() => {
        return resolveConnectionHealth({
            socketStatus: socketStatus.status,
            hasSyncError: Boolean(syncError),
            machineGroups: activeSelectionMachineGroups.visibleMachineGroups.map((group) => {
                if (group.status === 'loading' || group.status === 'signedOut') {
                    return {
                        machineCount: null,
                        onlineCount: null,
                        status: group.status,
                    };
                }

                const visibleMachines = group.machines.filter((machine) => !machine.revokedAt);
                return {
                    machineCount: visibleMachines.length,
                    onlineCount: visibleMachines.filter((machine) => isMachineOnline(machine)).length,
                    status: group.status,
                };
            }),
        });
    }, [activeSelectionMachineGroups.visibleMachineGroups, socketStatus.status, syncError]);

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
    };
}
