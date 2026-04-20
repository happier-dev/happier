import type {
    DetailsTab,
    DetailsTabOpenMode,
    DetailsTabState,
    DetailsWorkspaceAxis,
    DetailsWorkspacePlacement,
    PaneDetailsState,
} from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import {
    applyCloseDetails,
    applyCloseDetailsGroup,
    applyCloseDetailsTab,
    applyFocusDetailsGroup,
    applyMoveDetailsTabToGroup,
    applyOpenDetailsTab,
    applyPinDetailsTab,
    applySetActiveDetailsTab,
    applySetDetailsTabState,
    applySetDetailsSplitRatio,
    applySetMaximizedDetailsGroup,
    applySplitDetailsGroup,
    applyUnpinDetailsTab,
    arePaneDetailsStatesEqual,
    createEmptyPaneDetailsState,
} from '@/components/appShell/panes/details/workspace/detailsWorkspaceReducer';

export type { DetailsTab, DetailsTabOpenMode, DetailsTabState, PaneDetailsState };

export type PaneId = 'right' | 'details' | 'bottom';

export type PaneScopeState = Readonly<{
    right: {
        isOpen: boolean;
        activeTabId: string | null;
        tabState: Readonly<Record<string, unknown>>;
    };
    details: PaneDetailsState;
    bottom: {
        isOpen: boolean;
        activeTabId: string | null;
        tabState: Readonly<Record<string, unknown>>;
    };
}>;

export type AppPaneState = Readonly<{
    activeScopeId: string | null;
    scopes: Readonly<Record<string, PaneScopeState>>;
    scopeLru: ReadonlyArray<string>;
    limits: {
        maxScopesInMemory: number;
    };
}>;

export type AppPaneAction =
    | { type: 'mergePersistedScopes'; scopes: Readonly<Record<string, PaneScopeState>> }
    | { type: 'activateScope'; scopeId: string }
    | { type: 'openRight'; scopeId: string; tabId?: string }
    | { type: 'closeRight'; scopeId: string }
    | { type: 'setRightTab'; scopeId: string; tabId: string }
    | { type: 'setRightTabState'; scopeId: string; tabId: string; nextState: unknown }
    | { type: 'openBottom'; scopeId: string; tabId?: string }
    | { type: 'closeBottom'; scopeId: string }
    | { type: 'setBottomTab'; scopeId: string; tabId: string }
    | { type: 'setBottomTabState'; scopeId: string; tabId: string; nextState: unknown }
    | { type: 'openDetailsTab'; scopeId: string; tab: DetailsTab; openAs: DetailsTabOpenMode }
    | { type: 'setDetailsTabState'; scopeId: string; tabKey: string; nextState: unknown }
    | { type: 'pinDetailsTab'; scopeId: string; tabKey: string }
    | { type: 'unpinDetailsTab'; scopeId: string; tabKey: string }
    | { type: 'closeDetails'; scopeId: string }
    | { type: 'closeDetailsTab'; scopeId: string; tabKey: string }
    | { type: 'setActiveDetailsTab'; scopeId: string; tabKey: string }
    | {
        type: 'splitDetailsGroup';
        scopeId: string;
        axis: DetailsWorkspaceAxis;
        groupId?: string;
        placement?: DetailsWorkspacePlacement;
    }
    | { type: 'setDetailsSplitRatio'; scopeId: string; splitId: string; ratio: number }
    | { type: 'moveDetailsTabToGroup'; scopeId: string; tabKey: string; targetGroupId: string }
    | { type: 'focusDetailsGroup'; scopeId: string; groupId: string }
    | { type: 'setMaximizedDetailsGroup'; scopeId: string; groupId: string | null }
    | { type: 'closeDetailsGroup'; scopeId: string; groupId: string };

export function createAppPaneState(options: Readonly<{
    maxScopesInMemory: number;
    persistedScopes?: Readonly<Record<string, PaneScopeState>> | null;
}>): AppPaneState {
    const persistedScopes = options.persistedScopes ?? {};
    return evictScopesIfNeeded({
        activeScopeId: null,
        scopes: persistedScopes,
        scopeLru: Object.keys(persistedScopes),
        limits: { maxScopesInMemory: options.maxScopesInMemory },
    });
}

