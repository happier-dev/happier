export type PaneId = 'right' | 'details' | 'bottom';

export type DetailsTabOpenMode = 'preview' | 'pinned';

export type DetailsTab = Readonly<{
    key: string;
    kind: string;
    title: string;
    subtitle?: string | null;
    resource: unknown;
}>;

export type DetailsTabState = Readonly<DetailsTab & {
    isPreview: boolean;
    isPinned: boolean;
}>;

export type PaneScopeState = Readonly<{
    right: {
        isOpen: boolean;
        activeTabId: string | null;
        tabState: Readonly<Record<string, unknown>>;
    };
    details: {
        isOpen: boolean;
        tabs: ReadonlyArray<DetailsTabState>;
        activeTabKey: string | null;
        tabState: Readonly<Record<string, unknown>>;
    };
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
    focusMode: {
        scopeId: string | null;
    };
    limits: {
        maxScopesInMemory: number;
    };
}>;

export type AppPaneAction =
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
    | { type: 'enterFocusMode'; scopeId: string }
    | { type: 'exitFocusMode'; scopeId?: string };

export function createAppPaneState(options: Readonly<{ maxScopesInMemory: number }>): AppPaneState {
    return {
        activeScopeId: null,
        scopes: {},
        scopeLru: [],
        focusMode: { scopeId: null },
        limits: { maxScopesInMemory: options.maxScopesInMemory },
    };
}

function createEmptyScopeState(): PaneScopeState {
    return {
        right: { isOpen: false, activeTabId: null, tabState: {} },
        details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        bottom: { isOpen: false, activeTabId: null, tabState: {} },
    };
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
    const nextFocusMode = state.focusMode.scopeId && keep.has(state.focusMode.scopeId)
        ? state.focusMode
        : { scopeId: null };
    return { ...state, scopes: nextScopes, scopeLru: nextLru, activeScopeId: nextActive, focusMode: nextFocusMode };
}

function upsertScope(state: AppPaneState, scopeId: string, mutate: (prev: PaneScopeState) => PaneScopeState): AppPaneState {
    const prev = state.scopes[scopeId] ?? createEmptyScopeState();
    const nextScopes = { ...state.scopes, [scopeId]: mutate(prev) };
    return { ...state, scopes: nextScopes };
}

function setDetailsTabs(scope: PaneScopeState, nextTabs: ReadonlyArray<DetailsTabState>, nextActiveKey: string | null): PaneScopeState {
    return {
        ...scope,
        details: {
            ...scope.details,
            tabs: nextTabs,
            activeTabKey: nextActiveKey,
        },
    };
}

function scopeHasFocusablePane(scope: PaneScopeState | undefined): boolean {
    return Boolean(scope?.right.isOpen || scope?.details.isOpen);
}

function clearFocusModeIfScopeCannotFocus(state: AppPaneState, scopeId: string): AppPaneState {
    if (state.focusMode.scopeId !== scopeId) return state;
    if (scopeHasFocusablePane(state.scopes[scopeId])) return state;
    return { ...state, focusMode: { scopeId: null } };
}

