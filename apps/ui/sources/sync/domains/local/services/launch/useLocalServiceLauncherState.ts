import * as React from 'react';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveMachineDaemonReadServerId } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';

import type {
    LocalServiceLauncherSnapshotClientInput,
    LocalServiceLauncherSnapshotClientResult,
} from './api';
import {
    EMPTY_LOCAL_SERVICE_LAUNCHER_STATE,
    getLocalServiceLauncherState,
    invalidateLocalServiceLauncherStore,
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
    /**
     * Re-read the daemon's launcher feed.
     *
     * The feed is derived from the inventory the daemon just rescanned, so it has no push producer
     * of its own: the shared launcher store follows the inventory watch. Undefined
     * when there is no machine to read.
     */
    refresh: (() => void) | undefined;
}>;

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

export function useLocalServiceLauncherStateController(
    input: UseLocalServiceLauncherStateInput,
): LocalServiceLauncherStateController {
    const presented = useLayoutPresentationActive();
    const eligible = input.enabled ?? true;
    const enabled = eligible && presented;
    const machineId = normalizeId(input.machineId);
    const serverId = resolveMachineDaemonReadServerId(input.serverId);
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const sessionId = normalizeId(input.sessionId);
    const scope = input.scope ?? null;
    const sessionWorkspace = useWorkspaceScopeForSession(sessionId, serverId);
    const workspaceRoot = normalizeId(input.workspaceRoot ?? sessionWorkspace?.rootPath);
    const snapshotClient = input.snapshotClient;
    const nowMs = input.nowMs ?? Date.now;
    const snapshotClientRef = React.useRef(snapshotClient);
    const nowMsRef = React.useRef(nowMs);
    const storeKey = React.useMemo<LocalServiceLauncherStoreKeyInput | null>(() => (
        eligible && machineId && binding?.isCurrent() && binding.credentialKey
            ? { machineId, serverId, sessionId, scope, workspaceRoot, accountId: binding.accountId, credentialKey: binding.credentialKey } : null
    ), [binding, eligible, machineId, scope, serverId, sessionId, workspaceRoot]);
    const applySnapshot = React.useCallback((snapshot: LocalServiceLauncherSnapshot) => {
        if (!storeKey || !binding?.isCurrent() || snapshot.machineId !== storeKey.machineId) {
            return;
        }
        if (storeKey.sessionId && snapshot.sessionId !== storeKey.sessionId) {
            return;
        }
        publishLocalServiceLauncherSnapshot(storeKey, snapshot);
    }, [binding, storeKey]);

    React.useEffect(() => {
        snapshotClientRef.current = snapshotClient;
        nowMsRef.current = nowMs;
    }, [nowMs, snapshotClient]);

    const subscribe = React.useCallback((listener: () => void) => {
        if (!enabled || !storeKey || !binding?.isCurrent()) return () => {};
        const release = subscribeLocalServiceLauncherStore(storeKey, listener, {
                ...(snapshotClientRef.current ? { snapshotClient: (request) => snapshotClientRef.current!(request) } : {}),
                nowMs: () => nowMsRef.current(),
        });
        const retirement = binding.onRetire(() => { release(); listener(); });
        return () => { retirement.dispose(); release(); };
    }, [binding, enabled, storeKey]);

    const getSnapshot = React.useCallback(() => (
        storeKey && binding?.isCurrent() ? getLocalServiceLauncherState(storeKey) : EMPTY_LOCAL_SERVICE_LAUNCHER_STATE
    ), [binding, storeKey]);

    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const refresh = React.useMemo(() => (
        enabled && storeKey && binding?.isCurrent()
            ? () => { if (binding.isCurrent()) invalidateLocalServiceLauncherStore(storeKey); } : undefined
    ), [binding, enabled, storeKey]);

    return React.useMemo(() => ({
        state,
        applySnapshot,
        refresh,
    }), [applySnapshot, refresh, state]);
}

export function useLocalServiceLauncherState(
    input: UseLocalServiceLauncherStateInput,
): LocalServiceLauncherState {
    return useLocalServiceLauncherStateController(input).state;
}
