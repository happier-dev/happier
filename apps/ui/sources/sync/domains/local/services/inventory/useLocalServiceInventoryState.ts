import * as React from 'react';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveMachineDaemonReadServerId } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { useHostActivelyViewedEffect } from '@/utils/runtime/useHostActivelyViewed';

import {
    type LocalServiceInventorySnapshot,
    type LocalServiceInventoryState,
} from './store';
import type {
    LocalServiceInventorySnapshotClientInput,
    LocalServiceInventorySnapshotClientResult,
    LocalServiceInventoryWatchClientInput,
    LocalServiceInventoryWatchClientResult,
} from './api';
import {
    EMPTY_LOCAL_SERVICE_INVENTORY_STATE,
    getLocalServiceInventoryState,
    invalidateLocalServiceInventoryStore,
    publishLocalServiceInventorySnapshot,
    revalidateLocalServiceInventoryStore,
    subscribeLocalServiceInventoryStore,
    type LocalServiceInventoryStoreKeyInput,
} from './sharedStore';

export type LocalServiceInventorySnapshotClient = (
    input: LocalServiceInventorySnapshotClientInput,
) => Promise<LocalServiceInventorySnapshotClientResult>;

export type LocalServiceInventoryWatchClient = (
    input: LocalServiceInventoryWatchClientInput,
) => Promise<LocalServiceInventoryWatchClientResult>;

export type LocalServiceInventoryStateController = Readonly<{
    state: LocalServiceInventoryState;
    applySnapshot: (snapshot: LocalServiceInventorySnapshot) => void;
    /**
     * User-initiated refresh. Undefined when there is no machine to read, so a surface can render
     * the affordance only where it can actually do something.
     */
    refresh: (() => void) | undefined;
}>;

export type UseLocalServiceInventoryStateInput = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    enabled?: boolean;
    nowMs?: () => number;
    snapshotClient?: LocalServiceInventorySnapshotClient;
    watchClient?: LocalServiceInventoryWatchClient;
}>;

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

export function useLocalServiceInventoryStateController(
    input: UseLocalServiceInventoryStateInput,
): LocalServiceInventoryStateController {
    const presented = useLayoutPresentationActive();
    const eligible = input.enabled ?? true;
    const enabled = eligible && presented;
    const machineId = normalizeId(input.machineId);
    const serverId = resolveMachineDaemonReadServerId(input.serverId);
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const sessionId = normalizeId(input.sessionId);
    const snapshotClient = input.snapshotClient;
    const watchClient = input.watchClient;
    const nowMs = input.nowMs ?? Date.now;
    const snapshotClientRef = React.useRef(snapshotClient);
    const watchClientRef = React.useRef(watchClient);
    const nowMsRef = React.useRef(nowMs);
    const storeKey = React.useMemo<LocalServiceInventoryStoreKeyInput | null>(() => (
        eligible && machineId && binding?.isCurrent() && binding.credentialKey
            ? { machineId, serverId, sessionId, accountId: binding.accountId, credentialKey: binding.credentialKey } : null
    ), [binding, eligible, machineId, serverId, sessionId]);

    React.useEffect(() => {
        snapshotClientRef.current = snapshotClient;
        watchClientRef.current = watchClient;
        nowMsRef.current = nowMs;
    }, [nowMs, snapshotClient, watchClient]);

    const subscribe = React.useCallback((listener: () => void) => {
        if (!enabled || !storeKey || !binding?.isCurrent()) return () => {};
        const release = subscribeLocalServiceInventoryStore(storeKey, listener, {
                ...(snapshotClientRef.current ? { snapshotClient: (request) => snapshotClientRef.current!(request) } : {}),
                ...(watchClientRef.current ? { watchClient: (request) => watchClientRef.current!(request) } : {}),
                nowMs: () => nowMsRef.current(),
        });
        const retirement = binding.onRetire(() => { release(); listener(); });
        return () => { retirement.dispose(); release(); };
    }, [binding, enabled, storeKey]);

    const getSnapshot = React.useCallback(() => (
        storeKey && binding?.isCurrent() ? getLocalServiceInventoryState(storeKey) : EMPTY_LOCAL_SERVICE_INVENTORY_STATE
    ), [binding, storeKey]);

    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const applySnapshot = React.useCallback((snapshot: LocalServiceInventorySnapshot) => {
        if (storeKey && binding?.isCurrent()) {
            publishLocalServiceInventorySnapshot(storeKey, snapshot);
        }
    }, [binding, storeKey]);

    const refresh = React.useMemo(() => (
        enabled && storeKey && binding?.isCurrent()
            ? () => { if (binding.isCurrent()) invalidateLocalServiceInventoryStore(storeKey); } : undefined
    ), [binding, enabled, storeKey]);

    // The parked daemon watch is the primary freshness path, but it cannot survive a suspended app
    // or a dropped socket. Coming back into view is the one moment where the user can see stale
    // rows, so returning to the foreground re-reads the daemon's current inventory and restarts
    // the watch through the same store owner — no second cadence, no timer and no forced scan.
    const wasActivelyViewedRef = React.useRef(true);
    useHostActivelyViewedEffect((activelyViewed) => {
        const returnedToView = activelyViewed && !wasActivelyViewedRef.current;
        wasActivelyViewedRef.current = activelyViewed;
        if (returnedToView && enabled && storeKey && binding?.isCurrent()) {
            revalidateLocalServiceInventoryStore(storeKey);
        }
    }, [binding, enabled, storeKey]);

    return React.useMemo(
        () => ({ state, applySnapshot, refresh }),
        [applySnapshot, refresh, state],
    );
}

export function useLocalServiceInventoryState(
    input: UseLocalServiceInventoryStateInput,
): LocalServiceInventoryState {
    return useLocalServiceInventoryStateController(input).state;
}
