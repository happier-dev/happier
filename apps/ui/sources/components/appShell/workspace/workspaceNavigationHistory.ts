import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { reduceWorkspaceState, sameDestinationRef, type WorkspaceAction, type WorkspaceState } from './workspaceState';

export type WorkspaceNavigationEntry = Readonly<{
    tabId: string;
    groupId: string;
    target: DestinationRef;
}>;

export type WorkspaceNavigationHistory = Readonly<{
    entries: readonly WorkspaceNavigationEntry[];
    index: number;
}>;

export function createWorkspaceNavigationHistory(): WorkspaceNavigationHistory {
    return { entries: [], index: -1 };
}

export function recordWorkspaceNavigation(
    history: WorkspaceNavigationHistory,
    entry: WorkspaceNavigationEntry,
): WorkspaceNavigationHistory {
    const current = history.entries[history.index];
    if (current
        && current.tabId === entry.tabId
        && current.groupId === entry.groupId
        && sameDestinationRef(current.target, entry.target)) {
        return history;
    }
    const entries = [...history.entries.slice(0, history.index + 1), entry];
    return { entries, index: entries.length - 1 };
}

export function stepWorkspaceNavigation(
    history: WorkspaceNavigationHistory,
    direction: -1 | 1,
): Readonly<{ history: WorkspaceNavigationHistory; entry: WorkspaceNavigationEntry | null }> {
    const index = history.index + direction;
    const entry = history.entries[index];
    return entry
        ? { history: { ...history, index }, entry }
        : { history, entry: null };
}

/** Apply one visited entry to the layout. History stays ephemeral; the layout stores only current targets. */
export function workspaceNavigationRestorationActions(
    state: WorkspaceState,
    entry: WorkspaceNavigationEntry,
): readonly WorkspaceAction[] {
    const existingGroup = Object.values(state.groups).find((group) => group.tabIds.includes(entry.tabId));
    const groupId = existingGroup?.id
        ?? (state.groups[entry.groupId] ? entry.groupId : state.focusedGroupId);
    if (!state.groups[groupId]) return [];

    if (!existingGroup) {
        return [{
            type: 'openTab', groupId,
            tab: { id: entry.tabId, target: entry.target, pinned: false, preview: true },
        }];
    }
    return [
        { type: 'setTarget', tabId: entry.tabId, target: entry.target },
        { type: 'activateTab', groupId, tabId: entry.tabId },
    ];
}

export function restoreWorkspaceNavigationEntry(state: WorkspaceState, entry: WorkspaceNavigationEntry): WorkspaceState {
    return workspaceNavigationRestorationActions(state, entry).reduce(reduceWorkspaceState, state);
}
