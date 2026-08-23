import * as React from 'react';

import {
    type LocalServiceInventorySnapshot,
    type LocalServiceInventoryState,
} from './store';
import type {
    LocalServiceInventorySnapshotClientInput,
    LocalServiceInventorySnapshotClientResult,
} from './api';
import {
    EMPTY_LOCAL_SERVICE_INVENTORY_STATE,
    getLocalServiceInventoryState,
    publishLocalServiceInventorySnapshot,
    subscribeLocalServiceInventoryStore,
    type LocalServiceInventoryStoreKeyInput,
} from './sharedStore';

export type LocalServiceInventorySnapshotClient = (
    input: LocalServiceInventorySnapshotClientInput,
) => Promise<LocalServiceInventorySnapshotClientResult>;

export type LocalServiceInventoryStateController = Readonly<{
    state: LocalServiceInventoryState;
    applySnapshot: (snapshot: LocalServiceInventorySnapshot) => void;
}>;

export type UseLocalServiceInventoryStateInput = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    enabled?: boolean;
    nowMs?: () => number;
    snapshotClient?: LocalServiceInventorySnapshotClient;
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
    const nowMs = input.nowMs ?? Date.now;
    const snapshotClientRef = React.useRef(snapshotClient);
    const nowMsRef = React.useRef(nowMs);
    const storeKey = React.useMemo<LocalServiceInventoryStoreKeyInput | null>(() => (
        enabled && machineId ? { machineId, serverId, sessionId } : null
    ), [enabled, machineId, serverId, sessionId]);

    React.useEffect(() => {
        snapshotClientRef.current = snapshotClient;
        nowMsRef.current = nowMs;
    }, [nowMs, snapshotClient]);

    const subscribe = React.useCallback((listener: () => void) => (
        storeKey
            ? subscribeLocalServiceInventoryStore(storeKey, listener, {
                ...(snapshotClientRef.current ? { snapshotClient: (request) => snapshotClientRef.current!(request) } : {}),
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

    return React.useMemo(() => ({ state, applySnapshot }), [applySnapshot, state]);
}

export function useLocalServiceInventoryState(
    input: UseLocalServiceInventoryStateInput,
): LocalServiceInventoryState {
    return useLocalServiceInventoryStateController(input).state;
}
