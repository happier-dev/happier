import type { DetailsOpenerRegion } from '@/components/ui/panels/paneBreakpoints';
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
    applyCloseDetailsOverlay,
    applyCloseDetailsGroup,
    applyCloseDetailsTab,
    applyFocusDetailsGroup,
    applyMoveDetailsTabToGroup,
    applyOpenDetailsTab,
    applyOpenDetailsOverlay,
    applyPinDetailsTab,
    applyReplaceDetailsTab,
    applySetActiveDetailsTab,
    applySetDetailsTabState,
    applySetDetailsSplitRatio,
    applySetMaximizedDetailsGroup,
    applySplitDetailsGroup,
    applyUnpinDetailsTab,
    arePaneDetailsStatesEqual,
    createEmptyPaneDetailsState,
} from '@/components/appShell/panes/details/workspace/detailsWorkspaceReducer';
import type {
    PluginUiDestinationReferenceV1,
    PluginUiInstanceKeyV1,
} from '@happier-dev/protocol/plugins/ui';
import { arePaneStateJsonValuesEqual } from './paneStateStructuralEquality';
import { readSessionTerminalWorkspace, reduceSessionTerminalWorkspace, type SessionTerminalWorkspaceCommand } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { resolveTerminalDetailsInstanceId } from '@/components/terminal/terminalDetailsTabModel';
import {
    areSelectedPaneDestinationsEqual,
    createBuiltinPaneDestination,
    type SelectedPaneDestinationV1,
} from './selectedPaneDestination';

export type { DetailsTab, DetailsTabOpenMode, DetailsTabState, PaneDetailsState };
export type { SelectedPaneDestinationV1 } from './selectedPaneDestination';

export type PaneId = 'right' | 'details' | 'bottom';

export type PaneScopeState = Readonly<{
    right: {
        isOpen: boolean;
        activeTabId: string | null;
        selectedDestination: SelectedPaneDestinationV1 | null;
        tabState: Readonly<Record<string, unknown>>;
    };
    details: PaneDetailsState;
    bottom: {
        isOpen: boolean;
        activeTabId: string | null;
        selectedDestination: SelectedPaneDestinationV1 | null;
        tabState: Readonly<Record<string, unknown>>;
    };
}>;

export type AppPaneFocusModeState = Readonly<{
    scopeId: string | null;
}>;

/** Used only when activation creates a scope; retained state always wins. */
export type InitialRightPaneState = Readonly<Pick<PaneScopeState['right'], 'isOpen' | 'activeTabId'>>;

export type AppPaneState = Readonly<{
    activeScopeId: string | null;
    scopes: Readonly<Record<string, PaneScopeState>>;
    scopeLru: ReadonlyArray<string>;
    focusMode: AppPaneFocusModeState;
    limits: {
        maxScopesInMemory: number;
    };
}>;

export type AppPaneAction =
    | { type: 'mergePersistedScopes'; scopes: Readonly<Record<string, PaneScopeState>> }
    | { type: 'activateScope'; scopeId: string; initialRight?: InitialRightPaneState }
    /** The page that owned the active scope left the screen: no page's panes are active until one is. */
    | { type: 'releaseScope'; scopeId: string }
    | { type: 'enterFocusMode'; scopeId: string }
    | { type: 'exitFocusMode'; scopeId?: string }
    | { type: 'openRight'; scopeId: string; tabId?: string }
    | { type: 'closeRight'; scopeId: string }
    | { type: 'setRightTab'; scopeId: string; tabId: string }
    | { type: 'selectRightDestination'; scopeId: string; destination: SelectedPaneDestinationV1 }
    | { type: 'setRightTabState'; scopeId: string; tabId: string; nextState: unknown }
    | { type: 'openBottom'; scopeId: string; tabId?: string }
    | { type: 'closeBottom'; scopeId: string }
    | { type: 'setBottomTab'; scopeId: string; tabId: string }
    | { type: 'selectBottomDestination'; scopeId: string; destination: SelectedPaneDestinationV1 }
    | { type: 'setBottomTabState'; scopeId: string; tabId: string; nextState: unknown }
    | { type: 'terminalWorkspace'; scopeId: string; command: SessionTerminalWorkspaceCommand }
    | {
        type: 'openDetailsTab';
        scopeId: string;
        tab: DetailsTab;
        openAs: DetailsTabOpenMode;
        /** The region the open came from; Details opening its own tabs keeps the recorded opener. */
        origin?: DetailsOpenerRegion | 'details' | null;
    }
    | Readonly<{
        type: 'replaceDetailsTab';
        scopeId: string;
        tabKey: string;
        tab: DetailsTab;
        openAs?: DetailsTabOpenMode;
        restoreSourceOnRehydrate?: boolean;
    }>
    | { type: 'setDetailsTabState'; scopeId: string; tabKey: string; nextState: unknown }
    | { type: 'pinDetailsTab'; scopeId: string; tabKey: string }
    | { type: 'unpinDetailsTab'; scopeId: string; tabKey: string }
    | { type: 'closeDetails'; scopeId: string }
    | Readonly<{
        type: 'openDetailsOverlay';
        scopeId: string;
        destination: PluginUiDestinationReferenceV1;
        instanceKey?: PluginUiInstanceKeyV1;
    }>
    | { type: 'closeDetailsOverlay'; scopeId: string }
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
        focusMode: { scopeId: null },
        limits: { maxScopesInMemory: options.maxScopesInMemory },
    });
}

