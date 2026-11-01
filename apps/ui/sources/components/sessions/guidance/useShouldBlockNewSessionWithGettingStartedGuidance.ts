import * as React from 'react';

import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useMachineListByServerId } from '@/sync/domains/state/storage';

import { computeMachinesSummaryForServerIds } from './gettingStartedModel';

export function useShouldBlockNewSessionWithGettingStartedGuidance(): boolean {
    const selection = useResolvedActiveServerSelection();
    const machineListByServerId = useMachineListByServerId();

    return React.useMemo(() => {
        const machines = computeMachinesSummaryForServerIds({
            allowedServerIds: selection.allowedServerIds,
            machineListByServerId,
        });

        return machines.machineCount === 0 && !machines.hasUnknownServers;
    }, [machineListByServerId, selection.allowedServerIds]);
}
