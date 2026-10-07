import * as React from 'react';
import { Platform } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { resolveHref } from 'expo-router/build/link/href';
import { randomUUID } from '@/platform/randomUUID';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getActiveUnsavedChangesGuard, runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveDestinationRefFromHref, type CompactAppDestination } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter, type WorkspaceOpenOptions } from './workspaceNavigationAdapter';
import { createWorkspaceBrowserTransport } from './workspaceBrowserTransport';
import type { WorkspaceNavigationEntry } from './workspaceNavigationHistory';
import { useWorkspaceState } from './useWorkspaceState';
import { useWorkspaceTabSync } from './useWorkspaceTabSync';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue, type WorkspacePhoneControls } from './WorkspaceNavigationContext';
import type { DestinationNavigation } from './DestinationInstanceHost';
import type { SplitCanvasHostControls } from '../splitCanvas/components/SplitCanvasHost';
import { createWorkspaceActionAdapter, workspaceActionFailure, type WorkspaceActionOutcome } from './workspaceActions';
import { registerMountedWorkspaceAction } from './workspaceActionRuntime';
import { admitWorkspaceSingletonState, workspaceSingletonDestinationIds } from './workspaceDestinationPolicy';
import type { WorkspaceState } from './workspaceState';
import { resolvePhoneWorkspaceTabHref } from './workspacePhoneProjection';
import { useWorkspaceKeyboardShortcuts } from './useWorkspaceKeyboardShortcuts';

