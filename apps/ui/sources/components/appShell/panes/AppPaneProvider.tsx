import * as React from 'react';
import { createContext, useContext, useMemo, useRef, useState } from 'react';
import { useActiveServerAccountScope, useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { PaneDriver, PaneScopeId } from './types';
import { registerSessionTerminalWorkspaceOwner, notifySessionTerminalWorkspaceChanged, retireProjectTerminalPresentationForHome } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { EMPTY_TERMINAL_WORKSPACE, readSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { appPaneReduce, createAppPaneState, type AppPaneAction, type AppPaneState, type PaneScopeState } from './model/appPaneReducer';
import { migrateLegacyDetailsWorkspaceState, serializeDetailsWorkspaceState } from './details/workspace/migrateLegacyDetailsWorkspaceState';
import {
    createBuiltinPaneDestination,
    type SelectedPaneDestinationV1,
} from './model/selectedPaneDestination';
import {
    createPaneOverlayFocusReturnOwner,
    type PaneOverlayFocusReturnOwner,
    type PaneOverlayFocusSurface,
} from './paneOverlayFocusReturn';
import { createFileFindSeedHandoff, type FileFindSeedHandoff } from './fileFindSeedHandoff';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBindings, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { parseToken } from '@/utils/auth/parseToken';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { parseProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { isTerminalDetailsTab } from '@/components/terminal/terminalDetailsTabModel';
import { applyCloseDetailsTab } from './details/workspace/detailsWorkspaceReducer';

/** Private terminal labels/paths become visible only under their actual persisted Account owner. */
function qualifyProjectTerminalPane(scopeId: string, pane: PaneScopeState, scope: ServerAccountScope | null): PaneScopeState {
    if (!parseProjectPaneScopeId(scopeId)) return pane;
    const raw = pane.bottom.tabState.terminal;
    const workspace = readSessionTerminalWorkspace(raw);
    if (scope && workspace.ownerScope && areServerAccountScopesEqual(workspace.ownerScope, scope)) return pane;
    let details = pane.details;
    for (const tab of Object.values(details.tabsByKey)) {
        if (isTerminalDetailsTab({ resource: tab.resource, tabKey: tab.key })) details = applyCloseDetailsTab(details, tab.key);
    }
    if (raw === undefined && details === pane.details) return pane;
    if (workspace.tabs.length === 0 && !workspace.ownerScope && details === pane.details) return pane;
    return { ...pane, details, bottom: { ...pane.bottom,
        tabState: { ...pane.bottom.tabState, terminal: EMPTY_TERMINAL_WORKSPACE } } };
}

type AppPaneContextValue = Readonly<{
    state: AppPaneState;
    dispatch: (action: AppPaneAction) => void;
    registerDriver: (driver: PaneDriver) => () => void;
    getDriver: (scopeId: PaneScopeId) => PaneDriver | null;
    driverRegistryVersion: number;
    overlayFocusReturnOwner: PaneOverlayFocusReturnOwner;
    fileFindSeedHandoff: FileFindSeedHandoff;
    fileFindSeedAccountBindings: ReadonlyMap<string, ServerCredentialAccountScopeBinding>;
}>;

const AppPaneContext = createContext<AppPaneContextValue | null>(null);
type AppPaneFindSeedContextValue = Pick<AppPaneContextValue, 'fileFindSeedHandoff' | 'fileFindSeedAccountBindings'>;
// Launch consumers need credential/handoff changes, not every pane reducer tick.
const AppPaneFindSeedContext = createContext<AppPaneFindSeedContextValue | null>(null);

type PersistedPaneSlot = Readonly<{
    isOpen: boolean;
    activeTabId: string | null;
    selectedDestination?: SelectedPaneDestinationV1 | null;
    tabState: Record<string, unknown>;
}>;

function normalizePersistedPaneSlot(slot: PersistedPaneSlot): PaneScopeState['right'] {
    // `activeTabId` is the predecessor's built-in selection. Preserve it as a
    // host-owned selected destination once, at the persistence boundary; the
    // reducer never has to guess whether a legacy string was a plugin id.
    const selectedDestination = slot.selectedDestination
        ?? (slot.activeTabId ? createBuiltinPaneDestination(slot.activeTabId) : null);
    return {
        isOpen: slot.isOpen,
        activeTabId: slot.activeTabId ?? null,
        selectedDestination,
        tabState: slot.tabState,
    };
}

function normalizePersistedPaneScopes(
    value: Readonly<Record<string, {
        right: PersistedPaneSlot;
        details: unknown;
        bottom: PersistedPaneSlot;
    }>> | null | undefined,
): Readonly<Record<string, PaneScopeState>> {
    if (!value) return {};
    return Object.fromEntries(
        Object.entries(value).map(([scopeId, scope]) => [
            scopeId,
            {
                right: normalizePersistedPaneSlot(scope.right),
                details: migrateLegacyDetailsWorkspaceState(scope.details),
                bottom: normalizePersistedPaneSlot(scope.bottom),
            } satisfies PaneScopeState,
        ]),
    );
}

function serializePersistedPaneScopes(
    value: Readonly<Record<string, PaneScopeState>>,
): Record<string, {
    right: {
        isOpen: boolean;
        activeTabId: string | null;
        selectedDestination: SelectedPaneDestinationV1 | null;
        tabState: Record<string, unknown>;
    };
    details: ReturnType<typeof serializeDetailsWorkspaceState>;
    bottom: {
        isOpen: boolean;
        activeTabId: string | null;
        selectedDestination: SelectedPaneDestinationV1 | null;
        tabState: Record<string, unknown>;
    };
}> {
    return Object.fromEntries(
        Object.entries(value).map(([scopeId, scope]) => [
            scopeId,
            {
                right: {
                    isOpen: scope.right.isOpen,
                    activeTabId: scope.right.activeTabId,
                    selectedDestination: scope.right.selectedDestination,
                    tabState: { ...scope.right.tabState },
                },
                details: serializeDetailsWorkspaceState(scope.details),
                bottom: {
                    isOpen: scope.bottom.isOpen,
                    activeTabId: scope.bottom.activeTabId,
                    selectedDestination: scope.bottom.selectedDestination,
                    tabState: { ...scope.bottom.tabState },
                },
            },
        ]),
    );
}

function resolveOverlayFocusCapture(
    state: AppPaneState,
    action: AppPaneAction,
): Readonly<{ scopeId: string; surface: PaneOverlayFocusSurface }> | null {
    switch (action.type) {
        case 'openDetailsOverlay': {
            const scope = state.scopes[action.scopeId] ?? null;
            return scope?.details.overlay == null
                ? { scopeId: action.scopeId, surface: 'details' }
                : null;
        }
        case 'openDetailsTab': {
            const scope = state.scopes[action.scopeId] ?? null;
            return scope?.details.isOpen !== true
                ? { scopeId: action.scopeId, surface: 'details' }
                : null;
        }
        case 'openRight':
        case 'selectRightDestination': {
            const scope = state.scopes[action.scopeId] ?? null;
            return scope?.right.isOpen !== true
                ? { scopeId: action.scopeId, surface: 'right' }
                : null;
        }
        case 'openBottom':
        case 'selectBottomDestination': {
            const scope = state.scopes[action.scopeId] ?? null;
            return scope?.bottom.isOpen !== true
                ? { scopeId: action.scopeId, surface: 'bottom' }
                : null;
        }
        default:
            return null;
    }
}

function resolveOverlayFocusClear(
    action: AppPaneAction,
): Readonly<{ scopeId: string; surface: PaneOverlayFocusSurface }> | null {
    switch (action.type) {
        case 'closeDetails':
        case 'closeDetailsOverlay':
            return { scopeId: action.scopeId, surface: 'details' };
        case 'closeRight':
            return { scopeId: action.scopeId, surface: 'right' };
        case 'closeBottom':
            return { scopeId: action.scopeId, surface: 'bottom' };
        default:
            return null;
    }
}

export const AppPaneProvider = React.memo((props: Readonly<{ children: React.ReactNode }>) => {
    const persistedScopesValue = useLocalSetting('appPaneScopesV1');
    const persistedScopes = useMemo(
        () => normalizePersistedPaneScopes(persistedScopesValue),
        [persistedScopesValue],
    );
    const [, setPersistedScopes] = useLocalSettingMutable('appPaneScopesV1');
    const [state, setState] = useState(() => createAppPaneState({
        maxScopesInMemory: 12,
        persistedScopes: persistedScopes ?? {},
    }));
    const stateRef = useRef(state);
    const driversRef = useRef<Map<PaneScopeId, PaneDriver>>(new Map());
    const [fileFindSeedHandoff] = useState(createFileFindSeedHandoff);
    const homeProfilesGeneration = useServerProfilesGeneration();
    const fileFindSeedHomeIds = React.useMemo(() => listServerProfiles().map(resolveServerProfileScopeId), [homeProfilesGeneration]);
    const fileFindSeedAccountBindings = useServerCredentialAccountScopeBindings(fileFindSeedHomeIds);
    const activeAccountScope = useActiveServerAccountScope();
    const accountBindingsRef = useRef(fileFindSeedAccountBindings);
    accountBindingsRef.current = fileFindSeedAccountBindings;
    const readPaneAccountScope = React.useCallback((scopeId: string): ServerAccountScope | null => {
        const identity = parseProjectPaneScopeId(scopeId);
        if (!identity) return null;
        const active = getActiveServerAccountScope();
        if (active && resolveServerProfileScopeIdForIdentifier(active.serverId) === resolveServerProfileScopeIdForIdentifier(identity.serverId)) return active;
        const binding = accountBindingsRef.current.get(resolveServerProfileScopeIdForIdentifier(identity.serverId));
        return binding?.isCurrent() ? binding.scope : null;
    }, []);
    const readQualifiedState = React.useCallback(() => {
        const raw = stateRef.current;
        let scopes = raw.scopes;
        for (const [scopeId, pane] of Object.entries(raw.scopes)) {
            const qualified = qualifyProjectTerminalPane(scopeId, pane, readPaneAccountScope(scopeId));
            if (qualified !== pane) scopes = { ...scopes, [scopeId]: qualified };
        }
        return scopes === raw.scopes ? raw : { ...raw, scopes };
    }, [readPaneAccountScope]);
    const qualifiedState = React.useMemo(() => readQualifiedState(), [state, activeAccountScope, fileFindSeedAccountBindings, readQualifiedState]);
    React.useEffect(() => () => fileFindSeedHandoff.dispose(), [fileFindSeedHandoff]);
    const overlayFocusReturnOwnerRef = useRef<PaneOverlayFocusReturnOwner | null>(null);
    if (overlayFocusReturnOwnerRef.current === null) {
        overlayFocusReturnOwnerRef.current = createPaneOverlayFocusReturnOwner();
    }
    const overlayFocusReturnOwner = overlayFocusReturnOwnerRef.current;
    const dispatch = React.useCallback((action: AppPaneAction) => {
        if (action.type === 'mergePersistedScopes') {
            overlayFocusReturnOwner.clearAll();
        }

        const capture = resolveOverlayFocusCapture(stateRef.current, action);
        if (capture) {
            overlayFocusReturnOwner.capture(capture.scopeId, capture.surface);
        }

        const clear = resolveOverlayFocusClear(action);
        if (clear) {
            overlayFocusReturnOwner.clear(clear.scopeId, clear.surface);
        }

        let previousState = stateRef.current;
        if ('scopeId' in action) {
            const pane = previousState.scopes[action.scopeId];
            if (pane) {
                const qualified = qualifyProjectTerminalPane(action.scopeId, pane, readPaneAccountScope(action.scopeId));
                if (qualified !== pane) previousState = { ...previousState, scopes: { ...previousState.scopes, [action.scopeId]: qualified } };
            }
        }
        const nextState = appPaneReduce(previousState, action);
        stateRef.current = nextState;
        setState(nextState);
        notifySessionTerminalWorkspaceChanged();
        if (action.type === 'terminalWorkspace') {
            const command = action.command;
            const bottom = nextState.scopes[action.scopeId]?.bottom;
            const workspace = readSessionTerminalWorkspace(bottom?.tabState.terminal);
            const previousWorkspace = readSessionTerminalWorkspace(previousState.scopes[action.scopeId]?.bottom.tabState.terminal);
            const tab = workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId);
            const terminalId = tab?.focusedTerminalId;
            const accepted = command.type === 'focus'
                ? terminalId === command.terminalId
                : workspace !== previousWorkspace && (command.type === 'open' || command.type === 'split' || command.type === 'detach');
            if (accepted && tab && terminalId && bottom?.isOpen && bottom.selectedDestination?.kind === 'builtin' && bottom.selectedDestination.id === 'terminal') {
                driversRef.current.get(action.scopeId)?.onTerminalWorkspaceReveal?.({ tabId: tab.id, terminalId });
            }
        }
    }, [overlayFocusReturnOwner, readPaneAccountScope]);
    const [driverRegistryVersion, setDriverRegistryVersion] = useState(0);

    React.useLayoutEffect(() => registerSessionTerminalWorkspaceOwner({ getState: () => stateRef.current,
        getReadState: readQualifiedState, dispatch }), [dispatch, readQualifiedState]);

    React.useEffect(() => {
        for (const [scopeId, pane] of Object.entries(state.scopes)) {
            const identity = parseProjectPaneScopeId(scopeId);
            if (!identity) continue;
            const workspace = readSessionTerminalWorkspace(pane.bottom.tabState.terminal);
            const hasPrivatePresentation = pane.bottom.tabState.terminal !== undefined && workspace.tabs.length > 0
                || Object.values(pane.details.tabsByKey).some(tab => isTerminalDetailsTab({ resource: tab.resource, tabKey: tab.key }));
            const actual = readPaneAccountScope(scopeId);
            if (hasPrivatePresentation && (!workspace.ownerScope || (actual && !areServerAccountScopesEqual(workspace.ownerScope, actual)))) {
                retireProjectTerminalPresentationForHome(identity.serverId, workspace.ownerScope, scopeId);
            }
        }
    }, [state.scopes, activeAccountScope, fileFindSeedAccountBindings, readPaneAccountScope]);

    React.useEffect(() => subscribeHomeCredentialChange(event => {
        const serverId = resolveServerProfileScopeIdForIdentifier(event.serverId);
        const previous = accountBindingsRef.current.get(serverId);
        let nextAccountId: string | null = null;
        if (event.kind === 'credentials_set' && event.credentials) {
            try { nextAccountId = parseToken(event.credentials.token); } catch { /* Unreadable authority retires private presentation. */ }
        }
        // Credential renewal/profile refresh for the same Account preserves view continuity.
        if (previous && nextAccountId === previous.accountId) return;
        retireProjectTerminalPresentationForHome(serverId, previous?.scope);
    }), []);

    React.useEffect(() => {
        if (Object.keys(persistedScopes).length === 0) return;
        dispatch({ type: 'mergePersistedScopes', scopes: persistedScopes });
    }, [dispatch, persistedScopes]);

    React.useEffect(() => {
        setPersistedScopes(serializePersistedPaneScopes(state.scopes));
    }, [setPersistedScopes, state.scopes]);

    const registerDriver = React.useCallback((driver: PaneDriver) => {
        driversRef.current.set(driver.scopeId, driver);
        setDriverRegistryVersion((v) => v + 1);
        return () => {
            const current = driversRef.current.get(driver.scopeId);
            if (current === driver) {
                driversRef.current.delete(driver.scopeId);
                setDriverRegistryVersion((v) => v + 1);
            }
        };
    }, []);

    const getDriver = React.useCallback((scopeId: PaneScopeId) => {
        return driversRef.current.get(scopeId) ?? null;
    }, []);

    const value: AppPaneContextValue = useMemo(() => ({
        state: qualifiedState,
        dispatch,
        registerDriver,
        getDriver,
        driverRegistryVersion,
        overlayFocusReturnOwner,
        fileFindSeedHandoff,
        fileFindSeedAccountBindings,
    }), [driverRegistryVersion, dispatch, fileFindSeedHandoff, fileFindSeedAccountBindings, getDriver, overlayFocusReturnOwner, registerDriver, qualifiedState]);

    const findSeedValue = useMemo(() => ({ fileFindSeedHandoff, fileFindSeedAccountBindings }),
        [fileFindSeedHandoff, fileFindSeedAccountBindings]);
    return <AppPaneContext.Provider value={value}><AppPaneFindSeedContext.Provider value={findSeedValue}>
        {props.children}
    </AppPaneFindSeedContext.Provider></AppPaneContext.Provider>;
});

export function useAppPaneContext(): AppPaneContextValue {
    const ctx = useContext(AppPaneContext);
    if (!ctx) throw new Error('useAppPaneContext must be used within <AppPaneProvider>');
    return ctx;
}

export function useOptionalAppPaneContext(): AppPaneContextValue | null {
    return useContext(AppPaneContext);
}

export function useOptionalAppPaneFindSeedContext(): AppPaneFindSeedContextValue | null {
    return useContext(AppPaneFindSeedContext);
}
