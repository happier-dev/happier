import * as React from 'react';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { TrashEntryV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineGuardActivityRowV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { machineGuardStore, type MachineGuardActivityKey, type MachineGuardActivityState } from '../guard/machineGuardStore';
import { useMachineDaemonReadIdentities } from '../useMachineDaemonReadTarget';
import type { MachineDaemonReadKey } from '../useMachineDaemonReadTarget';
import { machineStorageStore, type MachineStorageCategoryState } from './machineStorageStore';
import type { MachineStorageKey } from './machineRpc';

const EMPTY_CATEGORY: MachineStorageCategoryState = { status: 'loading', page: null };
const EMPTY_ACTIVITY: MachineGuardActivityState = { status: 'loading', list: null };

/** Receipts borrow the qualified category and Activity owners, never a per-card loader or ledger. */
export function useTrashReceiptSources(input: MachineStorageKey | null, refreshRequest: ApprovalRequest | null): Readonly<{
    ready: boolean;
    unavailable: boolean;
    scope: MachineDaemonReadKey | null;
    entries: readonly TrashEntryV1[] | null;
    activity: readonly MachineGuardActivityRowV1[] | null;
}> {
    const target = useMachineDaemonReadIdentities(input ? [input] : []).at(0) ?? null;
    const key = target?.key ?? null;
    const activityKey = React.useMemo<MachineGuardActivityKey | null>(() => key ? { ...key, range: '30d', filter: 'all' } : null, [key]);
    const subscribeTrash = React.useCallback((listener: () => void) => key
        ? machineStorageStore.observeTrashInventory(key, listener) : () => {}, [key]);
    const readTrash = React.useCallback(() => key && target?.accountMatches
        ? machineStorageStore.getTrashInventory(key) : EMPTY_CATEGORY, [key, target?.accountMatches]);
    const subscribeTrashRefreshing = React.useCallback((listener: () => void) => key
        ? machineStorageStore.observeTrashInventoryRefreshing(key, listener) : () => {}, [key]);
    const readTrashRefreshing = React.useCallback(() => key ? machineStorageStore.isTrashInventoryRefreshing(key) : false, [key]);
    const subscribeActivity = React.useCallback((listener: () => void) => activityKey
        ? machineGuardStore.observeActivity(activityKey, listener) : () => {}, [activityKey]);
    const readActivity = React.useCallback(() => activityKey && target?.accountMatches
        ? machineGuardStore.getActivity(activityKey) : EMPTY_ACTIVITY, [activityKey, target?.accountMatches]);
    const subscribeActivityRefreshing = React.useCallback((listener: () => void) => activityKey
        ? machineGuardStore.observeActivityRefreshing(activityKey, listener) : () => {}, [activityKey]);
    const readActivityRefreshing = React.useCallback(() => activityKey ? machineGuardStore.isActivityRefreshing(activityKey) : false, [activityKey]);
    const trash = React.useSyncExternalStore(subscribeTrash, readTrash, readTrash);
    const activity = React.useSyncExternalStore(subscribeActivity, readActivity, readActivity);
    const trashRefreshing = React.useSyncExternalStore(subscribeTrashRefreshing, readTrashRefreshing, readTrashRefreshing);
    const activityRefreshing = React.useSyncExternalStore(subscribeActivityRefreshing, readActivityRefreshing, readActivityRefreshing);
    const [completedTarget, setCompletedTarget] = React.useState<typeof target>(null);

    React.useEffect(() => {
        if (!target?.enabled || !target.accountBinding || !key || !activityKey) return;
        const releaseTrash = machineStorageStore.demandTrashInventory(key);
        const releaseActivity = machineGuardStore.demandActivity(activityKey);
        let active = true;
        const release = () => {
            if (!active) return;
            active = false;
            releaseTrash(); releaseActivity();
        };
        const retirement = target.accountBinding.onRetire(release);
        void Promise.all([machineStorageStore.readTrashInventoryOnce(key), machineGuardStore.readActivityOnce(activityKey)])
            .then(() => { if (active && target.accountBinding?.isCurrent()) setCompletedTarget(target); });
        return () => { retirement.dispose(); release(); };
    }, [target, key, activityKey]);

    React.useEffect(() => {
        if (!target?.enabled || !key || !activityKey) return;
        // A fresh approval snapshot is the existing explicit reopen/retry, not
        // a timer. Other cards join the owners' in-flight recovery.
        const category = machineStorageStore.getTrashInventory(key);
        if (category.status !== 'ready' && category.status !== 'loading' && !machineStorageStore.isTrashInventoryRefreshing(key)) {
            void machineStorageStore.retryTrashInventory(key);
        }
        const currentActivity = machineGuardStore.getActivity(activityKey);
        if (currentActivity.status !== 'ready' && currentActivity.status !== 'loading' && !machineGuardStore.isActivityRefreshing(activityKey)) {
            machineGuardStore.retryActivity(activityKey);
        }
    }, [target, key, activityKey, refreshRequest]);

    return {
        scope: key,
        ready: !!target?.enabled && completedTarget === target && !trashRefreshing && !activityRefreshing,
        unavailable: input !== null && !!target && target.credentialResolution !== 'resolving'
            && (target.credentialResolution !== 'bound' || !target.accountMatches),
        entries: trash.status === 'ready' ? trash.page?.trashEntries ?? null : null,
        activity: activity.status === 'ready' ? activity.list?.entries ?? null : null,
    };
}
