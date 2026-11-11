import * as React from 'react';
import type { HappierStorageSummaryV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { machineStorageStore, type MachineStorageState } from './machineStorageStore';
import { selectStorageFailure, selectStorageStatus, selectStorageSummary, useMachineStorageDemand, useMachineStorageSelection, useMachineStorageTarget, type MachineStorageHookInput } from './useMachineStorage';
import { machineResourceStore } from '../resources/machineResourceStore';
import { useMachineResourceLiveDemand } from '../resources/useMachineResourceLiveDemand';

export type MachineStorageSummaryHookResult = MachineStorageState & Readonly<{
    enabled: boolean;
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
    const storedStatus = useMachineStorageSelection(key, selectStorageStatus);
    const storedSummary = useMachineStorageSelection(key, selectStorageSummary);
    const storedFailure = useMachineStorageSelection(key, selectStorageFailure);
    const measurement = storedSummary?.measurement;
    // Retain the raw progress cursor in the store so its ordinary watch stays
    // subscribed, while presentation never mistakes a cold result for zero.
    const unmeasured = measurement && measurement.status !== 'ready' && !measurement.hasMeasured;
    const status = storedStatus === 'ready' && measurement?.status === 'failed' ? 'error'
        : storedStatus === 'ready' && unmeasured ? 'loading' : storedStatus;
    const failure = React.useMemo(() => storedFailure ?? (measurement?.status === 'failed'
        ? { ok: false as const, reason: 'request_failed' as const, error: measurement.error } : undefined), [storedFailure, measurement]);
    const resourceKey = React.useMemo(() => ({ ...key, view: 'summary' as const }), [key]);
    const subscribeCapacity = React.useCallback((listener: () => void) => machineResourceStore.observe(resourceKey, listener), [resourceKey]);
    const readCapacity = React.useCallback(() => {
        const disk = machineResourceStore.getState(resourceKey).snapshot?.sample?.disk;
        return disk?.reported ? disk.volumes : null;
    }, [resourceKey]);
    const capacity = React.useSyncExternalStore(subscribeCapacity, readCapacity, readCapacity);
    const summary = React.useMemo(() => joinCapacity(unmeasured ? null : storedSummary, capacity), [unmeasured, storedSummary, capacity]);
    const retry = React.useCallback(() => {
        if (measurement?.status === 'failed') void machineStorageStore.sizeAgain(key);
        else machineStorageStore.retry(key);
    }, [key, measurement?.status]);
    const sizeAgain = React.useCallback(() => machineStorageStore.sizeAgain(key), [key]);
    return React.useMemo(() => ({ status, summary, failure, enabled, offline, retry, sizeAgain }), [status, summary, failure, enabled, offline, retry, sizeAgain]);
}