function runNavigation(navigate: () => void): void {
    const result = runGuardedNavigation(navigate);
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
    catalog: readonly CompactAppDestination[];
    children: React.ReactNode | ((navigation: WorkspaceNavigationContextValue) => React.ReactNode);
}>): React.ReactNode {
    const router = useRouter();
    const pathname = usePathname();
    const params = useGlobalSearchParams();
    const scope = useActiveServerAccountScope();
    const scopeKey = scope ? JSON.stringify([scope.serverId, scope.accountId]) : null;
    const routeHref = React.useMemo(() => {
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            return `${window.location.pathname}${window.location.search}${window.location.hash}`;
        }
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (typeof value === 'string') query.set(key, value);
        }
        return `${pathname}${query.size ? `?${query}` : ''}`;
    }, [params, pathname]);
    const phone = props.phone === true && !props.enabled;
    // Width changes presentation, never the owner or lifetime of an admitted web destination.
    const routeDestination = resolveDestinationRefFromHref(props.catalog, routeHref);
    const hostsMobileWeb = phone && Platform.OS === 'web' && routeDestination !== null;
    const hostsRoute = props.enabled || hostsMobileWeb;
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
    const admitState = React.useCallback((state: WorkspaceState) => admitWorkspaceSingletonState(state, admissionCatalog.current, randomUUID), [singletonPolicyKey]);
    const localOwner = useWorkspaceState({ initialTab, admitState });
    const owner = useWorkspaceTabSync({ local: localOwner, catalog: props.catalog, enabled: props.enabled || phone });
    const [historyVersion, changed] = React.useReducer((value: number) => value + 1, 0);
    const latest = React.useRef({ owner, router, catalog: props.catalog, enabled: props.enabled, phone, phoneTransport, hostsRoute, scope, scopeKey, phoneTabHref });
    latest.current = { owner, router, catalog: props.catalog, enabled: props.enabled, phone, phoneTransport, hostsRoute, scope, scopeKey, phoneTabHref };
    const projectedHref = React.useRef<string | null>(null);
    const backSteps = React.useRef(new Map<string, () => boolean>());
    const canvasControlsRef = React.useRef<SplitCanvasHostControls | null>(null);
    const isCurrentUiOwner = React.useCallback(() => latest.current.scopeKey === scopeKey
        && latest.current.phoneTransport === phoneTransport && (latest.current.phone || latest.current.enabled)
        && latest.current.owner.isReady, [phoneTransport, scopeKey]);
    const runUiNavigation = React.useCallback((operation: () => void) => {
        if (!isCurrentUiOwner()) return;
        runNavigation(() => { if (isCurrentUiOwner()) operation(); });
    }, [isCurrentUiOwner]);
    const guardTraversal = React.useCallback((direction: -1 | 1, proceed: () => void) => {
        runUiNavigation(() => {
            const state = latest.current.owner.getState();
            const tabId = state.groups[state.focusedGroupId].activeTabId;
            if (direction === -1 && backSteps.current.get(tabId)?.()) return;
            proceed();
        });
    }, [runUiNavigation]);
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
                    const guard = getActiveUnsavedChangesGuard();
                    const state = latest.current.owner.getState();
                    const tabId = state.groups[state.focusedGroupId].activeTabId;
                    return Boolean((guard && !guard.ignoreRef?.current && (guard.isDirtyRef.current || guard.prepareGuard))
                        || (direction === -1 && backSteps.current.has(tabId)));
                },
            }) : null;
        const adapter = createWorkspaceNavigationAdapter({
            getState: () => latest.current.owner.getState(),
            getCatalog: () => latest.current.catalog,
            getScope: () => latest.current.scope,
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

    React.useEffect(() => {
        if (!(props.enabled || phone) || !owner.isReady || (!phone && (!eligible || !runtime.initialized))) return;
        let current = true;
        const execute = createWorkspaceActionAdapter({
            getState: () => latest.current.owner.getState(), navigation: runtime.adapter,
            readCanvas: () => canvasControlsRef.current, createId: randomUUID,
            phone,
        });
        const retire = registerMountedWorkspaceAction(async (request) => {
            const isCurrent = () => current && isCurrentUiOwner();
            if (!isCurrent()) return workspaceActionFailure('workspace_unavailable');
            if (request.signal?.aborted) return workspaceActionFailure('action_cancelled');
            const navigates = request.actionId === 'workspace.tabs.open' || request.actionId === 'workspace.tabs.activate'
                || request.actionId === 'workspace.tabs.close' || request.actionId === 'workspace.tabs.move'
                || request.actionId === 'workspace.tabs.reopen'
                || request.actionId === 'workspace.groups.focus' || request.actionId === 'workspace.split';
            if (!navigates) return execute(request.actionId, request.input);
            let outcome: WorkspaceActionOutcome = workspaceActionFailure('workspace_navigation_cancelled');
            await runGuardedNavigation(() => {
                if (phone && isCurrent() && !request.signal?.aborted) runtime.initialized = true;
                outcome = !isCurrent() ? workspaceActionFailure('workspace_unavailable')
                    : request.signal?.aborted ? workspaceActionFailure('action_cancelled')
                        : execute(request.actionId, request.input);
            });
            return outcome;
        });
        return () => { current = false; retire(); };
    }, [eligible, isCurrentUiOwner, owner.isReady, phone, props.enabled, runtime, scopeKey]);

    React.useLayoutEffect(() => {
        if (!hostsRoute || !owner.isReady || !eligible) return;
        if (!runtime.initialized) {
            runtime.adapter.initialize(routeHref);
            runtime.initialized = true;
        } else if (projectedHref.current !== routeHref) runtime.adapter.acceptUrl(routeHref);
    }, [eligible, owner.isReady, hostsRoute, routeHref, runtime]);

    React.useEffect(() => {
        if (!hostsRoute || !owner.isReady || !runtime.browser || typeof window === 'undefined') return;
        const onPop = (event: PopStateEvent) => {
            if (runtime.browser?.acceptPopState(event.state)) event.stopImmediatePropagation();
        };
        // Expo's linking listener is a URL mirror, never a competing workspace history reader.
        window.addEventListener('popstate', onPop, true);
        return () => window.removeEventListener('popstate', onPop, true);
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
            openHref: (href, mode) => {
                const tabHref = resolvePhoneWorkspaceTabHref(latest.current.catalog, href);
                if (!tabHref) return false;
                navigate(() => { runtime.adapter.openHref(tabHref, { mode }); });
                return true;
            },
            activateTab: (tabId) => {
                const state = latest.current.owner.getState();
                const group = Object.values(state.groups).find((item) => item.tabIds.includes(tabId));
                if (group) activateTab(group.id, tabId);
            },
            closeTab: (tabId) => {
                navigate(() => {
                    const state = latest.current.owner.getState();
                    const group = Object.values(state.groups).find((item) => item.tabIds.includes(tabId));
                    if (group) runtime.adapter.closeTab(group.id, tabId);
                });
            },
        };
    }, [activateTab, owner.isReady, phone, phoneOnTab, props.catalog, runUiNavigation, runtime]);

    const openHref = React.useCallback((href: string, options?: WorkspaceOpenOptions) => {
        if (!isCurrentUiOwner() || !latest.current.hostsRoute
            || !resolveDestinationRefFromHref(latest.current.catalog, href)) return false;
        runUiNavigation(() => { runtime.adapter.openHref(href, options); });
        return true;
    }, [isCurrentUiOwner, runUiNavigation, runtime]);
    const tabNavigations = React.useMemo(() => new Map<string, DestinationNavigation>(), [runtime]);
    const navigationForTab = React.useCallback((tabId: string): DestinationNavigation => {
        const existing = tabNavigations.get(tabId);
        if (existing) return existing;
        const navigate = (href: Parameters<typeof router.push>[0], replace: boolean) => {
            const resolved = resolveHref(href);
            if (!openHref(resolved, { tabId, replace })) {
                runUiNavigation(() => replace ? latest.current.router.replace(href) : latest.current.router.push(href));
            }
        };
        const navigation: DestinationNavigation = {
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
                runtime.adapter.dispatch({ type: 'promoteTab', tabId });
                runtime.adapter.openHref(resolved, { mode: 'newTab', groupId: group.id });
            },
            replace: (href) => navigate(href, true),
            back: () => {
                if (!isCurrentUiOwner()) return;
                if (runtime.browser) runtime.adapter.step(-1);
                else guardTraversal(-1, () => runtime.adapter.step(-1));
            },
            canGoBack: () => runtime.adapter.canGoBack,
            setParams: (values) => { if (isCurrentUiOwner()) runtime.adapter.setParams(tabId, values); },
        };
        tabNavigations.set(tabId, navigation);
        return navigation;
    }, [guardTraversal, isCurrentUiOwner, openHref, runUiNavigation, runtime, tabNavigations]);
    const navigation = React.useMemo<WorkspaceNavigationContextValue>(() => ({
        active: hostsRoute && owner.isReady && eligible && runtime.initialized,
        phone: phoneControls,
        state: owner.state,
        catalog: props.catalog,
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
        closeTab: (groupId, tabId) => runUiNavigation(() => runtime.adapter.closeTab(groupId, tabId)),
        closeTabs: (groupId, tabIds) => runUiNavigation(() => runtime.adapter.closeTabs(groupId, tabIds)),
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
            else guardTraversal(-1, () => runtime.adapter.step(-1));
        },
        forward: () => {
            if (!isCurrentUiOwner()) return;
            if (runtime.browser) runtime.adapter.step(1);
            else guardTraversal(1, () => runtime.adapter.step(1));
        },
    }), [activateTab, eligible, guardTraversal, historyVersion, hostsRoute, isCurrentUiOwner, navigationForTab, openHref, phoneControls, owner.isReady, owner.state, owner.sharedTabs, owner.tabSyncStatus, owner.handoffSource, runUiNavigation, runtime]);
    useWorkspaceKeyboardShortcuts(navigation.active, () => latest.current.owner.getState());
    return <WorkspaceNavigationContext.Provider value={navigation}>{typeof props.children === 'function' ? props.children(navigation) : props.children}</WorkspaceNavigationContext.Provider>;
}
