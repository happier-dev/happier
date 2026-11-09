import * as React from 'react';

import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { storage } from '@/sync/domains/state/storageStore';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

import { resolveSessionGettingStartedMachineSetupSatisfied } from './gettingStartedModel';
import { useSessionGettingStartedActiveServerProfile } from './useSessionGettingStartedActiveServerProfile';

const readNoPresenceDeadlines = () => [];

/** The getting-started selection is unknown until loaded; offline machines count, revoked ones do not. */
export function useHasMachineForGettingStartedGuidance(enabled = true): boolean | null {
    const selection = useResolvedActiveServerSelection();
    const activeServerProfile = useSessionGettingStartedActiveServerProfile(selection.activeServerId);
    const readSetup = React.useCallback(() => {
        if (!enabled) return null;
        const state = storage.getState();
        return resolveSessionGettingStartedMachineSetupSatisfied({
            get activeMachines() { return Object.values(state.machines); },
            selection,
            activeServerProfile,
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        });
    }, [activeServerProfile, enabled, selection]);
    const targets = React.useMemo(() => enabled
        ? [...new Set([...selection.allowedServerIds, selection.activeServerId])].map(serverId => ({ serverId }))
        : [], [enabled, selection.activeServerId, selection.allowedServerIds]);
    return useMachinePresenceSnapshot(readNoPresenceDeadlines, readSetup, targets);
}
