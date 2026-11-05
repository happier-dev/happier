import * as React from 'react';
import { useMemo, useRef, useState } from 'react';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { UiStatePersistenceError } from '@/sync/domains/state/persistentUiState';
import type { PaneDriver, PaneScopeId } from './types';
import { registerSessionTerminalWorkspaceOwner, notifySessionTerminalWorkspaceChanged, retireProjectTerminalPresentationForHome } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { EMPTY_TERMINAL_WORKSPACE, readSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { appPaneReduce, createAppPaneState, type AppPaneAction, type AppPaneState, type PaneScopeState } from './model/appPaneReducer';
import { normalizePersistedPaneScopes, serializePersistedPaneScope, mergePaneScopePresentationState, reconcilePersistedTerminalWorkspace } from './model/paneScopePersistence';
import { PersistedPaneScopeSchema } from './model/paneScopePersistenceSchema';
import { getDeviceType } from '@/utils/platform/responsive';
import {
    createPaneOverlayFocusReturnOwner,
    type PaneOverlayFocusReturnOwner,
    type PaneOverlayFocusSurface,
} from './paneOverlayFocusReturn';
import { createFileFindSeedHandoff } from './fileFindSeedHandoff';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { areServerProfileIdentifiersEquivalent, listServerProfiles, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBindings, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { parseToken } from '@/utils/auth/parseToken';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { parseProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { isTerminalDetailsTab } from '@/components/terminal/terminalDetailsTabModel';
import { applyCloseDetailsTab } from './details/workspace/detailsWorkspaceReducer';
import { AppPaneContext, AppPaneFindSeedContext, AppPaneFocusReturnContext, AppPaneFileFrontContext, AppPaneDriverContext, createFileTabFrontSubscription, type AppPaneContextValue, type AppPaneContextSubscription } from './AppPaneContext';
import { selectedPaneDestinationTabKey } from './model/selectedPaneDestination';
import { Modal } from '@/modal';
import { presentDetailsStartSheet } from './details/PhoneDetailsStartSheet';

export { useAppPaneContext, useOptionalAppPaneContext, useOptionalAppPaneFindSeedContext, useOptionalPaneFocusReturnOwner, useOptionalPaneDriverReader } from './AppPaneContext';

type PaneScopePersistenceRead = Readonly<{
    scopeId: string;
    value: ReturnType<typeof paneUiState.readStrict> | UiStatePersistenceError;
}>;

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
    state: AppPaneState,
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

export const AppPaneProvider = React.memo((props: Readonly<{ children: React.ReactNode; presentedPaneTab?: Readonly<{ scopeId: string; tabKey: string }> }>) => {
    // Restoration belongs to this landing. Resizing a live view preserves its
    // current panes; a fresh phone landing never turns saved columns into sheets.
    const [restoreOpenPanes] = useState(() => getDeviceType() !== 'phone');
    const persistedScopesValue = React.useSyncExternalStore(paneUiState.subscribe, paneUiState.readAll, paneUiState.readAll);
    const persistedScopes = useMemo(
        () => normalizePersistedPaneScopes(persistedScopesValue, restoreOpenPanes),
        [persistedScopesValue, restoreOpenPanes],
    );
    const [state, setState] = useState(() => {
        const presented = props.presentedPaneTab;
        const stored = presented ? paneUiState.readStrict(presented.scopeId, value => PersistedPaneScopeSchema.parse(value)) : null;
        return createAppPaneState({
        maxScopesInMemory: 12,
        persistedScopes: presented ? stored ? normalizePersistedPaneScopes({ [presented.scopeId]: stored }, true) : {} : persistedScopes ?? {},
        });
    });
    const [persistenceFailed, setPersistenceFailed] = useState(false);
    const [detailsStartScopeId, setDetailsStartScopeId] = useState<string | null>(null);
    const startSheetRef = useRef<Readonly<{ id: string; scopeId: string }> | null>(null);
    const subscriptionRef = useRef<AppPaneContextSubscription | null>(null);
    const stateRef = useRef(state);
    const persistedScopesRef = useRef<AppPaneState['scopes'] | null>(null);
    // Reducer intents own persistence. Transient draft/dirty publications must
    // not serialize local settings from a passive effect after every edit.
    const persistScopes = React.useCallback((scopes: AppPaneState['scopes'], options?: Readonly<{ force?: boolean; throwOnFailure?: boolean; selectedPaneTabKey?: string; storedScope?: PaneScopePersistenceRead; retireLegacyApp?: boolean }>) => {
        if (persistedScopesRef.current === scopes && !options?.force) return true;
        try {
            // This landing's sheets stay transient through resize and host rebinds.
            const preserveDesktopVisibility = !restoreOpenPanes;
            for (const [scopeId, scope] of Object.entries(scopes)) {
                if (props.presentedPaneTab && scopeId !== props.presentedPaneTab.scopeId) continue;
                if (persistedScopesRef.current?.[scopeId] === scope && !options?.force) continue;
                const stored = options?.storedScope?.scopeId === scopeId ? options.storedScope.value
                    : paneUiState.readStrict(scopeId, value => PersistedPaneScopeSchema.parse(value));
                if (stored instanceof UiStatePersistenceError) throw stored;
                const storedScope = stored ? normalizePersistedPaneScopes({ [scopeId]: stored }, true)[scopeId] : null;
                // Checkpoints normalize presentation; only a scoped intent reduced from this read
                // may replace retained Shell membership. A flush must not replay an older inventory.
                const checkpointScope = options?.storedScope?.scopeId === scopeId ? scope
                    : reconcilePersistedTerminalWorkspace(scope, storedScope?.bottom.tabState.terminal);
                const ownedScope = mergePaneScopePresentationState(checkpointScope, storedScope, props.presentedPaneTab?.tabKey, options?.selectedPaneTabKey);
                paneUiState.set(scopeId, serializePersistedPaneScope(ownedScope, {
                    preserveDesktopVisibility,
                    previous: preserveDesktopVisibility ? stored : undefined,
                }));
            }
            // Explicit App adoption moves the retained content; omission or eviction
            // alone never authorizes deleting another presenter's stored scope.
            if (options?.retireLegacyApp) paneUiState.remove('app');
            // In-memory scopes can omit a sibling window's writes or scopes evicted by this window.
            // Only write the scopes this provider changed; absence is not a persistent deletion.
            persistedScopesRef.current = scopes;
            setPersistenceFailed(false);
            return true;
        } catch (error) {
            if (!(error instanceof UiStatePersistenceError)) throw error;
            setPersistenceFailed(true);
            if (options?.throwOnFailure) throw error;
            return false;
        }
    }, [props.presentedPaneTab, restoreOpenPanes]);
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
    const qualifiedStateRef = useRef(qualifiedState);
    qualifiedStateRef.current = qualifiedState;
    const [fileFrontSubscription] = useState(() => createFileTabFrontSubscription(() => qualifiedStateRef.current));
    React.useEffect(() => () => fileFindSeedHandoff.dispose(), [fileFindSeedHandoff]);
    const overlayFocusReturnOwnerRef = useRef<PaneOverlayFocusReturnOwner | null>(null);
    if (overlayFocusReturnOwnerRef.current === null) {
        overlayFocusReturnOwnerRef.current = createPaneOverlayFocusReturnOwner();
    }
    const overlayFocusReturnOwner = overlayFocusReturnOwnerRef.current;
    const pendingFileFocusReturns = useRef<Array<() => void>>([]);
    const dispatch = React.useCallback((action: AppPaneAction) => {
        const capture = resolveOverlayFocusCapture(stateRef.current, action);
        if (capture) {
            overlayFocusReturnOwner.capture(capture.scopeId, capture.surface);
        }

        const clear = resolveOverlayFocusClear(action, stateRef.current);
        if (clear) {
            overlayFocusReturnOwner.clear(clear.scopeId, clear.surface);
        }

        const shouldPersist = action.type !== 'mergePersistedScopes' && !('persist' in action && action.persist === false);
        let storedScope: PaneScopePersistenceRead | undefined;
        let previousState = stateRef.current;
        if ('scopeId' in action && action.scopeId !== undefined) {
            let pane = previousState.scopes[action.scopeId];
            if (shouldPersist && (!props.presentedPaneTab || props.presentedPaneTab.scopeId === action.scopeId)) {
                try {
                    storedScope = { scopeId: action.scopeId,
                        value: paneUiState.readStrict(action.scopeId, value => PersistedPaneScopeSchema.parse(value)) };
                } catch (error) {
                    if (!(error instanceof UiStatePersistenceError)) throw error;
                    // Keep the local intent usable; the existing persistence owner presents this failure.
                    storedScope = { scopeId: action.scopeId, value: error };
                }
            }
            const stored = storedScope?.value instanceof UiStatePersistenceError ? undefined : storedScope?.value;
            if (stored) {
                // A sibling presenter can publish before this provider's hydration effect runs.
                // Apply this intent to the device owner's current Shells, including explicit closes.
                const reconciled = pane ? reconcilePersistedTerminalWorkspace(pane, stored.bottom.tabState.terminal)
                    : normalizePersistedPaneScopes({ [action.scopeId]: stored }, restoreOpenPanes)[action.scopeId];
                if (reconciled !== pane) {
                    pane = reconciled;
                    previousState = { ...previousState, scopes: { ...previousState.scopes, [action.scopeId]: pane } };
                }
            }
            if (pane) {
                const accountScope = readPaneAccountScope(action.scopeId);
                // An unresolved Account masks reads; it is not evidence that
                // the retained Shells belong to someone else. Keep raw records
                // until the existing Account transition owner can retire them.
                const qualified = accountScope ? qualifyProjectTerminalPane(action.scopeId, pane, accountScope) : pane;
                if (qualified !== pane) previousState = { ...previousState, scopes: { ...previousState.scopes, [action.scopeId]: qualified } };
            }
        }
        const nextState = appPaneReduce(previousState, action);
        if (action.type === 'mergePersistedScopes' && nextState !== previousState) {
            overlayFocusReturnOwner.clearAll();
        }
        if ('scopeId' in action && action.scopeId !== undefined) {
            const previousDetails = previousState.scopes[action.scopeId]?.details;
            const nextDetails = nextState.scopes[action.scopeId]?.details;
            const activeKey = previousDetails?.focusedGroupId
                ? previousDetails.groupsById[previousDetails.focusedGroupId]?.activeTabKey
                : null;
            const isClose = action.type === 'closeDetails' || action.type === 'closeDetailsTab' || action.type === 'closeDetailsGroup';
            if (isClose && previousDetails?.isOpen && activeKey
                && (!nextDetails?.isOpen || !nextDetails.tabsByKey[activeKey])) {
                const restore = overlayFocusReturnOwner.takeDetailsTabReturn(action.scopeId, activeKey, 'pane');
                if (restore) pendingFileFocusReturns.current.push(restore);
            }
            for (const key of Object.keys(previousDetails?.tabsByKey ?? {})) {
                if (!nextDetails?.tabsByKey[key]) overlayFocusReturnOwner.forgetDetailsTabOrigin(action.scopeId, key);
            }
        }
        stateRef.current = nextState;
        setState(nextState);
        const sheet = startSheetRef.current;
        if (sheet && !nextState.scopes[sheet.scopeId]?.details.isOpen) {
            startSheetRef.current = null;
            setDetailsStartScopeId(null);
            Modal.hide(sheet.id);
        }
        if (shouldPersist) {
            let selectedPaneTabKey: string | undefined;
            if (action.type === 'selectRightDestination' || action.type === 'setRightTab'
                || action.type === 'openRight' && action.tabId !== undefined) selectedPaneTabKey = selectedPaneDestinationTabKey('right');
            else if (action.type === 'selectBottomDestination' || action.type === 'setBottomTab'
                || action.type === 'openBottom' && action.tabId !== undefined) selectedPaneTabKey = selectedPaneDestinationTabKey('bottom');
            else if (action.type === 'openDetailsOverlay') selectedPaneTabKey = selectedPaneDestinationTabKey('detailsOverlay');
            else if (action.type === 'restoreScope') selectedPaneTabKey = action.selectedPaneTabKey;
            persistScopes(nextState.scopes, {
                throwOnFailure: 'persist' in action && action.persist === true,
                // Selection commands already passed the mounted slot's navigation admission.
                // Draft/scroll writes continue to own content only, never its source selection.
                selectedPaneTabKey,
                storedScope,
                retireLegacyApp: action.type === 'activateScope' && Boolean(previousState.scopes.app)
                    && !nextState.scopes.app && nextState.scopes[action.scopeId] === previousState.scopes.app,
            });
        }
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
    }, [overlayFocusReturnOwner, persistScopes, props.presentedPaneTab, readPaneAccountScope, restoreOpenPanes]);
    const [driverRegistryVersion, setDriverRegistryVersion] = useState(0);

    React.useLayoutEffect(() => {
        const returns = pendingFileFocusReturns.current;
        pendingFileFocusReturns.current = [];
        for (const restore of returns) restore();
    }, [state]);

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
        let nextAccountId: string | null = null;
        if (event.kind === 'credentials_set' && event.credentials) {
            try { nextAccountId = parseToken(event.credentials.token); } catch { /* Unreadable authority retires private presentation. */ }
        }
        // The retained record owns its Account identity even while secure
        // storage is still resolving this landing's credential binding.
        for (const [scopeId, pane] of Object.entries(stateRef.current.scopes)) {
            const identity = parseProjectPaneScopeId(scopeId);
            if (!identity || !areServerProfileIdentifiersEquivalent(identity.serverId, serverId)) continue;
            const workspace = readSessionTerminalWorkspace(pane.bottom.tabState.terminal);
            const owner = workspace.ownerScope;
            if (owner && nextAccountId === owner.accountId
                && areServerProfileIdentifiersEquivalent(owner.serverId, serverId)) continue;
            retireProjectTerminalPresentationForHome(serverId, owner, scopeId);
        }
    }), []);

    React.useEffect(() => {
        if (props.presentedPaneTab) return;
        if (Object.keys(persistedScopes).length === 0) return;
        dispatch({ type: 'mergePersistedScopes', scopes: persistedScopes });
        // Hydration is also the canonical normalization checkpoint for legacy
        // pane shapes and invalid inherited group references.
        persistScopes(stateRef.current.scopes);
    }, [dispatch, persistedScopes, persistScopes, props.presentedPaneTab]);

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

    const presentDetailsStart = React.useCallback((scopeId: string) => {
        const subscription = subscriptionRef.current;
        if (!subscription || startSheetRef.current?.scopeId === scopeId) return;
        const previous = startSheetRef.current;
        startSheetRef.current = null;
        if (previous) Modal.hide(previous.id);
        const close = () => {
            const sheet = startSheetRef.current;
            if (sheet?.scopeId !== scopeId) return;
            startSheetRef.current = null;
            setDetailsStartScopeId(null);
            Modal.hide(sheet.id);
            dispatch({ type: 'closeDetails', scopeId });
        };
        setDetailsStartScopeId(scopeId);
        const id = presentDetailsStartSheet({ scopeId, subscription }, close);
        if (id) startSheetRef.current = { id, scopeId };
        else setDetailsStartScopeId(null);
    }, [dispatch]);
    React.useEffect(() => () => {
        const sheet = startSheetRef.current;
        startSheetRef.current = null;
        if (sheet) Modal.hide(sheet.id);
    }, []);

    const value: AppPaneContextValue = useMemo(() => ({
        state: qualifiedState,
        getReadState: readQualifiedState,
        persistenceFailed,
        flushPersistence: () => persistScopes(stateRef.current.scopes, { force: true }),
        dispatch,
        registerDriver,
        getDriver,
        driverRegistryVersion,
        detailsStartScopeId,
        presentDetailsStart,
        overlayFocusReturnOwner,
        fileFindSeedHandoff,
        fileFindSeedAccountBindings,
    }), [detailsStartScopeId, presentDetailsStart, driverRegistryVersion, dispatch, fileFindSeedHandoff, fileFindSeedAccountBindings, getDriver, overlayFocusReturnOwner, persistenceFailed, persistScopes, readQualifiedState, registerDriver, qualifiedState]);

    // One read-only subscription over the provider's canonical state. A file edit
    // must not broadcast a new React context through every retained pane subtree.
    const valueRef = useRef(value);
    valueRef.current = value;
    const [subscription] = useState<AppPaneContextSubscription>(() => ({
        getSnapshot: () => valueRef.current,
        subscribe: fileFrontSubscription.subscribe,
        notifyDriverUpdated: driver => {
            if (driversRef.current.get(driver.scopeId) === driver) fileFrontSubscription.notify();
        },
    }));
    subscriptionRef.current = subscription;
    React.useLayoutEffect(() => fileFrontSubscription.notify(), [fileFrontSubscription, value]);

    const findSeedValue = useMemo(() => ({ fileFindSeedHandoff, fileFindSeedAccountBindings }),
        [fileFindSeedHandoff, fileFindSeedAccountBindings]);
    return <AppPaneContext.Provider value={subscription}><AppPaneFindSeedContext.Provider value={findSeedValue}><AppPaneFocusReturnContext.Provider value={overlayFocusReturnOwner}><AppPaneFileFrontContext.Provider value={fileFrontSubscription}>
        <AppPaneDriverContext.Provider value={getDriver}>{props.children}</AppPaneDriverContext.Provider>
    </AppPaneFileFrontContext.Provider></AppPaneFocusReturnContext.Provider></AppPaneFindSeedContext.Provider></AppPaneContext.Provider>;
});
