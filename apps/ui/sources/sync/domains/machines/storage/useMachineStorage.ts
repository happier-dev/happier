import * as React from 'react';
import type { HappierStorageCategoryIdV1, HappierStorageSummaryV1 } from '@happier-dev/protocol/storage/storageV1';
import { useMachineDaemonReadTarget, useMachineDaemonRevisionObserver } from '../useMachineDaemonReadTarget';
import { machineStorageStore, type MachineStorageState } from './machineStorageStore';
import type { MachineStorageKey } from './machineRpc';

export type MachineStorageHookInput = MachineStorageKey & Readonly<{ enabled?: boolean; online?: boolean | null }>;

/** Exact Home/Account identity comes from the one daemon-read target; storage adds its daemon-restart edge. */
export function useMachineStorageTarget(input: MachineStorageHookInput) {
    const { key, enabled, offline } = useMachineDaemonReadTarget({ ...input, observeDaemonStateVersion: false });
    useMachineDaemonRevisionObserver(key, React.useCallback(version => {
        machineStorageStore.daemonStateChanged(key, version);
    }, [key]));
    return { key, enabled, offline };
}

export function useMachineStorageSelection<T>(key: MachineStorageKey, select: (state: MachineStorageState) => T): T {
    const subscribe = React.useCallback((listener: () => void) => machineStorageStore.observe(key, listener), [key]);
    const getSnapshot = React.useCallback(() => select(machineStorageStore.getState(key)), [key, select]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const selectStorageStatus = (state: MachineStorageState) => state.status;
export const selectStorageSummary = (state: MachineStorageState) => state.summary;
export const selectStorageFailure = (state: MachineStorageState) => state.failure;
export const selectStoragePile = (state: MachineStorageState) => state.summary?.pile ?? null;
export const selectStorageScan = (state: MachineStorageState) => state.summary?.wholeDisk ?? null;

export function useMachineStorageDemand(key: MachineStorageKey, enabled: boolean): void {
    React.useEffect(() => {
        if (!enabled) return;
        return machineStorageStore.demand(key);
    }, [enabled, key]);
}

export type MachineStorageSummary = HappierStorageSummaryV1;
export type MachineStorageCategoryHookInput = MachineStorageHookInput & Readonly<{ categoryId: HappierStorageCategoryIdV1; cursor?: string }>;
