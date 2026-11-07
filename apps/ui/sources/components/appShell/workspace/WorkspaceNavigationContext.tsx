import * as React from 'react';
import { shallow } from 'zustand/shallow';
import type { WorkspaceOpenOptions, WorkspaceOpenDestination } from './workspaceNavigationAdapter';
import { selectWorkspaceVisibleGroup, type WorkspaceAction, type WorkspaceState, type WorkspacePresentationVisibility } from './workspaceState';
import type { DestinationNavigation } from './DestinationInstanceHost';
import type { SplitCanvasHostControls } from '../splitCanvas/components/SplitCanvasHost';
import type { WorkspaceTabSyncStatus } from './useWorkspaceTabSync';
import { hrefForDestinationRef, type CompactAppDestination, type DestinationRef } from '../destinations/compactAppDestinationCatalog';
import { getDesktopAppWindowPlacedTabs, getDesktopAppWindowTransfers, subscribeDesktopAppWindows, subscribeDesktopAppWindowTransfers } from '@/desktop/window/appWindowRuntime';

export type WorkspaceDestinationTitle = Readonly<{
    ref: DestinationRef;
    title: string | null;
    /** An automatic collection landing keeps the collection's chrome identity until explicit navigation. */
    redirectSource?: DestinationRef;
}>;
export type WorkspaceDestinationTitles = Readonly<Record<string, WorkspaceDestinationTitle>>;
const NO_DESTINATION_TITLES: WorkspaceDestinationTitles = Object.freeze({});
/** Published page titles by tab: their own publication, so only title readers render for a rename. */
const WorkspaceDestinationTitlesContext = React.createContext<WorkspaceDestinationTitles>(NO_DESTINATION_TITLES);

/**
 * The phone's controls over the same owner. The phone keeps its own stack navigation: these move the
 * stack and record intent in the workspace, without writing browser History on a phone.
 */
export type WorkspacePhoneControls = Readonly<{
    /** The destination catalog the tabs resolve against (titles, icons, hrefs). */
    catalog: readonly CompactAppDestination[];
    /** The screen shows one of the tabs (not one of the phone's own main tabs). */
    onTab: boolean;
    /** `preview` replaces the phone's preview; `newTab` keeps it as a synced tab. Both open it on screen. */
    openHref: (href: string, mode: 'preview' | 'newTab', onOpened?: () => void) => boolean;
    activateTab: (tabId: string) => void;
    closeTab: (tabId: string) => void;
}>;

export type WorkspaceNavigationContextValue = Readonly<{
    active: boolean;
    /** Runtime-local app section; only explicit section activation changes it. */
    sectionPathname?: string | null;
    /** An Expo modal covers the retained destination without replacing its lifetime. */
    overlayActive?: boolean;
    /** The admitted route belongs here even while its retained workspace is hydrating. */
    ownsRoute?: boolean;
    /** Present only on a phone, where the workspace owns the tab set but not navigation. */
    phone?: WorkspacePhoneControls | null;
    state: WorkspaceState;
    /** Current native presentation realm; global records remain scoped to their Home and Account. */
    desktopPresentation?: Readonly<{ serverId: string; accountId: string; windowId?: string; layoutId?: string }>;
    catalog?: readonly CompactAppDestination[];
    /**
     * Current mounted screen identities at call time, local to this owner and never persisted.
     * Titles are not part of this value: a page renaming itself per keystroke (a Workflow name)
     * would otherwise re-render every whole-workspace reader. Render-time readers use
     * `useWorkspaceDestinationTitles`.
     */
    readDestinationTitles?: () => WorkspaceDestinationTitles;
    publishDestinationTitle?: (tabId: string, ref: DestinationRef, title: string | null) => () => void;
    tabSyncStatus?: WorkspaceTabSyncStatus;
    canvasControlsRef?: React.MutableRefObject<SplitCanvasHostControls | null>;
    canGoBack: boolean;
    canGoForward: boolean;
    openHref: (href: string, options?: WorkspaceOpenOptions) => boolean;
    findOpenHref?: (href: string) => WorkspaceOpenDestination | null;
    activateTab: (groupId: string, tabId: string) => void;
    closeTab: (groupId: string, tabId: string) => void;
    closeTabs: (groupId: string, tabIds: readonly string[]) => void;
    dispatch: (action: WorkspaceAction) => void;
    navigationForTab: (tabId: string) => DestinationNavigation;
    registerBackStep: (tabId: string, consume: () => boolean) => () => void;
    back: () => void;
    forward: () => void;
}>;

