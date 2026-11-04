import * as React from 'react';
import { Platform } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { resolveHref } from 'expo-router/build/link/href';
import { matchWorkspaceDestinationRoute, workspaceRouteHref } from './workspaceRoutes';
import { randomUUID } from '@/platform/randomUUID';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getActiveUnsavedChangesGuard, runGuardedNavigation, runGuardedTabNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { readDestinationInstanceTitle, resolveCurrentAppDestination, resolveDestinationRefFromHref, type CompactAppDestination, type DestinationRef } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter, sameDestinationRef, type WorkspaceOpenOptions } from './workspaceNavigationAdapter';
import { bindWorkspaceBrowserHistory, createWorkspaceBrowserTransport, installWorkspaceBrowserHistory } from './workspaceBrowserTransport';
import type { WorkspaceNavigationEntry } from './workspaceNavigationHistory';
import { useWorkspaceState } from './useWorkspaceState';
import { useWorkspaceTabSync } from './useWorkspaceTabSync';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue, type WorkspacePhoneControls, type WorkspaceDestinationTitle } from './WorkspaceNavigationContext';
import type { DestinationNavigation } from './DestinationInstanceHost';
import type { SplitCanvasHostControls } from '../splitCanvas/components/SplitCanvasHost';
import { createWorkspaceActionAdapter, selectWorkspaceTabsToClose, workspaceActionFailure, type WorkspaceActionOutcome } from './workspaceActions';
import { executeWorkspaceUiAction, registerMountedWorkspaceAction } from './workspaceActionRuntime';
import { admitWorkspaceSingletonState, workspaceSingletonDestinationIds } from './workspaceDestinationPolicy';
import { selectWorkspaceClosableTabIds, type WorkspaceState } from './workspaceState';
import { resolvePhoneWorkspaceTabHref } from './workspacePhoneProjection';
import { useWorkspaceKeyboardShortcuts } from './useWorkspaceKeyboardShortcuts';
import { WorkspaceRouteHostingContext } from './WorkspaceRouteHostingContext';
import { useOptionalAppPaneFindSeedContext, useOptionalPaneDriverReader } from '../panes/AppPaneProvider';
import { AppPaneContext } from '../panes/AppPaneContext';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { BROWSER_HISTORY_NAVIGATION_CHANGED } from '@/utils/navigation/browserHistoryNavigation';
import { WorkspaceWindowTitle } from './WorkspaceWindowTitle';
import { clearRouteAnchorSessionId, getSessionSurfaceVisibilityResetVersion, setRouteAnchorSessionId, subscribeSessionSurfaceVisibilityReset } from '@/sync/domains/session/sessionSurfaceVisibility';

function readBrowserHref(): string | null {
    return Platform.OS === 'web' && typeof window !== 'undefined'
        ? `${window.location.pathname}${window.location.search}${window.location.hash}` : null;
}

function subscribeBrowserHref(changed: () => void): () => void {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
    const target = window;
    target.addEventListener(BROWSER_HISTORY_NAVIGATION_CHANGED, changed);
    target.addEventListener('popstate', changed);
    return () => {
        target.removeEventListener(BROWSER_HISTORY_NAVIGATION_CHANGED, changed);
        target.removeEventListener('popstate', changed);
    };
}

const readServerHref = () => null;
const NO_DESTINATION_TITLES: Readonly<Record<string, WorkspaceDestinationTitle>> = Object.freeze({});

function runNavigation(navigate: () => void, intent?: 'history'): void {
    const result = runGuardedNavigation(navigate, intent);
    if (result !== true) fireAndForget(result, { tag: 'Workspace.navigation' });
}

