import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import {
    type LocalServicePreviewSnapshotClientInput,
    type LocalServicePreviewSnapshotClientResult,
} from './api';
import {
    EMPTY_LOCAL_SERVICE_PREVIEW_STATE,
    getLocalServicePreviewState,
    invalidateLocalServicePreviewStore,
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
    /** Only a cold-gated retained Browser body may keep preview lease custody while hidden. */
    presentationPolicy?: 'presented' | 'retained';
    nowMs?: () => number;
    snapshotClient?: LocalServicePreviewSnapshotClient;
}>;

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * Read the shared preview-status store for a canonical Home + Account + Machine key.
 *
 * PRV-4: this no longer owns per-mount state or a 15s `setInterval` poll. Every mount subscribes
 * to one keyed entry in {@link ./sharedStore}; the first subscriber triggers a single fetch and
 * the runtime-action executor publishes lifecycle snapshots into the same store, so an open pane
 * refreshes from an action without any wall-clock timer.
 */
export function useLocalServicePreviewState(
    input: UseLocalServicePreviewStateInput,
): LocalServicePreviewState {
    return useLocalServicePreviewStateController(input).state;
}

/** The feed's existing credential owner also qualifies its explicit opens and refreshes. */
export function useLocalServicePreviewStateController(
    input: UseLocalServicePreviewStateInput,
): Readonly<{ state: LocalServicePreviewState; accountLifetime: ServerAccountScopeLifetime | null;
    credentialKey: string | undefined; refresh: (() => void) | undefined }> {
    const presented = useLayoutPresentationActive();
    const enabled = (input.enabled ?? true) && (presented || input.presentationPolicy === 'retained');
    const machineId = normalizeId(input.machineId);
    const requestedServerId = normalizeId(input.serverId);
    const activeServer = useActiveServerSnapshot(!requestedServerId);
    const serverId = resolveServerProfileScopeIdForIdentifier(requestedServerId ?? activeServer.serverId) || null;
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const active = enabled && Boolean(machineId) && binding?.isCurrent() === true;
    const storeKey = React.useMemo(() => machineId ? { machineId, serverId,
        accountId: binding?.accountId ?? null, credentialKey: binding?.credentialKey ?? null } : null,
    [binding, machineId, serverId]);

    // Hold the latest injected client/clock without forcing a resubscribe — only the key
    // (active/machineId/serverId) controls subscription identity.
    const snapshotClientRef = React.useRef(input.snapshotClient);
    const nowMsRef = React.useRef(input.nowMs);
    React.useEffect(() => {
        snapshotClientRef.current = input.snapshotClient;
        nowMsRef.current = input.nowMs;
    }, [input.nowMs, input.snapshotClient]);

    const subscribe = React.useCallback((onStoreChange: () => void): (() => void) => {
        if (!active || !storeKey) {
            return () => {};
        }
        return subscribeLocalServicePreviewStore(
            storeKey,
            onStoreChange,
            {
                ...(snapshotClientRef.current ? { snapshotClient: snapshotClientRef.current } : {}),
                ...(nowMsRef.current ? { nowMs: nowMsRef.current } : {}),
            },
        );
    }, [active, storeKey]);

    const getSnapshot = React.useCallback((): LocalServicePreviewState => (
        active && storeKey
            ? getLocalServicePreviewState(storeKey)
            : EMPTY_LOCAL_SERVICE_PREVIEW_STATE
    ), [active, storeKey]);

    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    // Injected display data disables this subscriber's demand, not an explicit refresh
    // of the canonical live owner. Keep that operation on this exact credential scope.
    const refresh = React.useMemo(() => storeKey && binding?.isCurrent() === true
        ? () => { if (binding.isCurrent()) invalidateLocalServicePreviewStore(storeKey); }
        : undefined, [binding, serverId, storeKey]);
    return React.useMemo(() => ({ state, accountLifetime: binding ?? null, credentialKey: binding?.credentialKey, refresh }),
        [binding, refresh, state]);
}