function createEmptyScopeState(): PaneScopeState {
    return {
        right: { isOpen: false, activeTabId: null, tabState: {} },
        details: createEmptyPaneDetailsState(),
        bottom: { isOpen: false, activeTabId: null, tabState: {} },
    };
}

function isEmptyScopeState(scope: PaneScopeState): boolean {
    return (
        scope.right.isOpen === false
        && scope.right.activeTabId == null
        && Object.keys(scope.right.tabState).length === 0
        && scope.details.isOpen === false
        && Object.keys(scope.details.tabsByKey).length === 0
        && Object.keys(scope.details.tabState).length === 0
        && scope.bottom.isOpen === false
        && scope.bottom.activeTabId == null
        && Object.keys(scope.bottom.tabState).length === 0
    );
}

function areTabStateRecordsEqual(
    left: Readonly<Record<string, unknown>>,
    right: Readonly<Record<string, unknown>>,
): boolean {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
        if (!Object.is(left[key], right[key])) return false;
    }
    return true;
}

function arePaneScopeStatesEqual(left: PaneScopeState, right: PaneScopeState): boolean {
    return (
        left.right.isOpen === right.right.isOpen
        && left.right.activeTabId === right.right.activeTabId
        && areTabStateRecordsEqual(left.right.tabState, right.right.tabState)
        && arePaneDetailsStatesEqual(left.details, right.details)
        && left.bottom.isOpen === right.bottom.isOpen
        && left.bottom.activeTabId === right.bottom.activeTabId
        && areTabStateRecordsEqual(left.bottom.tabState, right.bottom.tabState)
    );
}

function touchScopeLru(scopeLru: ReadonlyArray<string>, scopeId: string): ReadonlyArray<string> {
    const next = scopeLru.filter((id) => id !== scopeId);
    return [scopeId, ...next];
}

function evictScopesIfNeeded(state: AppPaneState): AppPaneState {
    const max = state.limits.maxScopesInMemory;
    if (Object.keys(state.scopes).length <= max) return state;

    const keep = new Set(state.scopeLru.slice(0, max));
    const nextScopes: Record<string, PaneScopeState> = {};
    for (const [scopeId, scopeState] of Object.entries(state.scopes)) {
        if (keep.has(scopeId)) nextScopes[scopeId] = scopeState;
    }
    const nextLru = state.scopeLru.filter((id) => keep.has(id));
    const nextActive = state.activeScopeId && keep.has(state.activeScopeId) ? state.activeScopeId : nextLru[0] ?? null;
    return { ...state, scopes: nextScopes, scopeLru: nextLru, activeScopeId: nextActive };
}

function upsertScope(state: AppPaneState, scopeId: string, mutate: (prev: PaneScopeState) => PaneScopeState): AppPaneState {
    const prev = state.scopes[scopeId] ?? createEmptyScopeState();
    const nextScopes = { ...state.scopes, [scopeId]: mutate(prev) };
    return { ...state, scopes: nextScopes };
}

