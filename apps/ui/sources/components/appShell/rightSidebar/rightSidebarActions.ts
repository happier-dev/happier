import * as React from 'react';
import type { RightPaneHiddenByDetails } from '@/components/appShell/panes/PaneActionRailContext';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolveRightSidebarTabPlacement, type RightSidebarBuiltinTabDefinition, type RightSidebarTabPlacementContext } from './rightSidebarTabRegistry';

export type RightSidebarActions = Readonly<{
    tabs: readonly string[];
    activeTab?: string;
    selectTab(tab: string): void;
}>;

/** Select through the same pane state while presenting session context beside its composer. */
export function openRightSidebarBuiltinTab(
    pane: Pick<AppPaneScopeApi, 'openRight'>,
    tab: RightSidebarBuiltinTabDefinition,
    context: RightSidebarTabPlacementContext,
    showMain: () => void,
): void {
    if (resolveRightSidebarTabPlacement(tab, context) === 'main') {
        pane.openRight({ tabId: tab.id, present: false });
        showMain();
    } else {
        pane.openRight({ tabId: tab.id });
    }
}

/** The mounted rail publishes its existing catalog and chooser to its enclosing pane host. */
export const RightSidebarActionsContext = React.createContext<React.MutableRefObject<RightSidebarActions | null> | null>(null);

const tabListeners = new WeakMap<object, Set<() => void>>();

function notifySidebarTabs(owner: object | null): void {
    for (const listener of owner ? tabListeners.get(owner) ?? [] : []) listener();
}

/** Whether this scope publishes the tab, independently of the rail's current presentation. */
export function useRightSidebarTabAvailable(tabId: string): boolean {
    const owner = React.useContext(RightSidebarActionsContext);
    const subscribe = React.useCallback((listener: () => void) => {
        if (!owner) return () => {};
        const listeners = tabListeners.get(owner) ?? new Set<() => void>();
        tabListeners.set(owner, listeners);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, [owner]);
    const read = React.useCallback(() => owner?.current?.tabs.includes(tabId) === true, [owner, tabId]);
    return React.useSyncExternalStore(subscribe, read, () => false);
}

export function usePublishRightSidebarActions(actions: RightSidebarActions): void {
    const owner = React.useContext(RightSidebarActionsContext);
    const latest = React.useRef(actions);
    latest.current = actions;
    React.useLayoutEffect(() => {
        if (!owner) return;
        const publication: RightSidebarActions = {
            get tabs() { return latest.current.tabs; },
            get activeTab() { return latest.current.activeTab; },
            selectTab: tab => latest.current.selectTab(tab),
        };
        owner.current = publication;
        return () => {
            if (owner.current !== publication) return;
            owner.current = null;
            notifySidebarTabs(owner);
        };
    }, [owner]);
    React.useLayoutEffect(() => notifySidebarTabs(owner), [owner, actions.tabs]);
}

export function toggleRightSidebarTab(
    pane: Pick<AppPaneScopeApi, 'scopeState' | 'closeRight' | 'closeDetails'>,
    tabId: string,
    activeTabId: string | null,
    onSelectTab: (tabId: string) => void,
    rightPaneHiddenByDetails: RightPaneHiddenByDetails = false,
    placement: 'main' | 'side' = 'side',
): void {
    if (placement === 'side' && rightPaneHiddenByDetails) {
        // A folded column opens beside Details (it becomes the drawer); a covered one needs it gone.
        if (rightPaneHiddenByDetails === true) pane.closeDetails();
        onSelectTab(tabId);
    } else if (pane.scopeState?.right.isOpen && activeTabId === tabId) {
        pane.closeRight();
    } else {
        onSelectTab(tabId);
    }
}
