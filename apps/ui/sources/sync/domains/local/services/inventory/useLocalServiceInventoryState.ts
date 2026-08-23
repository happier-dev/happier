import * as React from 'react';

import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

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
    const enabled = input.enabled ?? true;
    const machineId = normalizeId(input.machineId);
    const serverId = normalizeId(input.serverId);
    const sessionId = normalizeId(input.sessionId);
    const snapshotClient = input.snapshotClient;
    const watchClient = input.watchClient;
    const nowMs = input.nowMs ?? Date.now;
    const snapshotClientRef = React.useRef(snapshotClient);
    const watchClientRef = React.useRef(watchClient);
    const nowMsRef = React.useRef(nowMs);
    const storeKey = React.useMemo<LocalServiceInventoryStoreKeyInput | null>(() => (
        enabled && machineId ? { machineId, serverId, sessionId } : null
    ), [enabled, machineId, serverId, sessionId]);

    React.useEffect(() => {
        snapshotClientRef.current = snapshotClient;
        watchClientRef.current = watchClient;
        nowMsRef.current = nowMs;
    }, [nowMs, snapshotClient, watchClient]);

    const subscribe = React.useCallback((listener: () => void) => (
        storeKey
            ? subscribeLocalServiceInventoryStore(storeKey, listener, {
                ...(snapshotClientRef.current ? { snapshotClient: (request) => snapshotClientRef.current!(request) } : {}),
                ...(watchClientRef.current ? { watchClient: (request) => watchClientRef.current!(request) } : {}),
                nowMs: () => nowMsRef.current(),
            })
            : () => {}
    ), [storeKey]);

    const getSnapshot = React.useCallback(() => (
        storeKey ? getLocalServiceInventoryState(storeKey) : EMPTY_LOCAL_SERVICE_INVENTORY_STATE
    ), [storeKey]);

    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const applySnapshot = React.useCallback((snapshot: LocalServiceInventorySnapshot) => {
        if (storeKey) {
            publishLocalServiceInventorySnapshot(storeKey, snapshot);
        }
    }, [storeKey]);

    const refresh = React.useMemo(() => (
        storeKey ? () => invalidateLocalServiceInventoryStore(storeKey) : undefined
    ), [storeKey]);

    // The parked daemon watch is the primary freshness path, but it cannot survive a suspended app
    // or a dropped socket. Coming back into view is the one moment where the user can see stale
    // rows, so returning to the foreground re-reads and restarts the watch through the same
    // invalidation the refresh control uses — one owner, no second cadence and no timer.
    const activelyViewed = useHostActivelyViewed();
    const wasActivelyViewedRef = React.useRef(activelyViewed);
    React.useEffect(() => {
        const returnedToView = activelyViewed && !wasActivelyViewedRef.current;
        wasActivelyViewedRef.current = activelyViewed;
        if (returnedToView) {
            refresh?.();
        }
    }, [activelyViewed, refresh]);

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
