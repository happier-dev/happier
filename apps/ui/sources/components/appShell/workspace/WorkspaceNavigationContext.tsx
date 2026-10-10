import * as React from 'react';
import type { WorkspaceOpenOptions, WorkspaceOpenDestination } from './workspaceNavigationAdapter';
import type { WorkspaceAction, WorkspaceState } from './workspaceState';
import type { DestinationNavigation } from './DestinationInstanceHost';
import type { SplitCanvasHostControls } from '../splitCanvas/components/SplitCanvasHost';
import type { SharedWorkspaceTabs } from './workspaceSyncedTabs';
import type { WorkspaceTabSyncStatus } from './useWorkspaceTabSync';
import type { WorkspaceTabsHandoffSource } from './workspaceTabsHandoff';
import type { CompactAppDestination } from '../destinations/compactAppDestinationCatalog';

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
    openHref: (href: string, mode: 'preview' | 'newTab') => boolean;
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
    catalog?: readonly CompactAppDestination[];
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

export function useOptionalWorkspaceNavigation(): WorkspaceNavigationContextValue | null {
    return React.useContext(WorkspaceNavigationContext);
}
