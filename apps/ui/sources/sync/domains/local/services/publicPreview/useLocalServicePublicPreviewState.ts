import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';

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
import type { LocalServicePublicPreviewSnapshotV1 } from '@happier-dev/protocol/local/services/public/v1';

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
    const presented = useLayoutPresentationActive();
    const enabled = (input.enabled ?? true) && presented;
    const machineId = normalizeId(input.machineId);
    const sessionId = normalizeId(input.sessionId);
    const previewId = normalizeId(input.previewId);
    const exposureId = normalizeId(input.exposureId);
    const requestedServerId = normalizeId(input.serverId);
    const activeServer = useActiveServerSnapshot(!requestedServerId);
    const serverId = resolveServerProfileScopeIdForIdentifier(requestedServerId ?? activeServer.serverId) || null;
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const active = enabled && Boolean(machineId) && binding?.isCurrent() === true;
    const storeKey = React.useMemo(() => ({ machineId: machineId ?? '', serverId, sessionId, previewId, exposureId,
        accountId: binding?.accountId ?? null, credentialKey: binding?.credentialKey ?? null }),
    [binding, exposureId, machineId, previewId, serverId, sessionId]);

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
            storeKey,
            onStoreChange,
            {
                ...(statusClientRef.current ? { statusClient: statusClientRef.current } : {}),
                ...(nowMsRef.current ? { nowMs: nowMsRef.current } : {}),
            },
        );
    }, [active, machineId, storeKey]);

    const getSnapshot = React.useCallback((): LocalServicePublicPreviewState => (
        active && machineId
            ? getLocalServicePublicPreviewState(storeKey)
            : EMPTY_LOCAL_SERVICE_PUBLIC_PREVIEW_STATE
    ), [active, machineId, storeKey]);

    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const applySnapshot = React.useCallback((snapshot: LocalServicePublicPreviewSnapshotV1) => {
        if (!active || !machineId) {
            return;
        }
        publishLocalServicePublicPreviewSnapshot(
            storeKey,
            snapshot,
        );
    }, [active, machineId, storeKey]);

    return React.useMemo(() => ({ state, applySnapshot }), [applySnapshot, state]);
}

export function useLocalServicePublicPreviewState(
    input: UseLocalServicePublicPreviewStateInput,
): LocalServicePublicPreviewState {
    return useLocalServicePublicPreviewStateController(input).state;
}
