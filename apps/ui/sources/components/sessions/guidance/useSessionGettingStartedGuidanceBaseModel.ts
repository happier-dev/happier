import * as React from 'react';

import { useVisibleSessionListViewData } from '@/hooks/session/useVisibleSessionListViewData';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useMachineListByServerId, useMachineListStatusByServerId, useSetting } from '@/sync/domains/state/storage';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';

import type { SessionGettingStartedViewModel } from './gettingStartedModel';
import { buildSessionGettingStartedViewModel } from './gettingStartedModel';

export function useSessionGettingStartedGuidanceBaseModel(): SessionGettingStartedViewModel {
    const sessions = useVisibleSessionListViewData();
    const selection = useResolvedActiveServerSelection();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();

    return React.useMemo(() => {
        return buildSessionGettingStartedViewModel({
            sessions,
            selection,
            serverSelectionGroups,
            serverProfiles: listServerProfiles().map((p) => ({ id: p.id, name: p.name, serverUrl: p.serverUrl })),
            machineListByServerId,
            machineListStatusByServerId,
        });
    }, [machineListByServerId, machineListStatusByServerId, selection, serverSelectionGroups, sessions]);
}
