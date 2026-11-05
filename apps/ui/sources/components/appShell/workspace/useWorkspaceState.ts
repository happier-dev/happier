import * as React from 'react';
import { useActiveServerAccountScope, useIsDataReady, useLocalSetting } from '@/sync/domains/state/storage';
import type { WorkspaceAction, WorkspaceTab, WorkspaceState } from './workspaceState';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { randomUUID } from '@/platform/randomUUID';
import { workspaceLayoutsState } from '@/sync/domains/state/filePaneUiState';
import { UiStatePersistenceError, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { reconcileWorkspaceSyncedTabs, type SharedWorkspaceTabs } from './workspaceSyncedTabs';
import {
    parseWorkspaceLayout, readScopedWorkspaceLayout, serializeWorkspaceLayout, workspaceLayoutScopeKey,
} from './workspacePersistence';

export function useWorkspaceState(input: Readonly<{
    initialTab: WorkspaceTab;
    windowId?: string;
    /** Native records need a discoverable local layout even before the first explicit intent. */
    persistInitial?: boolean;
    admitState?: (state: WorkspaceState, retainedState?: WorkspaceState) => WorkspaceState;
}>): Readonly<{
    state: WorkspaceState;
    dispatch: (action: WorkspaceAction) => void;
    getState: () => WorkspaceState;
    restoreAction: (action: WorkspaceAction) => void;
    isRestored: boolean;
    isReady: boolean;
    windowId: string | null;
    applySharedRecord: (record: SharedWorkspaceTabs) => void;
}> {
    const scope = useActiveServerAccountScope();
    const isDataReady = useIsDataReady();
    const layouts = useLocalSetting('workspaceLayoutV1');
    const windowId = input.windowId ?? 'main';
    const scopeKey = scope && windowId
        ? workspaceLayoutScopeKey({ serverId: scope.serverId, accountId: scope.accountId, windowId })
        : null;
    const persistedLayout = usePersistentUiStateValue(workspaceLayoutsState, scopeKey);
    // The settings input remains a read-only rescue if the one-way durable copy
    // was refused. A current dedicated layout always takes precedence.
    const readLayout = () => parseWorkspaceLayout(persistedLayout)
        ?? (scopeKey ? readScopedWorkspaceLayout(layouts, scopeKey) : null);
    const canRestore = isDataReady && scopeKey !== null;
    const currentScopeRef = React.useRef(scopeKey);
    currentScopeRef.current = scopeKey;
    const fallbackState = React.useMemo(() => createWorkspaceState(input.initialTab), [input.initialTab]);
    const [storedState, setState] = React.useState<WorkspaceState>(() => {
        const restored = canRestore ? readLayout() ?? fallbackState : fallbackState;
        return input.admitState?.(restored) ?? restored;
    });
    const state = React.useMemo(() => input.admitState?.(storedState) ?? storedState, [input.admitState, storedState]);
    // Admission replaces the canonical state before children commit; it never saves a layout.
    if (state !== storedState) setState(state);
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const readLayoutRef = React.useRef(readLayout);
    readLayoutRef.current = readLayout;
    const restoredScopeRef = React.useRef<string | null>(canRestore ? scopeKey : null);
    // Core readiness admits the first restoration. Once that scope is restored,
    // a pending sync publication must not replace its retained destinations with
    // the initial preview and unmount editors whose handoff handles were consumed.
    // A different or unavailable Account/window still withdraws the old layout.
    const isRestored = scopeKey !== null && restoredScopeRef.current === scopeKey;
    const isReady = canRestore && isRestored;

    React.useEffect(() => {
        if (!canRestore || !scopeKey || restoredScopeRef.current === scopeKey) return;
        restoredScopeRef.current = scopeKey;
        const restored = readLayoutRef.current() ?? createWorkspaceState(input.initialTab);
        const admitted = input.admitState?.(restored) ?? restored;
        stateRef.current = admitted;
        setState(admitted);
    }, [canRestore, input.admitState, input.initialTab, scopeKey]);

    const update = React.useCallback((next: WorkspaceState, retainedState?: WorkspaceState) => {
        if (!isReady || !scopeKey || currentScopeRef.current !== scopeKey) return null;
        next = input.admitState?.(next, retainedState) ?? next;
        if (next === stateRef.current) return null;
        stateRef.current = next;
        setState(next);
        return next;
    }, [input.admitState, isReady, scopeKey]);

    const persist = React.useCallback((next: WorkspaceState) => {
        if (!scopeKey) return;
        try {
            workspaceLayoutsState.set(scopeKey, serializeWorkspaceLayout(next));
        } catch (error) {
            if (!(error instanceof UiStatePersistenceError)) throw error;
            console.warn('[workspace] Layout persistence failed; keeping the current workspace in memory.');
        }
    }, [scopeKey]);

    React.useEffect(() => {
        if (input.persistInitial && isReady && persistedLayout === undefined) persist(stateRef.current);
    }, [input.persistInitial, isReady, persistedLayout, persist]);

    const dispatch = React.useCallback((action: WorkspaceAction) => {
        if (!isReady || currentScopeRef.current !== scopeKey) return;
        const next = update(reduceWorkspaceState(stateRef.current, action));
        if (!next || !scopeKey) return;
        persist(next);
    }, [isReady, update, scopeKey, persist]);
    const restoreAction = React.useCallback((action: WorkspaceAction) => {
        update(reduceWorkspaceState(stateRef.current, action));
    }, [update]);
    const applySharedRecord = React.useCallback((record: SharedWorkspaceTabs) => {
        if (!isReady || currentScopeRef.current !== scopeKey) return;
        const retainedState = stateRef.current;
        update(reconcileWorkspaceSyncedTabs(retainedState, record, randomUUID), retainedState);
    }, [isReady, update, scopeKey]);

    const getState = React.useCallback(() => isRestored ? stateRef.current : fallbackState, [fallbackState, isRestored]);
    return { state: isRestored ? state : fallbackState, dispatch, restoreAction, getState, isRestored, isReady, windowId, applySharedRecord };
}
