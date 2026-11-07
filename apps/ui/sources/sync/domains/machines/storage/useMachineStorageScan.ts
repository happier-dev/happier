import * as React from 'react';
import type { DiskNodeV1, DiskScanViewV1, DiskScanStateV1, HappierStorageSummaryV1, MachineStorageScanGetResultV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineStorageReadInput, MachineStorageResult, MachineStorageScanStartInput } from './machineRpc';
import { machineStorageStore, type MachineStorageScanStartFailure, type MachineStorageScanState, type MachineStorageState } from './machineStorageStore';
import { selectStorageScan, selectStorageStatus, useMachineStorageDemand, useMachineStorageSelection, useMachineStorageTarget, type MachineStorageHookInput } from './useMachineStorage';

export type MachineStorageScanHookInput = MachineStorageHookInput & Readonly<{ scanId?: string; view?: DiskScanViewV1 }>;
export type MachineStorageScanHookResult = Readonly<{
    status: MachineStorageState['status'];
    wholeDisk: HappierStorageSummaryV1['wholeDisk'] | null;
    offline: boolean;
    retry: () => void;
    scanStatus: MachineStorageScanState['status'];
    page: MachineStorageScanGetResultV1 | null;
    nodes: readonly DiskNodeV1[];
    /** Why the last start did not happen, until the next attempt or a started scan. */
    startFailure: MachineStorageScanStartFailure | null;
    start: (request: Omit<MachineStorageScanStartInput, keyof MachineStorageReadInput>) => Promise<MachineStorageResult<DiskScanStateV1>>;
    cancel: (scanId: string) => Promise<MachineStorageResult<DiskScanStateV1>>;
    skip: (scanId: string, path: string) => Promise<MachineStorageResult<DiskScanStateV1>>;
}>;
const EMPTY_NODES: readonly DiskNodeV1[] = [];

export function useMachineStorageScan(input: MachineStorageScanHookInput): MachineStorageScanHookResult {
    const { key, enabled, offline } = useMachineStorageTarget(input);
    useMachineStorageDemand(key, enabled);
    const status = useMachineStorageSelection(key, selectStorageStatus);
    const wholeDisk = useMachineStorageSelection(key, selectStorageScan);
    const viewKey = JSON.stringify(input.view);
    const scanInput = React.useMemo(() => ({ ...key, ...(input.scanId ? { scanId: input.scanId } : {}),
        ...(viewKey ? { view: JSON.parse(viewKey) as DiskScanViewV1 } : {}) }), [key, input.scanId, viewKey]);
    const detailsRequested = !!input.scanId || !!input.view;
    const subscribe = React.useCallback((listener: () => void) => machineStorageStore.observeScan(scanInput, listener), [scanInput]);
    const snapshot = React.useCallback(() => machineStorageStore.getScan(scanInput), [scanInput]);
    const details = React.useSyncExternalStore(subscribe, snapshot, snapshot);
    React.useEffect(() => { if (enabled && detailsRequested) return machineStorageStore.demandScan(scanInput); }, [enabled, detailsRequested, scanInput]);
    const retry = React.useCallback(() => { machineStorageStore.retry(key); if (detailsRequested) machineStorageStore.retryScan(scanInput); }, [key, detailsRequested, scanInput]);
    const start = React.useCallback<MachineStorageScanHookResult['start']>(request => enabled
        ? machineStorageStore.startScan({ ...key, ...request }) : Promise.resolve({ ok: false, reason: 'request_failed' }), [key, enabled]);
    const cancel = React.useCallback<MachineStorageScanHookResult['cancel']>(scanId => enabled
        ? machineStorageStore.cancelScan({ ...key, scanId }) : Promise.resolve({ ok: false, reason: 'request_failed' }), [key, enabled]);
    const skip = React.useCallback<MachineStorageScanHookResult['skip']>((scanId, path) => enabled
        ? machineStorageStore.skipScan({ ...key, scanId, path }) : Promise.resolve({ ok: false, reason: 'request_failed' }), [key, enabled]);
    const subscribeFailure = React.useCallback((listener: () => void) => machineStorageStore.observeScanStartFailure(key, listener), [key]);
    const failureSnapshot = React.useCallback(() => machineStorageStore.getScanStartFailure(key), [key]);
    const startFailure = React.useSyncExternalStore(subscribeFailure, failureSnapshot, failureSnapshot);
    const scanStatus = details.status;
    const page = details.page;
    const nodes = page?.nodes ?? EMPTY_NODES;
    return React.useMemo(() => ({ status, wholeDisk, offline, retry, scanStatus, page, nodes, startFailure, start, cancel, skip }),
        [status, wholeDisk, offline, retry, scanStatus, page, nodes, startFailure, start, cancel, skip]);
}
