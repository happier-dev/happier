import * as React from 'react';

import type {
    LocalServicePublicPreviewStatusClientInput,
    LocalServicePublicPreviewStatusClientResult,
} from './api';
import {
    EMPTY_LOCAL_SERVICE_PUBLIC_PREVIEW_STATE,
    getLocalServicePublicPreviewState,
    publishLocalServicePublicPreviewSnapshot,
    subscribeLocalServicePublicPreviewStore,
} from './sharedStore';
import { type LocalServicePublicPreviewState } from './store';
import type { LocalServicePublicPreviewSnapshotV1 } from '@happier-dev/protocol';

export type LocalServicePublicPreviewStatusClient = (
    input: LocalServicePublicPreviewStatusClientInput,
) => Promise<LocalServicePublicPreviewStatusClientResult>;

export type LocalServicePublicPreviewStateController = Readonly<{
    state: LocalServicePublicPreviewState;
    applySnapshot: (snapshot: LocalServicePublicPreviewSnapshotV1) => void;
}>;

export type UseLocalServicePublicPreviewStateInput = Readonly<{
    machineId?: string | null;
    sessionId?: string | null;
    previewId?: string | null;
    exposureId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
    nowMs?: () => number;
    statusClient?: LocalServicePublicPreviewStatusClient;
}>;

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

export function useLocalServicePublicPreviewStateController(
    input: UseLocalServicePublicPreviewStateInput,
): LocalServicePublicPreviewStateController {
    const enabled = input.enabled ?? true;
    const machineId = normalizeId(input.machineId);
    const sessionId = normalizeId(input.sessionId);
    const previewId = normalizeId(input.previewId);
    const exposureId = normalizeId(input.exposureId);
    const serverId = normalizeId(input.serverId);
    const active = enabled && Boolean(machineId);

    const statusClientRef = React.useRef(input.statusClient);
    const nowMsRef = React.useRef(input.nowMs);
    React.useEffect(() => {
        statusClientRef.current = input.statusClient;
        nowMsRef.current = input.nowMs;
    }, [input.nowMs, input.statusClient]);

    const subscribe = React.useCallback((onStoreChange: () => void): (() => void) => {
        if (!active || !machineId) {
            return () => {};
        }
        return subscribeLocalServicePublicPreviewStore(
            { machineId, serverId, sessionId, previewId, exposureId },
            onStoreChange,
            {
                ...(statusClientRef.current ? { statusClient: statusClientRef.current } : {}),
                ...(nowMsRef.current ? { nowMs: nowMsRef.current } : {}),
            },
        );
    }, [active, exposureId, machineId, previewId, serverId, sessionId]);

    const getSnapshot = React.useCallback((): LocalServicePublicPreviewState => (
        active && machineId
            ? getLocalServicePublicPreviewState({ machineId, serverId, sessionId, previewId, exposureId })
            : EMPTY_LOCAL_SERVICE_PUBLIC_PREVIEW_STATE
    ), [active, exposureId, machineId, previewId, serverId, sessionId]);

    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const applySnapshot = React.useCallback((snapshot: LocalServicePublicPreviewSnapshotV1) => {
        if (!active || !machineId) {
            return;
        }
        publishLocalServicePublicPreviewSnapshot(
            { machineId, serverId, sessionId, previewId, exposureId },
            snapshot,
        );
    }, [active, exposureId, machineId, previewId, serverId, sessionId]);

    return React.useMemo(() => ({ state, applySnapshot }), [applySnapshot, state]);
}

export function useLocalServicePublicPreviewState(
    input: UseLocalServicePublicPreviewStateInput,
): LocalServicePublicPreviewState {
    return useLocalServicePublicPreviewStateController(input).state;
}
