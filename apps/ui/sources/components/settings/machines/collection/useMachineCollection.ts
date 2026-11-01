import * as React from 'react';

import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { areSessionValuesDeepEqual } from '@/sync/store/domains/areStoredSessionsEqual';

import { buildMachineCollection, type MachineCollection } from './machineCollectionModel';

/** Project roster labels through the same recovery, withdrawal and expiry subscription as admission. */
export function useMachineCollection(input: Omit<Parameters<typeof buildMachineCollection>[0], 'nowMs'>): MachineCollection {
    const { groups, groupedByHome, query, managedByServerId, managedFirstAnswerPending, presetsByServerId, teamNamesByServerId, awaitingConsent } = input;
    const readMachines = React.useCallback(() => groups.flatMap(group => group.machines), [groups]);
    const readCollection = React.useCallback((nowMs: number) => buildMachineCollection({
        groups, groupedByHome, query, managedByServerId, managedFirstAnswerPending, presetsByServerId, teamNamesByServerId, awaitingConsent, nowMs,
    }), [groups, groupedByHome, query, managedByServerId, managedFirstAnswerPending, presetsByServerId, teamNamesByServerId, awaitingConsent]);
    // Heartbeats retain semantic inventory identity. Presence recovery still has
    // to refresh labels; unchanged projections keep unrelated rows quiet.
    const targets = React.useMemo(() => groups.map(group => ({ serverId: group.serverId, machineIds: group.machines.map(machine => machine.id) })), [groups]);
    return useMachinePresenceSnapshot(readMachines, readCollection, targets, areSessionValuesDeepEqual);
}