export function appPaneReduce(state: AppPaneState, action: AppPaneAction): AppPaneState {
    switch (action.type) {
        case 'activateScope': {
            const next = {
                ...state,
                activeScopeId: action.scopeId,
                scopeLru: touchScopeLru(state.scopeLru, action.scopeId),
                scopes: state.scopes[action.scopeId] ? state.scopes : { ...state.scopes, [action.scopeId]: createEmptyScopeState() },
                focusMode: state.focusMode.scopeId && state.focusMode.scopeId !== action.scopeId
                    ? { scopeId: null }
                    : state.focusMode,
            };
            return evictScopesIfNeeded(next);
        }
        case 'openRight': {
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                right: {
                    ...prev.right,
                    isOpen: true,
                    activeTabId: action.tabId ?? prev.right.activeTabId,
                },
            }));
        }
        case 'closeRight': {
            return clearFocusModeIfScopeCannotFocus(upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                right: { ...prev.right, isOpen: false },
            })), action.scopeId);
        }
        case 'setRightTab': {
            return upsertScope(state, action.scopeId, (prev) => ({
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
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                bottom: {
                    ...prev.bottom,
                    isOpen: true,
                    activeTabId: action.tabId ?? prev.bottom.activeTabId,
                },
            }));
        }
        case 'closeBottom': {
            return upsertScope(state, action.scopeId, (prev) => ({
                ...prev,
                bottom: { ...prev.bottom, isOpen: false },
            }));
        }
        case 'setBottomTab': {
            return upsertScope(state, action.scopeId, (prev) => ({
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
        case 'openDetailsTab': {
            return upsertScope(state, action.scopeId, (prev) => {
                const existingIndex = prev.details.tabs.findIndex((t) => t.key === action.tab.key);
                if (existingIndex >= 0) {
                    const existing = prev.details.tabs[existingIndex]!;
                    const pinned = action.openAs === 'pinned' ? true : existing.isPinned;
                    const preview = pinned ? false : existing.isPreview;
                    const nextTabs = prev.details.tabs.map((t, index) => (index === existingIndex ? { ...t, isPinned: pinned, isPreview: preview } : t));
                    return {
                        ...prev,
                        details: { ...prev.details, isOpen: true, tabs: nextTabs, activeTabKey: action.tab.key },
                    };
                }

                let nextTabs = prev.details.tabs;
                if (action.openAs === 'preview') {
                    nextTabs = nextTabs.filter((t) => !t.isPreview);
                }

                const nextTab: DetailsTabState = {
                    ...action.tab,
                    isPinned: action.openAs === 'pinned',
                    isPreview: action.openAs === 'preview',
                };
                nextTabs = [...nextTabs, nextTab];
                return setDetailsTabs({ ...prev, details: { ...prev.details, isOpen: true } }, nextTabs, nextTab.key);
            });
        }
        case 'setDetailsTabState': {
            return upsertScope(state, action.scopeId, (prev) => {
                const nextState = action.nextState;
                if (nextState == null) {
                    if (!(action.tabKey in prev.details.tabState)) return prev;
                    const { [action.tabKey]: _deleted, ...rest } = prev.details.tabState;
                    return { ...prev, details: { ...prev.details, tabState: rest } };
                }
                return {
                    ...prev,
                    details: {
                        ...prev.details,
                        tabState: {
                            ...prev.details.tabState,
                            [action.tabKey]: nextState,
                        },
                    },
                };
            });
        }
        case 'pinDetailsTab': {
            return upsertScope(state, action.scopeId, (prev) => {
                const index = prev.details.tabs.findIndex((t) => t.key === action.tabKey);
                if (index < 0) return prev;
                const nextTabs = prev.details.tabs.map((t, i) => (i === index ? { ...t, isPinned: true, isPreview: false } : t));
                return { ...prev, details: { ...prev.details, tabs: nextTabs } };
            });
        }
        case 'unpinDetailsTab': {
            return upsertScope(state, action.scopeId, (prev) => {
                const index = prev.details.tabs.findIndex((t) => t.key === action.tabKey);
                if (index < 0) return prev;

                // Revert the tab into the preview slot (unpinned + preview) and preserve the
                // invariant that only one preview tab exists at a time.
                const nextTabsWithTarget = prev.details.tabs.map((t, i) => (i === index
                    ? { ...t, isPinned: false, isPreview: true }
                    : t));

                const removedPreviewKeys = new Set<string>();
                for (const tab of nextTabsWithTarget) {
                    if (tab.key === action.tabKey) continue;
                    if (tab.isPinned) continue;
                    if (!tab.isPreview) continue;
                    removedPreviewKeys.add(tab.key);
                }

                let nextTabs = nextTabsWithTarget;
                let nextTabState = prev.details.tabState;
                if (removedPreviewKeys.size > 0) {
                    nextTabs = nextTabsWithTarget.filter((t) => !removedPreviewKeys.has(t.key));
                    const mutableState = { ...prev.details.tabState } as Record<string, unknown>;
                    for (const key of removedPreviewKeys) {
                        delete mutableState[key];
                    }
                    nextTabState = mutableState;
                }

                const nextActive = action.tabKey;
                return setDetailsTabs(
                    { ...prev, details: { ...prev.details, tabState: nextTabState } },
                    nextTabs,
                    nextActive,
                );
            });
        }
        case 'closeDetails': {
            return clearFocusModeIfScopeCannotFocus(
                upsertScope(state, action.scopeId, (prev) => ({ ...prev, details: { ...prev.details, isOpen: false } })),
                action.scopeId,
            );
        }
        case 'closeDetailsTab': {
            return clearFocusModeIfScopeCannotFocus(upsertScope(state, action.scopeId, (prev) => {
                const index = prev.details.tabs.findIndex((t) => t.key === action.tabKey);
                if (index < 0) return prev;
                const nextTabs = prev.details.tabs.filter((t) => t.key !== action.tabKey);
                const { [action.tabKey]: _deletedTabState, ...remainingTabState } = prev.details.tabState;
                const nextActive =
                    prev.details.activeTabKey === action.tabKey
                        ? (nextTabs[index - 1]?.key ?? nextTabs[index]?.key ?? nextTabs.at(-1)?.key ?? null)
                        : prev.details.activeTabKey;
                const isOpen = nextTabs.length > 0 ? prev.details.isOpen : false;
                return setDetailsTabs(
                    { ...prev, details: { ...prev.details, isOpen, tabState: remainingTabState } },
                    nextTabs,
                    nextActive
                );
            }), action.scopeId);
        }
        case 'setActiveDetailsTab': {
            return upsertScope(state, action.scopeId, (prev) => {
                if (!prev.details.tabs.some((t) => t.key === action.tabKey)) return prev;
                return { ...prev, details: { ...prev.details, activeTabKey: action.tabKey } };
            });
        }
        case 'enterFocusMode': {
            if (state.activeScopeId !== action.scopeId) return state;
            if (!scopeHasFocusablePane(state.scopes[action.scopeId])) return state;
            return { ...state, focusMode: { scopeId: action.scopeId } };
        }
        case 'exitFocusMode': {
            if (!state.focusMode.scopeId) return state;
            if (action.scopeId && action.scopeId !== state.focusMode.scopeId) return state;
            return { ...state, focusMode: { scopeId: null } };
        }
        default:
            return state;
    }
}
