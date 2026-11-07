import * as React from 'react';
import type { HappierStorageSummaryV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { machineStorageStore, type MachineStorageState } from './machineStorageStore';
import { selectStorageFailure, selectStorageStatus, selectStorageSummary, useMachineStorageDemand, useMachineStorageSelection, useMachineStorageTarget, type MachineStorageHookInput } from './useMachineStorage';
import { machineResourceStore } from '../resources/machineResourceStore';
import { useMachineResourceLiveDemand } from '../resources/useMachineResourceLiveDemand';

export type MachineStorageSummaryHookResult = MachineStorageState & Readonly<{
    offline: boolean;
    retry: () => void;
    sizeAgain: () => Promise<MachineStorageState>;
}>;

type VitalsVolumes = Extract<MachineVitalsSampleV1['disk'], { reported: true }>['volumes'];

/** Capacity is a Vitals fact; all measured occupancy and cleanup facts stay Storage-owned. */
function joinCapacity(summary: HappierStorageSummaryV1 | null, capacity: VitalsVolumes | null): HappierStorageSummaryV1 | null {
    if (!summary || !capacity) return summary;
    const byId = new Map(capacity.map(volume => [volume.id, volume]));
    let changed = false;
    const volumes = summary.volumes.map(volume => {
        const current = byId.get(volume.volume.volumeId);
        if (!current || (volume.totalBytes === current.totalBytes && volume.freeBytes === current.availableBytes
            && volume.availableIncludingPurgeableBytes === current.availableIncludingPurgeableBytes)) return volume;
        changed = true;
        const { availableIncludingPurgeableBytes: _previousPurgeable, ...storageFacts } = volume;
        return { ...storageFacts, totalBytes: current.totalBytes, freeBytes: current.availableBytes,
            ...(current.availableIncludingPurgeableBytes === undefined ? {} : { availableIncludingPurgeableBytes: current.availableIncludingPurgeableBytes }) };
    });
    return changed ? { ...summary, volumes } : summary;
}

export function useMachineStorageSummary(input: MachineStorageHookInput): MachineStorageSummaryHookResult {
    const { key, enabled, offline, daemonStateVersion } = useMachineStorageTarget(input);
    useMachineStorageDemand(key, enabled);
    useMachineResourceLiveDemand([{ ...key, daemonStateVersion }], { detail: 'summary', enabled });
    const status = useMachineStorageSelection(key, selectStorageStatus);
    const storedSummary = useMachineStorageSelection(key, selectStorageSummary);
    const failure = useMachineStorageSelection(key, selectStorageFailure);
    const resourceKey = React.useMemo(() => ({ ...key, view: 'summary' as const }), [key]);
    const subscribeCapacity = React.useCallback((listener: () => void) => machineResourceStore.observe(resourceKey, listener), [resourceKey]);
    const readCapacity = React.useCallback(() => {
        const disk = machineResourceStore.getState(resourceKey).snapshot?.sample?.disk;
        return disk?.reported ? disk.volumes : null;
    }, [resourceKey]);
    const capacity = React.useSyncExternalStore(subscribeCapacity, readCapacity, readCapacity);
    const summary = React.useMemo(() => joinCapacity(storedSummary, capacity), [storedSummary, capacity]);
    const retry = React.useCallback(() => machineStorageStore.retry(key), [key]);
    const sizeAgain = React.useCallback(() => machineStorageStore.sizeAgain(key), [key]);
    return React.useMemo(() => ({ status, summary, failure, offline, retry, sizeAgain }), [status, summary, failure, offline, retry, sizeAgain]);
}
