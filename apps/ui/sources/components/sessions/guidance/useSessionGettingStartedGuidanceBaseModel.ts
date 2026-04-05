import * as React from 'react';

import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useVisibleSessionListSummaryState } from '@/hooks/session/useVisibleSessionListSummaryState';
import { useMachineListByServerId, useSetting } from '@/sync/domains/state/storage';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';

import type { SessionGettingStartedViewModel } from './gettingStartedModel';
import { buildSessionGettingStartedViewModel } from './gettingStartedModel';

export function useSessionGettingStartedGuidanceBaseModel(): SessionGettingStartedViewModel {
    const { summary: sessionSummary } = useVisibleSessionListSummaryState();
    const selection = useResolvedActiveServerSelection();
    const serverProfilesGeneration = useServerProfilesGeneration();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const machineListByServerId = useMachineListByServerId();
    const selectionSnapshot = React.useMemo(() => ({
        activeTarget: selection.activeTarget,
        activeServerId: selection.activeServerId,
        allowedServerIds: selection.allowedServerIds,
    }), [
        selection.activeServerId,
        selection.activeTarget,
        selection.allowedServerIds,
    ]);
    const serverProfiles = React.useMemo(() => {
        return listServerProfiles().map((p) => ({ id: p.id, name: p.name, serverUrl: p.serverUrl }));
    }, [serverProfilesGeneration]);

    return React.useMemo(() => {
        return buildSessionGettingStartedViewModel({
            sessionsReady: sessionSummary.sessionsReady,
            sessionCount: sessionSummary.sessionCount,
            selection: selectionSnapshot,
            serverSelectionGroups,
            serverProfiles,
            machineListByServerId,
        });
    }, [
        machineListByServerId,
        selectionSnapshot,
        serverSelectionGroups,
        sessionSummary.sessionCount,
        sessionSummary.sessionsReady,
        serverProfiles,
    ]);
}
