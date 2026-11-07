import * as React from 'react';
import { machineStorageStore, type MachineStorageReceipt } from './machineStorageStore';
import { useMachineStorageTarget, type MachineStorageHookInput } from './useMachineStorage';
import type { MachineStorageApplyItem, MachineStorageCheckInput, MachineStorageReadInput, MachineStorageTrashEmptyInput, MachineStorageTrashRestoreInput } from './machineRpc';

type Without<T> = Omit<T, keyof MachineStorageReadInput>;

/**
 * The review sheet and the pile bar's result (plan 40 STO-12–17): check the pile again on the machine,
 * move to Trash or delete now exactly what stays ticked, then Undo (Put back that batch) or Empty now.
 * Every call is one storage Action; the receipt lives in the storage store, per machine.
 */
export function useMachineStorageCleanup(input: MachineStorageHookInput) {
    const { key, enabled } = useMachineStorageTarget(input);
    const subscribe = React.useCallback((listener: () => void) => machineStorageStore.observeReceipt(key, listener), [key]);
    const snapshot = React.useCallback((): MachineStorageReceipt | null => machineStorageStore.getReceipt(key), [key]);
    const receipt = React.useSyncExternalStore(subscribe, snapshot, snapshot);
    const subscribeRestore = React.useCallback((listener: () => void) => machineStorageStore.observeRestoreOutcomes(key, listener), [key]);
    const restoreSnapshot = React.useCallback(() => machineStorageStore.getRestoreOutcomes(key), [key]);
    const restoreOutcomes = React.useSyncExternalStore(subscribeRestore, restoreSnapshot, restoreSnapshot);
    return React.useMemo(() => ({
        enabled,
        receipt,
        restoreOutcomes,
        putBackBeside: (entryId: string) => machineStorageStore.restoreTrashBeside({ ...key, entryId }),
        check: (refs: Without<MachineStorageCheckInput>['refs']) => machineStorageStore.checkPile({ ...key, refs }),
        apply: (mode: 'trash' | 'delete', items: readonly MachineStorageApplyItem[]) => machineStorageStore.applyPile({ ...key, mode, items }),
        undo: () => machineStorageStore.undoReceipt(key),
        emptyNow: () => machineStorageStore.emptyReceipt(key),
        dismiss: () => machineStorageStore.dismissReceipt(key),
        restore: (selection: Without<MachineStorageTrashRestoreInput>) => machineStorageStore.restoreTrash({ ...key, ...selection }),
        empty: (selection: Without<MachineStorageTrashEmptyInput>) => machineStorageStore.emptyTrash({ ...key, ...selection }),
        setProtected: (path: string, protect: boolean) => machineStorageStore.setProtectedFolder({ ...key, path, protect }),
    }), [enabled, key, receipt, restoreOutcomes]);
}