function createEmptyScopeState(initialRight?: InitialRightPaneState): PaneScopeState {
    const activeTabId = initialRight?.activeTabId ?? null;
    return {
        right: {
            isOpen: initialRight?.isOpen ?? false,
            activeTabId,
            selectedDestination: activeTabId === null ? null : createBuiltinPaneDestination(activeTabId),
            tabState: {},
        },
        details: createEmptyPaneDetailsState(),
        bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
    };
}

function isEmptyScopeState(scope: PaneScopeState): boolean {
    return (
        scope.right.isOpen === false
        && scope.right.activeTabId == null
        && scope.right.selectedDestination == null
        && Object.keys(scope.right.tabState).length === 0
        && scope.details.isOpen === false
        && Object.keys(scope.details.tabsByKey).length === 0
        && Object.keys(scope.details.tabState).length === 0
        && scope.bottom.isOpen === false
        && scope.bottom.activeTabId == null
        && scope.bottom.selectedDestination == null
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
        if (!arePaneStateJsonValuesEqual(left[key], right[key])) return false;
    }
    return true;
}

function getOwnPaneTabStateEntry(
    record: Readonly<Record<string, unknown>>,
    tabId: string,
): unknown {
    return Object.prototype.hasOwnProperty.call(record, tabId) ? record[tabId] : undefined;
}

