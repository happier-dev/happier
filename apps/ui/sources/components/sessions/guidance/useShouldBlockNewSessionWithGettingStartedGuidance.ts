import * as React from 'react';

import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useLaunchSelectionMachines, useMachineListByServerId } from '@/sync/domains/state/storage';

import { resolveSessionGettingStartedMachinesSummary } from './gettingStartedModel';
import { useSessionGettingStartedActiveServerProfile } from './useSessionGettingStartedActiveServerProfile';

export function useShouldBlockNewSessionWithGettingStartedGuidance(): boolean {
    const selection = useResolvedActiveServerSelection();
    const activeMachines = useLaunchSelectionMachines();
    const machineListByServerId = useMachineListByServerId();
    const localDaemonControl = useLocalDaemonControl();
    const activeServerProfile = useSessionGettingStartedActiveServerProfile(selection.activeServerId);
    const selectionSnapshot = React.useMemo(() => ({
        activeTarget: selection.activeTarget,
        activeServerId: selection.activeServerId,
        allowedServerIds: selection.allowedServerIds,
    }), [
        selection.activeTarget,
        selection.activeServerId,
        selection.allowedServerIds,
    ]);

    return React.useMemo(() => {
        const machines = resolveSessionGettingStartedMachinesSummary({
            activeMachines,
            localDaemonStatus: localDaemonControl.status,
            selection: selectionSnapshot,
            activeServerProfile,
            machineListByServerId,
        });

        return machines.machineCount === 0 && !machines.hasUnknownServers;
    }, [
        activeServerProfile,
        activeMachines,
        localDaemonControl.status,
        machineListByServerId,
        selectionSnapshot,
    ]);
}
