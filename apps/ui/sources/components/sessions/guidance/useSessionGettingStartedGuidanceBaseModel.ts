import * as React from 'react';
import { useServerCredentialAccountScopeResolutions } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';

import { useVisibleSessionListSummaryState } from '@/hooks/session/useVisibleSessionListSummaryState';
import { useMachineLaunchInventorySelection, type MachineLaunchInventoryInput } from '@/sync/domains/state/storage';
import { useHomeViewSelectionSettings } from '@/hooks/server/useHomeViewSelectionSettings';

import type { SessionGettingStartedViewModel } from './gettingStartedModel';
import { buildSessionGettingStartedViewModel } from './gettingStartedModel';
import { useSessionGettingStartedActiveServerProfile } from './useSessionGettingStartedActiveServerProfile';

export function useSessionGettingStartedGuidanceBaseModel(): SessionGettingStartedViewModel {
    const { selection: summarySelection, summary: sessionSummary } = useVisibleSessionListSummaryState();
    const { serverSelectionGroups } = useHomeViewSelectionSettings();
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
    const scopeResolutions = useServerCredentialAccountScopeResolutions([...summarySelection.allowedServerIds, summarySelection.activeServerId]);
    const reachabilityRevision = useMachineReachabilityRevision();

    // A Machine row publishes for its own reasons (daemon state, heartbeats); a settled guidance answer redraws nothing.
    const select = React.useCallback((inventory: MachineLaunchInventoryInput) => buildSessionGettingStartedViewModel({
        sessionsReady: sessionSummary.sessionsReady,
        accountScopeResolutionsByServerId: scopeResolutions,
        sessionCount: sessionSummary.sessionCount,
        activeMachines: inventory.activeMachines,
        selection: selectionSnapshot,
        serverSelectionGroups,
        activeServerProfile,
        machineListByServerId: inventory.machineListByServerId,
        machineListStatusByServerId: inventory.machineListStatusByServerId,
    }), [
        activeServerProfile,
        selectionSnapshot,
        serverSelectionGroups,
        sessionSummary.sessionCount,
        sessionSummary.sessionsReady,
        scopeResolutions,
        reachabilityRevision,
    ]);
    return useMachineLaunchInventorySelection(select);
}
