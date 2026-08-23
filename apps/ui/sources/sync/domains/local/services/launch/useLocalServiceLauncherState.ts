import * as React from 'react';

import type {
    LocalServiceLauncherSnapshotClientInput,
    LocalServiceLauncherSnapshotClientResult,
} from './api';
import {
    EMPTY_LOCAL_SERVICE_LAUNCHER_STATE,
    getLocalServiceLauncherState,
    publishLocalServiceLauncherSnapshot,
    subscribeLocalServiceLauncherStore,
    type LocalServiceLauncherStoreKeyInput,
} from './sharedStore';
import type {
    LocalServiceLauncherSnapshot,
    LocalServiceLauncherState,
} from './types';

export type LocalServiceLauncherSnapshotClient = (
    input: LocalServiceLauncherSnapshotClientInput,
) => Promise<LocalServiceLauncherSnapshotClientResult>;

export type UseLocalServiceLauncherStateInput = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    scope?: 'workspace' | 'machine' | null;
    workspaceRoot?: string | null;
    enabled?: boolean;
    nowMs?: () => number;
    snapshotClient?: LocalServiceLauncherSnapshotClient;
}>;

export type LocalServiceLauncherStateController = Readonly<{
    state: LocalServiceLauncherState;
    applySnapshot: (snapshot: LocalServiceLauncherSnapshot) => void;
}>;

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

export function useLocalServiceLauncherStateController(
    input: UseLocalServiceLauncherStateInput,
): LocalServiceLauncherStateController {
    const enabled = input.enabled ?? true;
    const machineId = normalizeId(input.machineId);
    const serverId = normalizeId(input.serverId);
    const sessionId = normalizeId(input.sessionId);
    const scope = input.scope ?? null;
    const workspaceRoot = normalizeId(input.workspaceRoot);
    const snapshotClient = input.snapshotClient;
    const nowMs = input.nowMs ?? Date.now;
    const snapshotClientRef = React.useRef(snapshotClient);
    const nowMsRef = React.useRef(nowMs);
    const storeKey = React.useMemo<LocalServiceLauncherStoreKeyInput | null>(() => (
        enabled && machineId ? { machineId, serverId, sessionId, scope, workspaceRoot } : null
    ), [enabled, machineId, scope, serverId, sessionId, workspaceRoot]);
    const applySnapshot = React.useCallback((snapshot: LocalServiceLauncherSnapshot) => {
        if (!storeKey || snapshot.machineId !== storeKey.machineId) {
            return;
        }
        if (storeKey.sessionId && snapshot.sessionId !== storeKey.sessionId) {
            return;
        }
        publishLocalServiceLauncherSnapshot(storeKey, snapshot);
    }, [storeKey]);

    React.useEffect(() => {
        snapshotClientRef.current = snapshotClient;
        nowMsRef.current = nowMs;
    }, [nowMs, snapshotClient]);

    const subscribe = React.useCallback((listener: () => void) => (
        storeKey
            ? subscribeLocalServiceLauncherStore(storeKey, listener, {
                ...(snapshotClientRef.current ? { snapshotClient: (request) => snapshotClientRef.current!(request) } : {}),
                nowMs: () => nowMsRef.current(),
            })
            : () => {}
    ), [storeKey]);

    const getSnapshot = React.useCallback(() => (
        storeKey ? getLocalServiceLauncherState(storeKey) : EMPTY_LOCAL_SERVICE_LAUNCHER_STATE
    ), [storeKey]);

    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    return React.useMemo(() => ({
        state,
        applySnapshot,
    }), [applySnapshot, state]);
}

export function useLocalServiceLauncherState(
    input: UseLocalServiceLauncherStateInput,
): LocalServiceLauncherState {
    return useLocalServiceLauncherStateController(input).state;
}