export function appPaneReduce(state: AppPaneState, action: AppPaneAction): AppPaneState {
    switch (action.type) {
        case 'mergePersistedScopes': {
            const incomingScopes = action.scopes;
            if (Object.keys(incomingScopes).length === 0) return state;

            let changed = false;
            const nextScopes: Record<string, PaneScopeState> = { ...state.scopes };
            const nextLru = [...state.scopeLru];

            for (const [scopeId, persistedScope] of Object.entries(incomingScopes)) {
                const existingScope = state.scopes[scopeId];
                if (existingScope && !isEmptyScopeState(existingScope)) continue;
                if (existingScope && arePaneScopeStatesEqual(existingScope, persistedScope)) continue;
                nextScopes[scopeId] = persistedScope;
                if (!nextLru.includes(scopeId)) {
                    nextLru.push(scopeId);
                }
                changed = true;
            }

            if (!changed) return state;
            return evictScopesIfNeeded({
                ...state,
                scopes: nextScopes,
                scopeLru: nextLru,
            });
        }
        case 'activateScope': {
            const next = {
                ...state,
                activeScopeId: action.scopeId,
                scopeLru: touchScopeLru(state.scopeLru, action.scopeId),
                scopes: state.scopes[action.scopeId] ? state.scopes : { ...state.scopes, [action.scopeId]: createEmptyScopeState() },
            };
            return evictScopesIfNeeded(next);
        }
        case 'openRight': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            const nextTabId = action.tabId ?? prev.right.activeTabId;
            if (prev.right.isOpen === true && prev.right.activeTabId === nextTabId) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                right: {
                    ...prev.right,
                    isOpen: true,
                    activeTabId: nextTabId,
                },
            }));
        }
        case 'closeRight': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            if (prev.right.isOpen === false) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                right: { ...prev.right, isOpen: false },
            }));
        }
        case 'setRightTab': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            if (prev.right.activeTabId === action.tabId) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                right: { ...prev.right, activeTabId: action.tabId },
            }));
        }
        case 'setRightTabState': {
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                right: {
                    ...prev.right,
                    tabState: {
                        ...prev.right.tabState,
                        [action.tabId]: action.nextState,
                    },
                },
            }));
        }
        case 'openBottom': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            const nextTabId = action.tabId ?? prev.bottom.activeTabId;
            if (prev.bottom.isOpen === true && prev.bottom.activeTabId === nextTabId) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                bottom: {
                    ...prev.bottom,
                    isOpen: true,
                    activeTabId: nextTabId,
                },
            }));
        }
        case 'closeBottom': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            if (prev.bottom.isOpen === false) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                bottom: { ...prev.bottom, isOpen: false },
            }));
        }
        case 'setBottomTab': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            if (prev.bottom.activeTabId === action.tabId) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                bottom: { ...prev.bottom, activeTabId: action.tabId },
            }));
        }
        case 'setBottomTabState': {
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                bottom: {
                    ...prev.bottom,
                    tabState: {
                        ...prev.bottom.tabState,
                        [action.tabId]: action.nextState,
                    },
                },
            }));
        }
        case 'openDetailsTab':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applyOpenDetailsTab(prev.details, { tab: action.tab, openAs: action.openAs }),
            }));
        case 'setDetailsTabState':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applySetDetailsTabState(prev.details, action.tabKey, action.nextState),
            }));
        case 'pinDetailsTab':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applyPinDetailsTab(prev.details, action.tabKey),
            }));
        case 'unpinDetailsTab':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applyUnpinDetailsTab(prev.details, action.tabKey),
            }));
        case 'closeDetails':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applyCloseDetails(prev.details),
            }));
        case 'closeDetailsTab':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applyCloseDetailsTab(prev.details, action.tabKey),
            }));
        case 'setActiveDetailsTab':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applySetActiveDetailsTab(prev.details, action.tabKey),
            }));
        case 'splitDetailsGroup':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applySplitDetailsGroup(prev.details, {
                    axis: action.axis,
                    groupId: action.groupId,
                    placement: action.placement,
                }),
            }));
        case 'setDetailsSplitRatio':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applySetDetailsSplitRatio(prev.details, action.splitId, action.ratio),
            }));
        case 'moveDetailsTabToGroup':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applyMoveDetailsTabToGroup(prev.details, { tabKey: action.tabKey, targetGroupId: action.targetGroupId }),
            }));
        case 'focusDetailsGroup':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applyFocusDetailsGroup(prev.details, action.groupId),
            }));
        case 'setMaximizedDetailsGroup':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applySetMaximizedDetailsGroup(prev.details, action.groupId),
            }));
        case 'closeDetailsGroup':
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                details: applyCloseDetailsGroup(prev.details, action.groupId),
            }));
        default:
            return state;
    }
}