function arePaneScopeStatesEqual(left: PaneScopeState, right: PaneScopeState): boolean {
    return (
        left.right.isOpen === right.right.isOpen
        && left.right.activeTabId === right.right.activeTabId
        && areSelectedPaneDestinationsEqual(left.right.selectedDestination, right.right.selectedDestination)
        && areTabStateRecordsEqual(left.right.tabState, right.right.tabState)
        && arePaneDetailsStatesEqual(left.details, right.details)
        && left.bottom.isOpen === right.bottom.isOpen
        && left.bottom.activeTabId === right.bottom.activeTabId
        && areSelectedPaneDestinationsEqual(left.bottom.selectedDestination, right.bottom.selectedDestination)
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
    const nextFocusMode = state.focusMode.scopeId && keep.has(state.focusMode.scopeId)
        ? state.focusMode
        : { scopeId: null };
    return { ...state, scopes: nextScopes, scopeLru: nextLru, activeScopeId: nextActive, focusMode: nextFocusMode };
}

function upsertScope(state: AppPaneState, scopeId: string, mutate: (prev: PaneScopeState) => PaneScopeState): AppPaneState {
    const prev = state.scopes[scopeId] ?? createEmptyScopeState();
    const nextScope = mutate(prev);
    if (nextScope === prev) return state;
    const nextScopes = { ...state.scopes, [scopeId]: nextScope };
    return { ...state, scopes: nextScopes };
}

function updateScopeDetails(
    state: AppPaneState,
    scopeId: string,
    mutate: (prev: PaneDetailsState) => PaneDetailsState,
): AppPaneState {
    return upsertScope(state, scopeId, (prev) => {
        const nextDetails = mutate(prev.details);
        if (nextDetails === prev.details) return prev;
        return {
            ...prev,
            details: nextDetails,
        };
    });
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
                focusMode: state.focusMode.scopeId === action.scopeId ? state.focusMode : { scopeId: null },
                scopes: state.scopes[action.scopeId] ? state.scopes : { ...state.scopes, [action.scopeId]: createEmptyScopeState(action.initialRight) },
            };
            return evictScopesIfNeeded(next);
        }
        case 'releaseScope': {
            if (state.activeScopeId !== action.scopeId) return state;
            return {
                ...state,
                activeScopeId: null,
                focusMode: state.focusMode.scopeId === action.scopeId ? { scopeId: null } : state.focusMode,
            };
        }
        case 'enterFocusMode': {
            if (state.activeScopeId !== action.scopeId) return state;
            if (!scopeHasFocusablePane(state.scopes[action.scopeId])) return state;
            if (state.focusMode.scopeId === action.scopeId) return state;
            return { ...state, focusMode: { scopeId: action.scopeId } };
        }
        case 'exitFocusMode': {
            if (state.focusMode.scopeId == null) return state;
            if (action.scopeId && action.scopeId !== state.focusMode.scopeId) return state;
            return { ...state, focusMode: { scopeId: null } };
        }
        case 'openRight': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            const nextTabId = action.tabId ?? prev.right.activeTabId;
            const nextDestination = action.tabId === undefined
                ? prev.right.selectedDestination
                : createBuiltinPaneDestination(action.tabId);
            if (
                prev.right.isOpen === true
                && prev.right.activeTabId === nextTabId
                && areSelectedPaneDestinationsEqual(prev.right.selectedDestination, nextDestination)
            ) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                right: {
                    ...prev.right,
                    isOpen: true,
                    activeTabId: nextTabId,
                    selectedDestination: nextDestination,
                },
            }));
        }
        case 'closeRight': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            if (prev.right.isOpen === false) {
                return state;
            }
            return clearFocusModeIfScopeCannotFocus(upsertScope(state, action.scopeId, () => ({
                ...prev,
                right: { ...prev.right, isOpen: false },
            })), action.scopeId);
        }
        case 'setRightTab': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            const nextDestination = createBuiltinPaneDestination(action.tabId);
            if (
                prev.right.activeTabId === action.tabId
                && areSelectedPaneDestinationsEqual(prev.right.selectedDestination, nextDestination)
            ) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                right: {
                    ...prev.right,
                    activeTabId: action.tabId,
                    selectedDestination: nextDestination,
                },
            }));
        }
        case 'selectRightDestination': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            const nextActiveTabId = action.destination.kind === 'builtin'
                ? action.destination.id
                : prev.right.activeTabId;
            if (
                prev.right.isOpen === true
                && prev.right.activeTabId === nextActiveTabId
                && areSelectedPaneDestinationsEqual(prev.right.selectedDestination, action.destination)
            ) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                right: {
                    ...prev.right,
                    isOpen: true,
                    activeTabId: nextActiveTabId,
                    selectedDestination: action.destination,
                },
            }));
        }
        case 'setRightTabState': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            if (arePaneStateJsonValuesEqual(getOwnPaneTabStateEntry(prev.right.tabState, action.tabId), action.nextState)) {
                return state;
            }
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
            const nextDestination = action.tabId === undefined
                ? prev.bottom.selectedDestination
                : createBuiltinPaneDestination(action.tabId);
            if (
                prev.bottom.isOpen === true
                && prev.bottom.activeTabId === nextTabId
                && areSelectedPaneDestinationsEqual(prev.bottom.selectedDestination, nextDestination)
            ) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                bottom: {
                    ...prev.bottom,
                    isOpen: true,
                    activeTabId: nextTabId,
                    selectedDestination: nextDestination,
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
            const nextDestination = createBuiltinPaneDestination(action.tabId);
            if (
                prev.bottom.activeTabId === action.tabId
                && areSelectedPaneDestinationsEqual(prev.bottom.selectedDestination, nextDestination)
            ) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                bottom: {
                    ...prev.bottom,
                    activeTabId: action.tabId,
                    selectedDestination: nextDestination,
                },
            }));
        }
        case 'selectBottomDestination': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            const nextActiveTabId = action.destination.kind === 'builtin'
                ? action.destination.id
                : prev.bottom.activeTabId;
            if (
                prev.bottom.isOpen === true
                && prev.bottom.activeTabId === nextActiveTabId
                && areSelectedPaneDestinationsEqual(prev.bottom.selectedDestination, action.destination)
            ) {
                return state;
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                bottom: {
                    ...prev.bottom,
                    isOpen: true,
                    activeTabId: nextActiveTabId,
                    selectedDestination: action.destination,
                },
            }));
        }
        case 'terminalWorkspace': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            const workspace = readSessionTerminalWorkspace(getOwnPaneTabStateEntry(prev.bottom.tabState, 'terminal'));
            const next = reduceSessionTerminalWorkspace(workspace, action.command);
            const command = action.command;
            const reveal = command.type === 'focus'
                ? workspace.tabs.some((tab) => tab.terminals.some((terminal) => terminal.id === command.terminalId))
                : next !== workspace && (command.type === 'open' || command.type === 'split' || command.type === 'detach');
            const terminalDestination = createBuiltinPaneDestination('terminal');
            if (next === workspace && (!reveal || (prev.bottom.isOpen && areSelectedPaneDestinationsEqual(prev.bottom.selectedDestination, terminalDestination)))) return state;
            const terminalSelected = prev.bottom.selectedDestination?.kind === 'builtin'
                ? prev.bottom.selectedDestination.id === 'terminal'
                : prev.bottom.selectedDestination == null && prev.bottom.activeTabId === 'terminal';
            const retainedIds = new Set(next.tabs.flatMap((tab) => tab.terminals.map((terminal) => terminal.id)));
            const removedIds = new Set(workspace.tabs.flatMap((tab) => tab.terminals.map((terminal) => terminal.id)).filter((id) => !retainedIds.has(id)));
            let details = prev.details;
            if (removedIds.size) for (const tab of Object.values(details.tabsByKey)) {
                const instanceId = resolveTerminalDetailsInstanceId({ resource: tab.resource, tabKey: tab.key });
                if (instanceId && removedIds.has(instanceId)) details = applyCloseDetailsTab(details, tab.key);
            }
            return upsertScope(state, action.scopeId, () => ({
                ...prev,
                details,
                bottom: {
                    ...prev.bottom,
                    isOpen: next.tabs.length === 0 && terminalSelected ? false : reveal ? true : prev.bottom.isOpen,
                    activeTabId: reveal ? 'terminal' : prev.bottom.activeTabId,
                    selectedDestination: reveal ? terminalDestination : prev.bottom.selectedDestination,
                    tabState: { ...prev.bottom.tabState, terminal: next },
                },
            }));
        }
        case 'setBottomTabState': {
            const prev = state.scopes[action.scopeId] ?? createEmptyScopeState();
            if (arePaneStateJsonValuesEqual(getOwnPaneTabStateEntry(prev.bottom.tabState, action.tabId), action.nextState)) {
                return state;
            }
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
            return updateScopeDetails(state, action.scopeId, (details) => {
                const opened = applyOpenDetailsTab(details, { tab: action.tab, openAs: action.openAs });
                const origin = action.origin === 'main' || action.origin === 'side' ? action.origin : null;
                if (!origin || opened.openedFrom === origin) return opened;
                return { ...opened, openedFrom: origin };
            });
        case 'replaceDetailsTab':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applyReplaceDetailsTab(details, {
                    tabKey: action.tabKey,
                    tab: action.tab,
                    openAs: action.openAs,
                    restoreSourceOnRehydrate: action.restoreSourceOnRehydrate,
                })
            ));
        case 'setDetailsTabState':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applySetDetailsTabState(details, action.tabKey, action.nextState)
            ));
        case 'pinDetailsTab':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applyPinDetailsTab(details, action.tabKey)
            ));
        case 'unpinDetailsTab':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applyUnpinDetailsTab(details, action.tabKey)
            ));
        case 'closeDetails':
            return clearFocusModeIfScopeCannotFocus(updateScopeDetails(state, action.scopeId, applyCloseDetails), action.scopeId);
        case 'openDetailsOverlay':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applyOpenDetailsOverlay(details, {
                    destination: action.destination,
                    ...(action.instanceKey === undefined ? {} : { instanceKey: action.instanceKey }),
                })
            ));
        case 'closeDetailsOverlay':
            return clearFocusModeIfScopeCannotFocus(updateScopeDetails(
                state,
                action.scopeId,
                applyCloseDetailsOverlay,
            ), action.scopeId);
        case 'closeDetailsTab':
            return clearFocusModeIfScopeCannotFocus(updateScopeDetails(state, action.scopeId, (details) => (
                applyCloseDetailsTab(details, action.tabKey)
            )), action.scopeId);
        case 'setActiveDetailsTab':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applySetActiveDetailsTab(details, action.tabKey)
            ));
        case 'splitDetailsGroup':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applySplitDetailsGroup(details, {
                    axis: action.axis,
                    groupId: action.groupId,
                    placement: action.placement,
                })
            ));
        case 'setDetailsSplitRatio':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applySetDetailsSplitRatio(details, action.splitId, action.ratio)
            ));
        case 'moveDetailsTabToGroup':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applyMoveDetailsTabToGroup(details, { tabKey: action.tabKey, targetGroupId: action.targetGroupId })
            ));
        case 'focusDetailsGroup':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applyFocusDetailsGroup(details, action.groupId)
            ));
        case 'setMaximizedDetailsGroup':
            return updateScopeDetails(state, action.scopeId, (details) => (
                applySetMaximizedDetailsGroup(details, action.groupId)
            ));
        case 'closeDetailsGroup':
            return clearFocusModeIfScopeCannotFocus(updateScopeDetails(state, action.scopeId, (details) => (
                applyCloseDetailsGroup(details, action.groupId)
            )), action.scopeId);
        default:
            return state;
    }
}
