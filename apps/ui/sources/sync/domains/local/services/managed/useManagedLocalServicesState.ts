import * as React from 'react';

import {
    type ManagedLocalServicesSnapshot,
    type ManagedLocalServicesState,
} from './store';
import type {
    LocalServiceManagedSnapshotClientInput,
    LocalServiceManagedSnapshotClientResult,
} from './api';
import {
    EMPTY_MANAGED_LOCAL_SERVICES_STATE,
    getManagedLocalServicesState,
    publishManagedLocalServicesSnapshot,
    subscribeManagedLocalServicesStore,
    type ManagedLocalServicesStoreKeyInput,
} from './sharedStore';

export type LocalServiceManagedSnapshotClient = (
    input: LocalServiceManagedSnapshotClientInput,
) => Promise<LocalServiceManagedSnapshotClientResult>;

export type ManagedLocalServicesStateController = Readonly<{
    state: ManagedLocalServicesState;
    applySnapshot: (snapshot: ManagedLocalServicesSnapshot) => void;
}>;

export type UseManagedLocalServicesStateInput = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    enabled?: boolean;
    refreshIntervalMs?: number | null;
    nowMs?: () => number;
    snapshotClient?: LocalServiceManagedSnapshotClient;
}>;

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

export function useManagedLocalServicesStateController(
    input: UseManagedLocalServicesStateInput,
): ManagedLocalServicesStateController {
    const enabled = input.enabled ?? true;
    const machineId = normalizeId(input.machineId);
    const serverId = normalizeId(input.serverId);
    const sessionId = normalizeId(input.sessionId);
    const snapshotClient = input.snapshotClient;
    const nowMs = input.nowMs ?? Date.now;
    const snapshotClientRef = React.useRef(snapshotClient);
    const nowMsRef = React.useRef(nowMs);
    const storeKey = React.useMemo<ManagedLocalServicesStoreKeyInput | null>(() => (
        enabled && machineId ? { machineId, serverId, sessionId } : null
    ), [enabled, machineId, serverId, sessionId]);

    React.useEffect(() => {
        snapshotClientRef.current = snapshotClient;
        nowMsRef.current = nowMs;
    }, [nowMs, snapshotClient]);

    const subscribe = React.useCallback((listener: () => void) => (
        storeKey
            ? subscribeManagedLocalServicesStore(storeKey, listener, {
                ...(snapshotClientRef.current ? { snapshotClient: (request) => snapshotClientRef.current!(request) } : {}),
                nowMs: () => nowMsRef.current(),
            })
            : () => {}
    ), [storeKey]);

    const getSnapshot = React.useCallback(() => (
        storeKey ? getManagedLocalServicesState(storeKey) : EMPTY_MANAGED_LOCAL_SERVICES_STATE
    ), [storeKey]);

    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const applySnapshot = React.useCallback((snapshot: ManagedLocalServicesSnapshot) => {
        if (storeKey) {
            publishManagedLocalServicesSnapshot(storeKey, snapshot);
        }
    }, [storeKey]);

    return React.useMemo(() => ({ state, applySnapshot }), [applySnapshot, state]);
}

export function useManagedLocalServicesState(
    input: UseManagedLocalServicesStateInput,
): ManagedLocalServicesState {
    return useManagedLocalServicesStateController(input).state;
}
