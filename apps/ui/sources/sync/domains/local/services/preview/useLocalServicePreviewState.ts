import * as React from 'react';

import {
    type LocalServicePreviewSnapshotClientInput,
    type LocalServicePreviewSnapshotClientResult,
} from './api';
import {
    EMPTY_LOCAL_SERVICE_PREVIEW_STATE,
    getLocalServicePreviewState,
    subscribeLocalServicePreviewStore,
} from './sharedStore';
import { type LocalServicePreviewState } from './store';

export type LocalServicePreviewSnapshotClient = (
    input: LocalServicePreviewSnapshotClientInput,
) => Promise<LocalServicePreviewSnapshotClientResult>;

export type UseLocalServicePreviewStateInput = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
    nowMs?: () => number;
    snapshotClient?: LocalServicePreviewSnapshotClient;
}>;

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * Read the shared preview-status store for a (serverId, machineId) key.
 *
 * PRV-4: this no longer owns per-mount state or a 15s `setInterval` poll. Every mount subscribes
 * to one keyed entry in {@link ./sharedStore}; the first subscriber triggers a single fetch and
 * the runtime-action executor publishes lifecycle snapshots into the same store, so an open pane
 * refreshes from an action without any wall-clock timer.
 */
export function useLocalServicePreviewState(
    input: UseLocalServicePreviewStateInput,
): LocalServicePreviewState {
    const enabled = input.enabled ?? true;
    const machineId = normalizeId(input.machineId);
    const serverId = normalizeId(input.serverId);
    const active = enabled && Boolean(machineId);

    // Hold the latest injected client/clock without forcing a resubscribe — only the key
    // (active/machineId/serverId) controls subscription identity.
    const snapshotClientRef = React.useRef(input.snapshotClient);
    const nowMsRef = React.useRef(input.nowMs);
    React.useEffect(() => {
        snapshotClientRef.current = input.snapshotClient;
        nowMsRef.current = input.nowMs;
    }, [input.nowMs, input.snapshotClient]);

    const subscribe = React.useCallback((onStoreChange: () => void): (() => void) => {
        if (!active || !machineId) {
            return () => {};
        }
        return subscribeLocalServicePreviewStore(
            { machineId, serverId },
            onStoreChange,
            {
                ...(snapshotClientRef.current ? { snapshotClient: snapshotClientRef.current } : {}),
                ...(nowMsRef.current ? { nowMs: nowMsRef.current } : {}),
            },
        );
    }, [active, machineId, serverId]);

    const getSnapshot = React.useCallback((): LocalServicePreviewState => (
        active && machineId
            ? getLocalServicePreviewState({ machineId, serverId })
            : EMPTY_LOCAL_SERVICE_PREVIEW_STATE
    ), [active, machineId, serverId]);

    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
