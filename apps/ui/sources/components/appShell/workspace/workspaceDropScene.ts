import { readDestinationInstanceTitle, type CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { PaneDropScene } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import type { WorkspaceState } from './workspaceState';

/** A workspace tab's name as its tab shows it: the live instance title, else the title saved with the layout. */
export function readWorkspaceTabTitle(state: WorkspaceState, catalog: readonly CompactAppDestination[], tabId: string): string | null {
    const tab = state.tabs[tabId];
    if (!tab) return null;
    return readDestinationInstanceTitle(catalog, tab.target) ?? state.fallbackTitlesByTabId[tabId] ?? null;
}

/** What a workspace pane drop is worded against: the hovered pane's open tab and where tabs live. */
export function createWorkspaceDropScene(state: WorkspaceState, catalog: readonly CompactAppDestination[], input: Readonly<{
    paneId: string;
    beforeTabId?: string | null;
    declinedSplit?: boolean;
}>): PaneDropScene {
    const group = state.groups[input.paneId];
    return {
        paneId: input.paneId,
        paneTitle: group ? readWorkspaceTabTitle(state, catalog, group.activeTabId) : null,
        ...(input.beforeTabId === undefined ? {} : { beforeTabId: input.beforeTabId }),
        ...(input.declinedSplit ? { declinedSplit: true } : {}),
        locateTab: tabId => {
            const owner = Object.values(state.groups).find(candidate => candidate.tabIds.includes(tabId));
            const title = owner ? readWorkspaceTabTitle(state, catalog, tabId) : null;
            return owner && title ? { paneId: owner.id, title } : null;
        },
    };
}
