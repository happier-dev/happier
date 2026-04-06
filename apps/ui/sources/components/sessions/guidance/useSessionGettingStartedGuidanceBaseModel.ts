import * as React from 'react';

import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useVisibleSessionListSummaryState } from '@/hooks/session/useVisibleSessionListSummaryState';
import { useMachineListByServerId, useSetting } from '@/sync/domains/state/storage';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';

import type { SessionGettingStartedViewModel } from './gettingStartedModel';
import { buildSessionGettingStartedViewModel, resolveActiveServerProfile } from './gettingStartedModel';

export function useSessionGettingStartedGuidanceBaseModel(): SessionGettingStartedViewModel {
    const { selection: summarySelection, summary: sessionSummary } = useVisibleSessionListSummaryState();
    const serverProfilesGeneration = useServerProfilesGeneration();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const machineListByServerId = useMachineListByServerId();
    const selectionSnapshot = React.useMemo(() => ({
        activeTarget: summarySelection.activeTarget,
        activeServerId: summarySelection.activeServerId,
        allowedServerIds: summarySelection.allowedServerIds,
    }), [
        summarySelection.activeTarget,
        summarySelection.activeServerId,
        summarySelection.allowedServerIds,
    ]);
    const serverProfiles = React.useMemo(() => {
        return listServerProfiles().map((p) => ({ id: p.id, name: p.name, serverUrl: p.serverUrl }));
    }, [serverProfilesGeneration]);
    const activeServerProfile = React.useMemo(() => {
        return resolveActiveServerProfile(serverProfiles, summarySelection.activeServerId);
    }, [serverProfiles, summarySelection.activeServerId]);

    return React.useMemo(() => {
        return buildSessionGettingStartedViewModel({
            sessionsReady: sessionSummary.sessionsReady,
            sessionCount: sessionSummary.sessionCount,
            selection: selectionSnapshot,
            serverSelectionGroups,
            activeServerProfile,
            machineListByServerId,
        });
    }, [
        activeServerProfile,
        machineListByServerId,
        selectionSnapshot,
        serverSelectionGroups,
        sessionSummary.sessionCount,
        sessionSummary.sessionsReady,
    ]);
}
