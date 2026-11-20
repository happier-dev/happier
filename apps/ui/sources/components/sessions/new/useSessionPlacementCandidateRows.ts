import * as React from 'react';

import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';

import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storageStore';

import { presentSessionPlacementCandidates, type SessionPlacementCandidateRow } from './serverStartDraftCandidateSelection';

const NO_ROWS: readonly SessionPlacementCandidateRow[] = Object.freeze([]);

/** The saved-project rows from what the store holds now. */
export function readSessionPlacementCandidateRows(candidates: readonly PluginUiSessionPlacementCandidateV1[], currentIndex?: number): readonly SessionPlacementCandidateRow[] {
    const state = getStorage().getState();
    return presentSessionPlacementCandidates({
        candidates,
        ...(currentIndex === undefined ? {} : { currentIndex }),
        accountScope: state.profileScope,
        activeServerId: getActiveServerId(),
        // The full records: the presenter decides which Machines are launch choices.
        activeMachineRecords: state.machines,
        machineListByServerId: state.machineListByServerId ?? {},
        machineRecordsByServerId: state.machineRecordsByServerId,
        machineListStatusByServerId: state.machineListStatusByServerId ?? {},
    });
}

const rowsSignature = (rows: readonly SessionPlacementCandidateRow[]) =>
    JSON.stringify(rows.map((row) => [row.index, row.title, row.subtitle, row.availability]));

/**
 * The saved-project rows, kept current. New Session subscribes to no Machine inventory, so this watches only the
 * facts these rows read, only while there are candidates, and only what a row says can re-render its caller.
 */
export function useSessionPlacementCandidateRows(candidates: readonly PluginUiSessionPlacementCandidateV1[] | undefined, currentIndex?: number): readonly SessionPlacementCandidateRow[] {
    const enabled = (candidates?.length ?? 0) > 0;
    const reachabilityRevision = useMachineReachabilityRevision(enabled);
    const subscribe = React.useCallback((listener: () => void) => enabled
        ? getStorage().subscribe(listener, { machines: true, machineListByServerId: true, machineListStatusByServerId: true, profileScope: true })
        : () => {}, [enabled]);
    const readSignature = React.useCallback(() => enabled ? rowsSignature(readSessionPlacementCandidateRows(candidates!, currentIndex)) : '',
        // A reachability observation changes what the owner answers without changing the store.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [candidates, currentIndex, enabled, reachabilityRevision]);
    const signature = React.useSyncExternalStore(subscribe, readSignature, readSignature);
    return React.useMemo(() => enabled ? readSessionPlacementCandidateRows(candidates!, currentIndex) : NO_ROWS,
        // The signature stands for every fact the rows read.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [candidates, currentIndex, enabled, signature]);
}