/** Slice 2 owns the layout; this owner alone translates navigation intent to it and the URL. */
export function WorkspaceProvider(props: Readonly<{
    enabled: boolean;
    /**
     * Native phones keep their stack transport over the same tab and Action owner.
     * Web destinations retain their workspace host when only the viewport changes.
     */
    phone?: boolean;
    /** Authenticated public web flows may enter a destination before its shell is presented. */
    entry?: boolean;
    /** A web shell awaiting onboarding teardown must not lend its editable routes to Expo. */
    deferred?: boolean;
    catalog: readonly CompactAppDestination[];
    children: React.ReactNode | ((navigation: WorkspaceNavigationContextValue) => React.ReactNode);
}>): React.ReactNode {
    // Metro defers import evaluation. Resolve the decision owner while the app
    // shell initializes, before any lazy destination can register a draft.
    installWorkspaceBrowserHistory();
    const router = useRouter();
    const pathname = usePathname();
    const params = useGlobalSearchParams();
    const browserHref = React.useSyncExternalStore(subscribeBrowserHref, readBrowserHref, readServerHref);
    const scope = useActiveServerAccountScope();
    const findSeedContext = useOptionalAppPaneFindSeedContext();
    const readPaneDriver = useOptionalPaneDriverReader();
    const paneSubscription = React.useContext(AppPaneContext);
    const findHandoff = findSeedContext?.fileFindSeedHandoff;
    const scopeKey = scope ? JSON.stringify([scope.serverId, scope.accountId]) : null;
    // Browser history is authoritative even when readiness changes before Expo updates its mirror.
    const routeHref = (() => {
        if (browserHref !== null) return browserHref;
        return workspaceRouteHref(pathname, params);
    })();
    const phone = props.phone === true && !props.enabled;
    const entry = props.entry === true && Platform.OS === 'web';
    // Width changes presentation, never the owner or lifetime of an admitted web destination.
    const routeDestination = resolveDestinationRefFromHref(props.catalog, routeHref);
    const routeMatch = routeDestination ? matchWorkspaceDestinationRoute(routeHref.split(/[?#]/)[0]!) : null;
    const routeSessionId = routeDestination?.kind === 'session' || routeDestination?.kind === 'sessionDetails'
        ? routeDestination.params.id
        : routeMatch?.routeKey.startsWith('session/') ? routeMatch.params.id : undefined;
    // Unqualified routes retain their existing membership/ambiguity resolution
    // in the Session body; a focused Home cannot choose their exact-read target.
    const routeServerId = routeDestination?.params.serverId || null;
    const visibilityResetVersion = React.useSyncExternalStore(subscribeSessionSurfaceVisibilityReset, getSessionSurfaceVisibilityResetVersion, getSessionSurfaceVisibilityResetVersion);
    // Publish demand before core readiness admits the retained body. Sync uses
    // this same route-priority owner for exact acquisition and list hydration.
    React.useLayoutEffect(() => {
        if (!routeSessionId) return;
        setRouteAnchorSessionId(routeSessionId, routeServerId);
        return () => clearRouteAnchorSessionId(routeSessionId);
    }, [routeServerId, routeSessionId, visibilityResetVersion]);
    // Deferred web admission precedes shell presentation during onboarding
    // teardown. Lending an editable body to Expo while the shell is absent
    // would consume its handoff before the retained host can take custody.
    // Native phones still lend their routes to the native stack.
    const canHostRoutes = props.enabled || entry || ((phone || props.deferred === true) && Platform.OS === 'web');
    const ownsHref = React.useCallback((href: string) => canHostRoutes
        && resolveDestinationRefFromHref(props.catalog, href) !== null, [canHostRoutes, props.catalog]);
    const ownsRoute = ownsHref(routeHref);
    const hostsMobileWeb = phone && Platform.OS === 'web' && ownsRoute;
    const hostsRoute = props.enabled || hostsMobileWeb || (entry && ownsRoute);
    const phoneTransport = phone && !hostsMobileWeb;
    const phoneTabHref = phone ? resolvePhoneWorkspaceTabHref(props.catalog, routeHref) : null;
    const [initialTab] = React.useState(() => {
        // Initial URL admission is a local preview, not membership in the shared intentional tab set.
        const href = phoneTransport ? phoneTabHref : routeHref;
        return {
            id: randomUUID(), target: (href ? resolveDestinationRefFromHref(props.catalog, href) : null) ?? { kind: 'newTab', params: {} },
            pinned: false, preview: true,
        };
    });
    const admissionCatalog = React.useRef(props.catalog);
    admissionCatalog.current = props.catalog;
    const singletonPolicyKey = React.useMemo(() => JSON.stringify([...workspaceSingletonDestinationIds(props.catalog)].sort()), [props.catalog]);
    const admitState = React.useCallback((state: WorkspaceState, retainedState?: WorkspaceState) => admitWorkspaceSingletonState(state, admissionCatalog.current, randomUUID, retainedState), [singletonPolicyKey]);
    const localOwner = useWorkspaceState({ initialTab, admitState });
    const owner = useWorkspaceTabSync({ local: localOwner, catalog: props.catalog, enabled: props.enabled || phone });
    const [historyVersion, changed] = React.useReducer((value: number) => value + 1, 0);
    const [publishedTitles, setPublishedTitles] = React.useState<Readonly<{
        scopeKey: string | null; titles: Readonly<Record<string, WorkspaceDestinationTitle>>;
    }>>({ scopeKey, titles: {} });
    const destinationTitles = publishedTitles.scopeKey === scopeKey ? publishedTitles.titles : NO_DESTINATION_TITLES;
    const latest = React.useRef({ owner, router, catalog: props.catalog, enabled: props.enabled, entry, phone, phoneTransport, hostsRoute, scope, scopeKey, phoneTabHref, findSeedContext, destinationTitles, readPaneDriver, paneSubscription });
    latest.current = { owner, router, catalog: props.catalog, enabled: props.enabled, entry, phone, phoneTransport, hostsRoute, scope, scopeKey, phoneTabHref, findSeedContext, destinationTitles, readPaneDriver, paneSubscription };
    const publishDestinationTitle = React.useCallback((tabId: string, ref: DestinationRef, title: string | null) => {
        // The body may finish an effect after navigation. Its old identity must
        // never name the new destination retained under the same tab key.
        if (latest.current.scopeKey !== scopeKey || latest.current.owner.getState().tabs[tabId]?.target !== ref) return () => {};
        setPublishedTitles(current => {
            const previous = current.scopeKey === scopeKey ? current.titles[tabId] : undefined;
            if (previous?.ref === ref && previous.title === title) return current;
            return { scopeKey, titles: { ...(current.scopeKey === scopeKey ? current.titles : {}), [tabId]: {
                ref, title, ...(previous?.ref === ref && previous.redirectSource ? { redirectSource: previous.redirectSource } : {}),
            } } };
        });
        return () => setPublishedTitles(current => {
            if (current.scopeKey !== scopeKey || current.titles[tabId]?.ref !== ref || current.titles[tabId]?.title !== title) return current;
            const state = latest.current.owner.getState();
            // Keep the last known title through refresh and explicit close/reopen.
            // Replaced previews and destinations have no surviving title lifetime.
            if (latest.current.scopeKey === scopeKey && (state.tabs[tabId]?.target === ref
                || state.recentlyClosed.some(entry => entry.tab.id === tabId && entry.tab.target === ref))) return current;
            const next = { ...current.titles }; delete next[tabId]; return { scopeKey, titles: next };
        });
    }, [scopeKey]);
    const projectedHref = React.useRef<string | null>(null);
    const backSteps = React.useRef(new Map<string, () => boolean>());
    const canvasControlsRef = React.useRef<SplitCanvasHostControls | null>(null);
    const isCurrentUiOwner = React.useCallback(() => latest.current.scopeKey === scopeKey
        && latest.current.phoneTransport === phoneTransport && (latest.current.phone || latest.current.enabled)
        && latest.current.owner.isReady, [phoneTransport, scopeKey]);
    const runUiNavigation = React.useCallback((operation: () => void, intent?: 'history') => {
        if (!isCurrentUiOwner()) return;
        runNavigation(() => { if (isCurrentUiOwner()) operation(); }, intent);
    }, [isCurrentUiOwner]);
    const guardTraversal = React.useCallback((direction: -1 | 1, proceed: () => void, intent?: 'history') => {
        if (!isCurrentUiOwner()) return false;
        return runGuardedNavigation(() => {
            if (!isCurrentUiOwner()) return;
            const state = latest.current.owner.getState();
            const tabId = state.groups[state.focusedGroupId].activeTabId;
            if (direction === -1 && backSteps.current.get(tabId)?.()) return;
            proceed();
        }, intent);
    }, [isCurrentUiOwner]);
    const runtime = React.useMemo(() => {
        const mirror = (href: string, entry?: WorkspaceNavigationEntry) => {
            const projected = phoneTransport && entry?.target.kind === 'newTab' ? '/' : href;
            projectedHref.current = projected;
            if (phoneTransport && latest.current.phoneTabHref === null && projected !== '/') latest.current.router.push(projected as never);
            else latest.current.router.replace(projected as never);
        };
        // Hosted web destinations keep their transport across width changes.
        const browser = !phoneTransport && Platform.OS === 'web' && typeof window !== 'undefined'
            ? createWorkspaceBrowserTransport({
                history: window.history,
                getHref: () => `${window.location.pathname}${window.location.search}${window.location.hash}`,
                mirror, createId: randomUUID,
                accept: (href, entry, position) => adapter.acceptUrl(href, entry, position),
                guard: guardTraversal,
                needsGuard: (direction) => {
                    const state = latest.current.owner.getState();
                    const tabId = state.groups[state.focusedGroupId].activeTabId;
                    const guard = getActiveUnsavedChangesGuard();
                    return Boolean(guard && !guard.ignoreRef?.current
                        && (guard.isDirtyRef.current || guard.prepareGuard))
                        || (direction === -1 && backSteps.current.has(tabId));
                },
            }) : null;
        const adapter = createWorkspaceNavigationAdapter({
            getState: () => latest.current.owner.getState(),
            getCatalog: () => latest.current.catalog,
            getScope: () => latest.current.scope,
            prepareOpen: (source, destination, options) => {
                const facts = latest.current;
                const account = facts.scope;
                if (!mounted.initialized || (options.mode ?? 'preview') !== 'preview'
                    || source.groupId !== destination.groupId
                    || source.target.kind !== 'session' || destination.target.kind !== 'session'
                    || source.target.params.id === destination.target.params.id || !account
                    || !areServerAccountScopesEqual(account, getActiveServerAccountScope())
                    || !Object.keys(destination.target.params).every(key => key === 'id' || key === 'serverId' || key === 'accountId')) return;
                const sameAccount = (target: DestinationRef) => areServerProfileIdentifiersEquivalent(
                    target.params.serverId ?? account.serverId, account.serverId)
                    && (target.params.accountId ?? account.accountId) === account.accountId;
                if (!sameAccount(source.target) || !sameAccount(destination.target)) return;
                const state = facts.owner.getState();
                if (state.focusedGroupId !== source.groupId || state.groups[source.groupId]?.activeTabId !== source.tabId) return;
                const pane = facts.paneSubscription?.getSnapshot();
                const sourceScopeId = createSessionPaneScopeId(source.target.params.id, account.serverId, source.tabId);
                const destinationScopeId = createSessionPaneScopeId(destination.target.params.id, account.serverId, destination.tabId);
                const right = pane?.state.scopes[sourceScopeId]?.right;
                if (!pane || pane.state.activeScopeId !== sourceScopeId || !right?.isOpen
                    || right.selectedDestination?.kind !== 'plugin' || pane.state.scopes[destinationScopeId]) return;
                const selected = right.selectedDestination;
                const binding = facts.readPaneDriver?.(sourceScopeId)?.rightSidebarAdapter?.readContinuingDestination?.(selected);
                if (!binding || binding.targetKind !== 'app' || binding.container !== 'rightSidebarTab'
                    || binding.destination.pluginId !== selected.destination.pluginId
                    || binding.destination.localId !== selected.destination.localId) return;
                // Continue only the selection intent, not tabState, launch input, instance identity or custody.
                const selection = { kind: 'plugin' as const, destination: binding.destination };
                return opened => {
                    const current = latest.current;
                    if (current.scopeKey !== facts.scopeKey
                        || !areServerAccountScopesEqual(account, getActiveServerAccountScope())
                        || opened.tabId !== destination.tabId || opened.groupId !== destination.groupId
                        || !sameDestinationRef(opened.target, destination.target)) return;
                    const currentState = current.owner.getState();
                    if (currentState.focusedGroupId !== opened.groupId
                        || currentState.groups[opened.groupId]?.activeTabId !== opened.tabId
                        || !sameDestinationRef(currentState.tabs[opened.tabId].target, opened.target)) return;
                    const currentPane = current.paneSubscription?.getSnapshot();
                    if (!currentPane || currentPane.state.scopes[destinationScopeId]) return;
                    currentPane.dispatch({ type: 'activateScope', scopeId: destinationScopeId,
                        initialRight: { isOpen: true, activeTabId: null, selectedDestination: selection } });
                };
            },
            dispatch: (action) => {
                const owner = latest.current.owner;
                if (mounted.initialized) owner.dispatch(action);
                else owner.restoreAction(action);
            },
            transport: browser ?? { commit: mirror },
            createId: randomUUID, onChange: changed,
            ...(phoneTransport ? { resolveOpenHref: (href: string) => resolvePhoneWorkspaceTabHref(latest.current.catalog, href) } : {}),
        });
        const mounted = { adapter, browser, initialized: false };
        return mounted;
    }, [guardTraversal, scopeKey, phoneTransport]);
    const eligible = routeDestination !== null;
    // Overlay routes (including direct /search) launch destinations through this
    // owner even though the overlay itself is not a retained workspace tab.
    const overlayRoute = resolveCurrentAppDestination(props.catalog, routeHref.split(/[?#]/)[0]!)?.activation === 'overlay';

    React.useEffect(() => {
        if (!(props.enabled || phone) || !owner.isReady || (!phone && !overlayRoute && (!eligible || !runtime.initialized))) return;
        // An overlay has no tab URL to adopt. Its Actions still persist changes
        // to the restored workspace instead of treating them as URL hydration.
        if (overlayRoute) runtime.initialized = true;
        let current = true;
        const execute = createWorkspaceActionAdapter({
            getState: () => latest.current.owner.getState(), navigation: runtime.adapter,
            readCanvas: () => canvasControlsRef.current, createId: randomUUID,
            readClosedTitle: entry => readDestinationInstanceTitle(latest.current.catalog, entry.tab.target, {
                publishedTitle: latest.current.destinationTitles[entry.tab.id], fallbackTitle: entry.fallbackTitle,
            }),
            phone,
            openFileInPlace: (file, tabId) => {
                if (file.target.kind !== 'session' || !file.target.serverId) return false;
                const state = latest.current.owner.getState();
                const activeTabId = state.groups[state.focusedGroupId].activeTabId;
                const retained = state.tabs[activeTabId]?.target;
                if ((tabId && tabId !== activeTabId) || (retained?.kind !== 'session' && retained?.kind !== 'sessionDetails')
                    || retained.params.id !== file.target.sessionId
                    || !areServerProfileIdentifiersEquivalent(retained.params.serverId, file.target.serverId)) return false;
                const driver = latest.current.readPaneDriver?.(createSessionPaneScopeId(file.target.sessionId, file.target.serverId, tabId));
                if (driver?.surfaceScope?.targetKind !== 'session' || driver.surfaceScope.sessionId !== file.target.sessionId
                    || !areServerProfileIdentifiersEquivalent(driver.surfaceScope.serverId, file.target.serverId)) return false;
                const { target: _target, ...resource } = file;
                return driver.openResource?.({ kind: 'file', ...resource }, { intent: 'preview', present: false }) === true;
            },
            ...(findHandoff ? { chatFind: { handoff: findHandoff, resolveAuthority: (serverId: string) =>
                latest.current.findSeedContext?.fileFindSeedAccountBindings.get(resolveServerProfileScopeIdForIdentifier(serverId)) ?? null } } : {}),
        });
        const retire = registerMountedWorkspaceAction(async (request) => {
            const isCurrent = () => current && isCurrentUiOwner();
            if (!isCurrent()) return workspaceActionFailure('workspace_unavailable');
            if (request.signal?.aborted) return workspaceActionFailure('action_cancelled');
            const state = latest.current.owner.getState();
            const closing = selectWorkspaceTabsToClose(state, request.actionId, request.input);
            if (closing) {
                if (!closing.tabIds.length) return execute(request.actionId, request.input);
                let outcome: WorkspaceActionOutcome = workspaceActionFailure('workspace_navigation_cancelled');
                await runGuardedTabNavigation(closing.tabIds, async () => {
                    const selection = selectWorkspaceTabsToClose(latest.current.owner.getState(), request.actionId, request.input);
                    if (!selection || selection.groupId !== closing.groupId || selection.tabIds.length !== closing.tabIds.length
                        || selection.tabIds.some((id, index) => id !== closing.tabIds[index])) return false;
                    if (phone) runtime.initialized = true;
                    outcome = await execute(request.actionId, request.input);
                    return outcome.ok;
                }, {
                    includeActiveGuard: state.focusedGroupId === closing.groupId
                        && closing.tabIds.includes(state.groups[closing.groupId].activeTabId),
                    isCurrent: () => isCurrent() && !request.signal?.aborted && closing.tabIds.every(id => {
                        const tab = latest.current.owner.getState().tabs[id];
                        return tab && sameDestinationRef(tab.target, state.tabs[id].target);
                    }),
                });
                return !isCurrent() ? workspaceActionFailure('workspace_unavailable')
                    : request.signal?.aborted ? workspaceActionFailure('action_cancelled') : outcome;
            }
            const navigates = request.actionId === 'workspace.tabs.open' || request.actionId === 'workspace.tabs.activate'
                || request.actionId === 'workspace.tabs.move'
                || request.actionId === 'workspace.tabs.reopen'
                || request.actionId === 'workspace.groups.focus' || request.actionId === 'workspace.split';
            if (!navigates) return execute(request.actionId, request.input);
            let outcome: WorkspaceActionOutcome = workspaceActionFailure('workspace_navigation_cancelled');
            await runGuardedNavigation(async () => {
                if (phone && isCurrent() && !request.signal?.aborted) runtime.initialized = true;
                outcome = !isCurrent() ? workspaceActionFailure('workspace_unavailable')
                    : request.signal?.aborted ? workspaceActionFailure('action_cancelled')
                        : await execute(request.actionId, request.input);
            });
            return outcome;
        });
        return () => { current = false; retire(); };
    }, [eligible, findHandoff, isCurrentUiOwner, owner.isReady, overlayRoute, phone, props.enabled, runtime, scopeKey]);

    React.useLayoutEffect(() => {
        if (!hostsRoute || !owner.isReady || !eligible) return;
        if (!runtime.initialized) {
            runtime.adapter.initialize(routeHref);
            runtime.initialized = true;
        } else if (projectedHref.current !== routeHref) {
            // A different browser URL retires the preceding Expo mirror. Returning
            // to that old URL is fresh navigation and must update the retained Home.
            projectedHref.current = null;
            runtime.adapter.acceptUrl(routeHref);
        }
    }, [eligible, owner.isReady, hostsRoute, routeHref, runtime]);

    React.useLayoutEffect(() => {
        if (!hostsRoute || !owner.isReady || !runtime.browser || typeof window === 'undefined') return;
        return bindWorkspaceBrowserHistory(runtime.browser.acceptPopState);
    }, [owner.isReady, hostsRoute, runtime]);

    // The phone records what is on screen as its one preview (or the tab it already is). It never
    // writes browser history: tab switches move the phone's stack, and only explicit opens become synced tabs.
    React.useLayoutEffect(() => {
        if (!phoneTransport || !owner.isReady) return;
        if (phoneTabHref) runtime.adapter.acceptUrl(phoneTabHref);
        if (phoneTabHref || eligible) runtime.initialized = true;
    }, [eligible, owner.isReady, phoneTransport, phoneTabHref, runtime]);
    const activateTab = React.useCallback((groupId: string, tabId: string) => {
        if (!isCurrentUiOwner()) return;
        const state = latest.current.owner.getState();
        // Pointer/focus events inside a leaf re-assert its active tab. They are
        // not departures and must not ask to discard that tab's unsaved work.
        // Off-tab phone screens still need to project the retained tab back onto the stack.
        if (state.focusedGroupId === groupId && state.groups[groupId]?.activeTabId === tabId
            && (!phoneTransport || latest.current.phoneTabHref !== null)) return;
        runUiNavigation(() => {
            runtime.initialized = true;
            runtime.adapter.activateTab(groupId, tabId);
        });
    }, [isCurrentUiOwner, phoneTransport, runUiNavigation, runtime]);
    const closeTabs = React.useCallback((groupId: string, tabIds: readonly string[], bulk: boolean) => {
        if (!isCurrentUiOwner()) return;
        const state = latest.current.owner.getState();
        const group = state.groups[groupId];
        if (!group) return;
        const closingIds = bulk ? selectWorkspaceClosableTabIds(state, groupId, tabIds) : tabIds.filter(id => group.tabIds.includes(id));
        if (!closingIds.length) return;
        const result = runGuardedTabNavigation(closingIds, () => {
            runtime.initialized = true;
            if (bulk) runtime.adapter.closeTabs(groupId, closingIds);
            else runtime.adapter.closeTab(groupId, closingIds[0]);
        }, {
            includeActiveGuard: state.focusedGroupId === groupId && closingIds.includes(group.activeTabId),
            isCurrent: () => isCurrentUiOwner() && closingIds.every(id => {
                const current = latest.current.owner.getState();
                const tab = current.tabs[id];
                return current.groups[groupId]?.tabIds.includes(id) && tab && sameDestinationRef(tab.target, state.tabs[id].target);
            }),
        });
        if (result !== true) fireAndForget(result, { tag: 'Workspace.closeTabs' });
    }, [isCurrentUiOwner, runtime]);
    const openHref = React.useCallback((href: string, options?: WorkspaceOpenOptions) => {
        const canEnter = () => entry && latest.current.entry && latest.current.scopeKey === scopeKey
            && latest.current.phoneTransport === phoneTransport && runtime.browser !== null;
        if (canEnter() && resolveDestinationRefFromHref(latest.current.catalog, href)) {
            // Exact-Home refresh can finish while the scoped layout is still
            // hydrating. Browser custody retains the intent; normal restoration
            // admits that URL once ready, without lending it to Expo's index.
            runNavigation(() => {
                if (!canEnter()) return;
                if (!latest.current.owner.isReady) runtime.browser?.enterHref(href, options?.replace === true);
                else {
                    runtime.initialized = true;
                    runtime.adapter.openHref(href, options);
                }
            });
            return true;
        }
        if (!isCurrentUiOwner() || !latest.current.hostsRoute
            || !resolveDestinationRefFromHref(latest.current.catalog, href)) return false;
        runUiNavigation(() => {
            runtime.initialized = true;
            runtime.adapter.openHref(href, options);
        });
        return true;
    }, [entry, isCurrentUiOwner, phoneTransport, runUiNavigation, runtime, scopeKey]);
    const tabNavigations = React.useMemo(() => new Map<string, DestinationNavigation>(), [runtime]);
    const navigationForTab = React.useCallback((tabId: string): DestinationNavigation => {
        const existing = tabNavigations.get(tabId);
        if (existing) return existing;
        const navigate = (href: Parameters<typeof router.push>[0], replace: boolean, automatic = false) => {
            if (!isCurrentUiOwner()) return;
            const resolved = resolveHref(href);
            const source = latest.current.owner.getState().tabs[tabId]?.target;
            const published = latest.current.destinationTitles[tabId];
            const redirectSource = published && published.ref === source ? published.redirectSource ?? source : source;
            if (!openHref(resolved, { tabId, replace, ...(automatic && redirectSource ? { onOpened: () => {
                const ref = latest.current.owner.getState().tabs[tabId]?.target;
                if (!ref || !isCurrentUiOwner()) return;
                setPublishedTitles(current => ({ scopeKey, titles: {
                    ...(current.scopeKey === scopeKey ? current.titles : {}),
                    [tabId]: { ref, title: null, redirectSource },
                } }));
            } } : {}) })) {
                runUiNavigation(() => replace ? latest.current.router.replace(href) : latest.current.router.push(href));
            }
        };
        const retainCurrent = () => {
            if (!isCurrentUiOwner() || !latest.current.owner.getState().tabs[tabId]?.preview) return;
            runtime.adapter.dispatch({ type: 'promoteTab', tabId });
        };
        const navigation: DestinationNavigation = {
            retainCurrent,
            push: (href) => navigate(href, false),
            pushRetainingCurrent: (href) => {
                if (!isCurrentUiOwner()) return;
                const resolved = resolveHref(href);
                if (!resolveDestinationRefFromHref(latest.current.catalog, resolved)) return;
                const state = latest.current.owner.getState();
                const group = Object.values(state.groups).find(candidate => candidate.tabIds.includes(tabId));
                if (!group) return;
                // No departure guard: the editor keeps its identity, local state and dirty baseline.
                // Promotion prevents a later preview open from retiring that retained draft.
                retainCurrent();
                runtime.adapter.openHref(resolved, { mode: 'newTab', groupId: group.id });
            },
            replace: (href) => navigate(href, true),
            redirect: (href) => navigate(href, true, true),
            back: () => {
                if (!isCurrentUiOwner()) return;
                if (runtime.browser) runtime.adapter.step(-1);
                else guardTraversal(-1, () => runtime.adapter.step(-1), 'history');
            },
            canGoBack: () => runtime.adapter.canGoBack,
            setParams: (values) => { if (isCurrentUiOwner()) runtime.adapter.setParams(tabId, values); },
        };
        tabNavigations.set(tabId, navigation);
        return navigation;
    }, [guardTraversal, isCurrentUiOwner, openHref, runUiNavigation, runtime, tabNavigations]);
    const phoneOnTab = phoneTabHref !== null;
    const phoneControls = React.useMemo<WorkspacePhoneControls | null>(() => {
        if (!phone || !owner.isReady) return null;
        const navigate = (operation: () => void) => runUiNavigation(() => {
            runtime.initialized = true;
            operation();
        });
        return {
            catalog: props.catalog,
            onTab: phoneOnTab,
            openHref: (href, mode, onOpened) => {
                const tabHref = resolvePhoneWorkspaceTabHref(latest.current.catalog, href);
                if (!tabHref) return false;
                navigate(() => { runtime.adapter.openHref(tabHref, { mode, onOpened }); });
                return true;
            },
            activateTab: (tabId) => {
                const state = latest.current.owner.getState();
                const group = Object.values(state.groups).find((item) => item.tabIds.includes(tabId));
                if (group) activateTab(group.id, tabId);
            },
            closeTab: (tabId) => {
                if (!isCurrentUiOwner()) return;
                const state = latest.current.owner.getState();
                if (!state.tabs[tabId]) return;
                fireAndForget(executeWorkspaceUiAction({ actionId: 'workspace.tabs.close', input: { tabId } }, href => {
                    const focused = latest.current.owner.getState();
                    const navigation = navigationForTab(focused.groups[focused.focusedGroupId].activeTabId);
                    (navigation.pushRetainingCurrent ?? navigation.push)(href);
                }), { tag: 'Workspace.phone.close' });
            },
        };
    }, [activateTab, isCurrentUiOwner, navigationForTab, owner.isReady, phone, phoneOnTab, props.catalog, runUiNavigation, runtime]);
    const navigation = React.useMemo<WorkspaceNavigationContextValue>(() => ({
        // Scoped restoration grants the retained host custody synchronously.
        // Transport initialization adopts the URL in a layout effect; it is
        // not another hydration barrier on a ready remount.
        active: hostsRoute && owner.isRestored && eligible,
        ownsRoute,
        phone: phoneControls,
        state: owner.state,
        catalog: props.catalog,
        destinationTitles, publishDestinationTitle,
        sharedTabs: owner.sharedTabs,
        tabSyncStatus: owner.tabSyncStatus,
        handoffSource: owner.handoffSource,
        canvasControlsRef,
        canGoBack: runtime.adapter.canGoBack, canGoForward: runtime.adapter.canGoForward,
        openHref, navigationForTab,
        findOpenHref: href => isCurrentUiOwner() ? runtime.adapter.findOpenHref(href) : null,
        registerBackStep: (tabId, consume) => {
            backSteps.current.set(tabId, consume);
            return () => { if (backSteps.current.get(tabId) === consume) backSteps.current.delete(tabId); };
        },
        activateTab,
        closeTab: (groupId, tabId) => closeTabs(groupId, [tabId], false),
        closeTabs: (groupId, tabIds) => closeTabs(groupId, tabIds, true),
        dispatch: (action) => {
            if (!isCurrentUiOwner()) return;
            if (action.type === 'activateTab') {
                activateTab(action.groupId, action.tabId);
                return;
            }
            if (action.type === 'focusGroup' && latest.current.owner.getState().focusedGroupId === action.groupId) return;
            if (action.type === 'focusGroup' || action.type === 'openTab'
                || action.type === 'moveTab' || action.type === 'splitTab' || action.type === 'reopenTab') runUiNavigation(() => runtime.adapter.dispatch(action));
            else runtime.adapter.dispatch(action);
        },
        back: () => {
            if (!isCurrentUiOwner()) return;
            if (runtime.browser) runtime.adapter.step(-1);
            else guardTraversal(-1, () => runtime.adapter.step(-1), 'history');
        },
        forward: () => {
            if (!isCurrentUiOwner()) return;
            if (runtime.browser) runtime.adapter.step(1);
            else guardTraversal(1, () => runtime.adapter.step(1), 'history');
        },
    }), [activateTab, closeTabs, destinationTitles, publishDestinationTitle, eligible, guardTraversal, historyVersion, hostsRoute, isCurrentUiOwner, navigationForTab, openHref, ownsRoute, phoneControls, owner.isRestored, owner.state, owner.sharedTabs, owner.tabSyncStatus, owner.handoffSource, runUiNavigation, runtime]);
    useWorkspaceKeyboardShortcuts(navigation.active, () => latest.current.owner.getState(), href => {
        const state = latest.current.owner.getState();
        navigationForTab(state.groups[state.focusedGroupId].activeTabId).pushRetainingCurrent?.(href);
    });
    return <WorkspaceRouteHostingContext.Provider value={ownsHref}>
        <WorkspaceNavigationProvider value={navigation}><WorkspaceWindowTitle />{typeof props.children === 'function' ? props.children(navigation) : props.children}</WorkspaceNavigationProvider>
    </WorkspaceRouteHostingContext.Provider>;
}
