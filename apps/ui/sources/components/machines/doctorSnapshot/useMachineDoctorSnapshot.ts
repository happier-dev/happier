import * as React from 'react';

import {
    buildMachineDoctorSnapshotCollectionKey,
    fetchMachineDoctorSnapshot,
    readMachineDoctorSnapshot,
    seedMachineDoctorSnapshotState,
    type MachineDoctorSnapshotCollectionRef,
    type MachineDoctorSnapshotState,
} from './readMachineDoctorSnapshot';

export function useMachineDoctorSnapshot() {
    const readSnapshot = React.useCallback(readMachineDoctorSnapshot, []);
    const seedSnapshotState = React.useCallback(seedMachineDoctorSnapshotState, []);
    const fetchSnapshot = React.useCallback(fetchMachineDoctorSnapshot, []);

    return {
        readMachineDoctorSnapshot: readSnapshot,
        seedMachineDoctorSnapshotState: seedSnapshotState,
        fetchMachineDoctorSnapshot: fetchSnapshot,
    };
}

export type { MachineDoctorSnapshotState };
export type MachineDoctorSnapshotTarget = MachineDoctorSnapshotCollectionRef;
export const buildMachineDoctorSnapshotTargetKey = buildMachineDoctorSnapshotCollectionKey;