/** Module-private: every provider goes through WorkspaceNavigationProvider so its summaries follow the same value. */
type WorkspaceNavigationSubscription = Readonly<{
    getSnapshot(): WorkspaceNavigationContextValue | null;
    subscribe(listener: () => void): () => void;
}>;
const WorkspaceNavigationContext = React.createContext<WorkspaceNavigationSubscription | null>(null);
const WorkspaceFileNavigationContext = React.createContext<Readonly<{ canOpen: boolean; phone: boolean }>>({ canOpen: false, phone: false });
/** The target the active workspace presents in its focused group, with the catalog that resolves it. */
export type WorkspaceFocusedRoute = Readonly<{ target: DestinationRef; catalog: readonly CompactAppDestination[] }>;
const WorkspaceFocusedRouteContext = React.createContext<WorkspaceFocusedRoute | null>(null);
type WorkspaceFocusedRouteStore = Readonly<{ getSnapshot(): WorkspaceFocusedRoute | null; subscribe(listener: () => void): () => void }>;
/** The same focused route as a store, so a reader can select one fact of it (see `useWorkspaceFocusedRouteSelector`). */
const WorkspaceFocusedRouteStoreContext = React.createContext<WorkspaceFocusedRouteStore | null>(null);
/** The focused target's path alone: params-only updates keep this value, so path readers do not render. */
const WorkspaceFocusedPathnameContext = React.createContext<string | null>(null);
const WorkspaceSectionPathnameContext = React.createContext<string | null>(null);
const NO_CATALOG: readonly CompactAppDestination[] = Object.freeze([]);
/**
 * Stable navigation operations for the app router. Tab state, titles, history and sync status are
 * invocation-time facts read through `read`, so a publication does not re-render every router caller.
 */
export type WorkspaceRouterFacts = Readonly<Pick<WorkspaceNavigationContextValue, 'active' | 'openHref' | 'navigationForTab' | 'back'>
    & {
        /** Rows that open destinations resolve against this; it moves only with the catalog itself. */
        catalog: readonly CompactAppDestination[];
        hasPhone: boolean;
        read: () => WorkspaceNavigationContextValue;
    }>;
const WorkspaceRouterFactsContext = React.createContext<WorkspaceRouterFacts | null>(null);

/** The lifecycle owner pushes placement and admitted transfer changes; consumers project the same membership. */
export function useWorkspacePresentationVisibility(desktop: WorkspaceNavigationContextValue['desktopPresentation']): WorkspacePresentationVisibility {
    const placedTabs = React.useSyncExternalStore(subscribeDesktopAppWindows, getDesktopAppWindowPlacedTabs, getDesktopAppWindowPlacedTabs);
    const transferringTabIds = React.useSyncExternalStore(subscribeDesktopAppWindowTransfers, getDesktopAppWindowTransfers, getDesktopAppWindowTransfers);
    return React.useMemo(() => ({ placedTabs, transferringTabIds, scope: desktop, windowId: desktop?.windowId }),
        [desktop, placedTabs, transferringTabIds]);
}

