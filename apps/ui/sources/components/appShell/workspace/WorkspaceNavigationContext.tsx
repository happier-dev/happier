import * as React from 'react';
import type { WorkspaceOpenOptions, WorkspaceOpenDestination } from './workspaceNavigationAdapter';
import type { WorkspaceAction, WorkspaceState, WorkspacePresentationVisibility } from './workspaceState';
import { getDesktopAppWindowPlacedTabs, getDesktopAppWindowTransfers, subscribeDesktopAppWindows, subscribeDesktopAppWindowTransfers } from '@/desktop/window/appWindowRuntime';
import type { DestinationNavigation } from './DestinationInstanceHost';
import type { SplitCanvasHostControls } from '../splitCanvas/components/SplitCanvasHost';
import type { SharedWorkspaceTabs } from './workspaceSyncedTabs';
import type { WorkspaceTabSyncStatus } from './useWorkspaceTabSync';
import type { WorkspaceTabsHandoffSource } from './workspaceTabsHandoff';
import type { CompactAppDestination, DestinationRef } from '../destinations/compactAppDestinationCatalog';

export type WorkspaceDestinationTitle = Readonly<{
    ref: DestinationRef;
    title: string | null;
    /** An automatic collection landing keeps the collection's chrome identity until explicit navigation. */
    redirectSource?: DestinationRef;
}>;

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
    /** The admitted route belongs here even while its retained workspace is hydrating. */
    ownsRoute?: boolean;
    /** Present only on a phone, where the workspace owns the tab set but not navigation. */
    phone?: WorkspacePhoneControls | null;
    state: WorkspaceState;
    /** Current native presentation realm; global records remain scoped to their Home and Account. */
    desktopPresentation?: Readonly<{ serverId: string; accountId: string; windowId?: string; layoutId?: string }>;
    catalog?: readonly CompactAppDestination[];
    /** Current mounted screen identities, local to this owner and never persisted. */
    destinationTitles?: Readonly<Record<string, WorkspaceDestinationTitle>>;
    publishDestinationTitle?: (tabId: string, ref: DestinationRef, title: string | null) => () => void;
    sharedTabs?: SharedWorkspaceTabs | null;
    tabSyncStatus?: WorkspaceTabSyncStatus;
    handoffSource?: WorkspaceTabsHandoffSource | null;
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

export const WorkspaceNavigationContext = React.createContext<WorkspaceNavigationContextValue | null>(null);
const NO_CATALOG: readonly CompactAppDestination[] = Object.freeze([]);
const WorkspaceFileNavigationContext = React.createContext<Readonly<{ canOpen: boolean; phone: boolean }>>({ canOpen: false, phone: false });

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

/** Stable navigation capability facts for frequently mounted file-link consumers. */
export function WorkspaceNavigationProvider(props: React.PropsWithChildren<{ value: WorkspaceNavigationContextValue }>) {
    const latest = React.useRef(props.value);
    latest.current = props.value;
    const canOpen = props.value.active || props.value.ownsRoute === true || Boolean(props.value.phone);
    const phone = Boolean(props.value.phone);
    const capabilities = React.useMemo(() => ({ canOpen, phone }), [canOpen, phone]);
    const catalog = props.value.catalog ?? NO_CATALOG;
    const { active, openHref, navigationForTab } = props.value;
    // `back` is rebuilt per publication; the facts delegate to the latest one so their identity follows capabilities only.
    const routerFacts = React.useMemo<WorkspaceRouterFacts>(() => ({ active, openHref, navigationForTab, catalog, hasPhone: phone,
        back: () => latest.current.back(), read: () => latest.current }),
        [active, catalog, navigationForTab, openHref, phone]);
    return <WorkspaceNavigationContext.Provider value={props.value}>
        <WorkspaceRouterFactsContext.Provider value={routerFacts}>
        <WorkspaceFileNavigationContext.Provider value={capabilities}>{props.children}</WorkspaceFileNavigationContext.Provider>
        </WorkspaceRouterFactsContext.Provider>
    </WorkspaceNavigationContext.Provider>;
}

export function useWorkspaceRouterFacts(): WorkspaceRouterFacts | null {
    return React.useContext(WorkspaceRouterFactsContext);
}

export function useWorkspaceFileNavigationCapabilities() {
    return React.useContext(WorkspaceFileNavigationContext);
}

export function useOptionalWorkspaceNavigation(): WorkspaceNavigationContextValue | null {
    return React.useContext(WorkspaceNavigationContext);
}
