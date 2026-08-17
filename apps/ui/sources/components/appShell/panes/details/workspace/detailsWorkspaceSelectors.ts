import {
    listDetailsWorkspaceGroupIds,
} from './detailsWorkspaceSplitCanvas';
import {
    getOwnDetailsWorkspaceRecordEntry,
} from './detailsWorkspaceTypes';
import type {
    DetailsWorkspaceGroupView,
    PaneDetailsState,
    PaneDetailsStateView,
} from './detailsWorkspaceTypes';

function getFocusedGroupId(details: PaneDetailsState): string | null {
    if (
        details.focusedGroupId
        && getOwnDetailsWorkspaceRecordEntry(details.groupsById, details.focusedGroupId)
    ) {
        return details.focusedGroupId;
    }
    const groupIds = listDetailsWorkspaceGroupIds(details.root);
    return groupIds[0] ?? null;
}

function buildGroupView(
    details: PaneDetailsState,
    groupId: string,
    focusedGroupId: string | null,
): DetailsWorkspaceGroupView | null {
    const group = getOwnDetailsWorkspaceRecordEntry(details.groupsById, groupId);
    if (!group) return null;
    const tabs = group.tabKeys
        .map((tabKey) => getOwnDetailsWorkspaceRecordEntry(details.tabsByKey, tabKey) ?? null)
        .filter((tab): tab is NonNullable<typeof tab> => tab != null);
    const activeTabKey = group.activeTabKey && tabs.some((tab) => tab.key === group.activeTabKey)
        ? group.activeTabKey
        : tabs.at(-1)?.key ?? null;
    return {
        id: group.id,
        tabKeys: tabs.map((tab) => tab.key),
        activeTabKey,
        tabs,
        isFocused: group.id === focusedGroupId,
    };
}

export function buildDetailsWorkspaceStateView(details: PaneDetailsState): PaneDetailsStateView {
    const focusedGroupId = getFocusedGroupId(details);
    const groupIds = listDetailsWorkspaceGroupIds(details.root);
    const groups = groupIds
        .map((groupId) => buildGroupView(details, groupId, focusedGroupId))
        .filter((group): group is NonNullable<typeof group> => group != null);
    const focusedGroup = groups.find((group) => group.id === focusedGroupId) ?? groups[0] ?? null;
    return {
        isOpen: details.isOpen,
        tabState: details.tabState,
        tabs: focusedGroup?.tabs ?? [],
        activeTabKey: focusedGroup?.activeTabKey ?? null,
        groups,
        root: details.root,
        focusedGroupId,
        maximizedGroupId: details.maximizedGroupId,
        overlay: details.overlay,
    };
}
