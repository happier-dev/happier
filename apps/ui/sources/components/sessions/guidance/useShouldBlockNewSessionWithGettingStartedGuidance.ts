import * as React from 'react';

import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useLaunchSelectionMachines, useMachineListByServerId } from '@/sync/domains/state/storage';

import { resolveSessionGettingStartedMachinesSummary } from './gettingStartedModel';

export function useShouldBlockNewSessionWithGettingStartedGuidance(): boolean {
    const selection = useResolvedActiveServerSelection();
    const activeMachines = useLaunchSelectionMachines();
    const machineListByServerId = useMachineListByServerId();
    const localDaemonControl = useLocalDaemonControl();
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
            machineListByServerId,
        });

        return machines.machineCount === 0 && !machines.hasUnknownServers;
    }, [
        activeMachines,
        localDaemonControl.status,
        machineListByServerId,
        selectionSnapshot,
    ]);
}