/** Stable navigation capability facts for frequently mounted file-link consumers and the app shell. */
export function WorkspaceNavigationProvider(props: React.PropsWithChildren<{
    value: WorkspaceNavigationContextValue;
    /** The router's own path, republished for readers while no workspace tab is focused. */
    routePathname?: string;
    /** Mounted pages' published titles; a change reaches title readers only. */
    destinationTitles?: WorkspaceDestinationTitles;
}>) {
    const latest = React.useRef(props.value);
    latest.current = props.value;
    const [listeners] = React.useState(() => new Set<() => void>());
    const [subscription] = React.useState<WorkspaceNavigationSubscription>(() => ({
        getSnapshot: () => latest.current,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }));
    React.useLayoutEffect(() => { for (const listener of listeners) listener(); }, [listeners, props.value]);
    const canOpen = props.value.active || props.value.ownsRoute === true || Boolean(props.value.phone);
    const phone = Boolean(props.value.phone);
    const capabilities = React.useMemo(() => ({ canOpen, phone }), [canOpen, phone]);
    const { state } = props.value;
    const presentation = useWorkspacePresentationVisibility(props.value.desktopPresentation);
    const group = state.groups[state.focusedGroupId];
    const activeTabId = group ? selectWorkspaceVisibleGroup(state, group, presentation).activeTabId : '';
    const focusedTarget = props.value.active ? state.tabs[activeTabId]?.target ?? null : null;
    const catalog = props.value.catalog ?? NO_CATALOG;
    // Tab, title, history and sync publications keep this identity unless the focused target moves.
    const focusedRoute = React.useMemo(() => focusedTarget ? { target: focusedTarget, catalog } : null, [catalog, focusedTarget]);
    const tabPathname = React.useMemo(() => focusedRoute
        ? hrefForDestinationRef(focusedRoute.catalog, focusedRoute.target)?.split(/[?#]/, 1)[0] ?? '' : null, [focusedRoute]);
    const focusedPathname = tabPathname ?? props.routePathname ?? null;
    const focusedRouteRef = React.useRef(focusedRoute);
    focusedRouteRef.current = focusedRoute;
    const [focusedRouteListeners] = React.useState(() => new Set<() => void>());
    const [focusedRouteStore] = React.useState<WorkspaceFocusedRouteStore>(() => ({
        getSnapshot: () => focusedRouteRef.current,
        subscribe(listener) { focusedRouteListeners.add(listener); return () => { focusedRouteListeners.delete(listener); }; },
    }));
    React.useLayoutEffect(() => { for (const listener of focusedRouteListeners) listener(); }, [focusedRouteListeners, focusedRoute]);
    const { active, openHref, navigationForTab } = props.value;
    // `back` is rebuilt per publication; the facts delegate to the latest one so their identity follows capabilities only.
    const routerFacts = React.useMemo<WorkspaceRouterFacts>(() => ({ active, openHref, navigationForTab, catalog, hasPhone: phone,
        back: () => latest.current.back(), read: () => latest.current }),
        [active, catalog, navigationForTab, openHref, phone]);
    return <WorkspaceNavigationContext.Provider value={subscription}>
        <WorkspaceSectionPathnameContext.Provider value={canOpen ? props.value.sectionPathname ?? null : null}>
        <WorkspaceRouterFactsContext.Provider value={routerFacts}>
            <WorkspaceFocusedRouteStoreContext.Provider value={focusedRouteStore}>
            <WorkspaceFocusedRouteContext.Provider value={focusedRoute}>
                <WorkspaceFocusedPathnameContext.Provider value={focusedPathname}>
                    <WorkspaceFileNavigationContext.Provider value={capabilities}>
                        <WorkspaceDestinationTitlesContext.Provider value={props.destinationTitles ?? NO_DESTINATION_TITLES}>{props.children}</WorkspaceDestinationTitlesContext.Provider>
                    </WorkspaceFileNavigationContext.Provider>
                </WorkspaceFocusedPathnameContext.Provider>
            </WorkspaceFocusedRouteContext.Provider>
            </WorkspaceFocusedRouteStoreContext.Provider>
        </WorkspaceRouterFactsContext.Provider>
        </WorkspaceSectionPathnameContext.Provider>
    </WorkspaceNavigationContext.Provider>;
}

export function useWorkspaceRouterFacts(): WorkspaceRouterFacts | null {
    return React.useContext(WorkspaceRouterFactsContext);
}

export function useWorkspaceSectionPathname(): string | null {
    return React.useContext(WorkspaceSectionPathnameContext);
}

/** Mounted pages' published titles by tab id. Renders when a title changes, and only then. */
export function useWorkspaceDestinationTitles(): WorkspaceDestinationTitles {
    return React.useContext(WorkspaceDestinationTitlesContext);
}

/** The active workspace's focused route, or null when the workspace does not host the current route. */
export function useWorkspaceFocusedRoute(): WorkspaceFocusedRoute | null {
    return React.useContext(WorkspaceFocusedRouteContext);
}

const subscribeNoFocusedRoute = () => () => {};
/**
 * One selected fact of the focused route. The reader renders only when its selection changes (shallowly),
 * not on every write to the focused target (a Store query keystroke).
 */
export function useWorkspaceFocusedRouteSelector<T>(select: (route: WorkspaceFocusedRoute | null) => T): T {
    const store = React.useContext(WorkspaceFocusedRouteStoreContext);
    const getSnapshot = React.useMemo(() => {
        let previous: Readonly<{ value: T }> | undefined;
        return () => {
            const next = select(store?.getSnapshot() ?? null);
            if (!previous || !shallow(previous.value, next)) previous = { value: next };
            return previous.value;
        };
    }, [select, store]);
    return React.useSyncExternalStore(store?.subscribe ?? subscribeNoFocusedRoute, getSnapshot, getSnapshot);
}

/** The path readers follow: the focused tab's, else the router's. Null only where no workspace provider exists. */
export function useWorkspaceFocusedPathname(): string | null {
    return React.useContext(WorkspaceFocusedPathnameContext);
}

/** Whether the workspace hosts the current route; tab, title and history changes do not reach this reader. */
export function useWorkspaceNavigationActive(): boolean {
    return useOptionalWorkspaceNavigation(value => value?.active === true);
}

export function useWorkspaceFileNavigationCapabilities() {
    return React.useContext(WorkspaceFileNavigationContext);
}

const subscribeNoWorkspace = () => () => {};
const identityWorkspace = (value: WorkspaceNavigationContextValue | null) => value;

export function useOptionalWorkspaceNavigation(): WorkspaceNavigationContextValue | null;
export function useOptionalWorkspaceNavigation<T>(select: (value: WorkspaceNavigationContextValue | null) => T): T;
export function useOptionalWorkspaceNavigation<T>(select?: (value: WorkspaceNavigationContextValue | null) => T) {
    const subscription = React.useContext(WorkspaceNavigationContext);
    const getSnapshot = React.useCallback(() => (select ?? identityWorkspace)(subscription?.getSnapshot() ?? null), [select, subscription]);
    return React.useSyncExternalStore(subscription?.subscribe ?? subscribeNoWorkspace, getSnapshot, getSnapshot);
}
