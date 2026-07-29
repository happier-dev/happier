import * as React from 'react';

import { useVisibleSessionListSummaryState } from '@/hooks/session/useVisibleSessionListSummaryState';
import { useAllMachines, useMachineListByServerId, useSetting } from '@/sync/domains/state/storage';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';

import type { SessionGettingStartedViewModel } from './gettingStartedModel';
import { buildSessionGettingStartedViewModel } from './gettingStartedModel';
import { useSessionGettingStartedActiveServerProfile } from './useSessionGettingStartedActiveServerProfile';

export function useSessionGettingStartedGuidanceBaseModel(): SessionGettingStartedViewModel {
    const { selection: summarySelection, summary: sessionSummary } = useVisibleSessionListSummaryState();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const activeMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const localDaemonControl = useLocalDaemonControl();
    const selectionSnapshot = React.useMemo(() => ({
        activeTarget: summarySelection.activeTarget,
        activeServerId: summarySelection.activeServerId,
        allowedServerIds: summarySelection.allowedServerIds,
    }), [
        summarySelection.activeTarget,
        summarySelection.activeServerId,
        summarySelection.allowedServerIds,
    ]);
    const activeServerProfile = useSessionGettingStartedActiveServerProfile(summarySelection.activeServerId);

    return React.useMemo(() => {
        return buildSessionGettingStartedViewModel({
            sessionsReady: sessionSummary.sessionsReady,
            sessionCount: sessionSummary.sessionCount,
            activeMachines,
            localDaemonStatus: localDaemonControl.status,
            selection: selectionSnapshot,
            serverSelectionGroups,
            activeServerProfile,
            machineListByServerId,
        });
    }, [
        activeServerProfile,
        activeMachines,
        localDaemonControl.status,
        machineListByServerId,
        selectionSnapshot,
        serverSelectionGroups,
        sessionSummary.sessionCount,
        sessionSummary.sessionsReady,
    ]);
}
