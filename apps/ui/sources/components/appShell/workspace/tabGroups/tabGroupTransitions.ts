export type TabGroupState = Readonly<{
    id: string;
    tabIds: readonly string[];
    activeTabId: string | null;
    mru: readonly string[];
}>;

export type GroupTabState = Readonly<{
    id: string;
    pinned: boolean;
    preview: boolean;
}>;

function recentTabs(group: TabGroupState): string[] {
    const seen = new Set<string>();
    return [group.activeTabId, ...group.mru, ...group.tabIds.slice().reverse()]
        .filter((id): id is string => id != null && group.tabIds.includes(id))
        .filter((id) => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
}

export function activateGroupTab(group: TabGroupState, tabId: string): TabGroupState {
    if (!group.tabIds.includes(tabId)) return group;
    const mru = [tabId, ...recentTabs(group).filter((id) => id !== tabId)];
    if (group.activeTabId === tabId && mru.length === group.mru.length && mru.every((id, index) => id === group.mru[index])) {
        return group;
    }
    return { ...group, activeTabId: tabId, mru };
}

export function reorderGroupTab(group: TabGroupState, tabId: string, beforeTabId: string | null): TabGroupState {
    if (!group.tabIds.includes(tabId) || tabId === beforeTabId) return group;
    const tabIds = group.tabIds.filter((id) => id !== tabId);
    const anchorIndex = beforeTabId === null ? -1 : tabIds.indexOf(beforeTabId);
    tabIds.splice(anchorIndex < 0 ? tabIds.length : anchorIndex, 0, tabId);
    return tabIds.every((id, index) => id === group.tabIds[index]) ? group : { ...group, tabIds };
}

export function insertGroupTab(group: TabGroupState, tabId: string, beforeTabId?: string | null): TabGroupState {
    const inserted = group.tabIds.includes(tabId) ? group : { ...group, tabIds: [...group.tabIds, tabId] };
    return activateGroupTab(beforeTabId === undefined ? inserted : reorderGroupTab(inserted, tabId, beforeTabId), tabId);
}

export function closeGroupTab(group: TabGroupState, tabId: string): TabGroupState {
    if (!group.tabIds.includes(tabId)) return group;
    const tabIds = group.tabIds.filter((id) => id !== tabId);
    const mru = recentTabs(group).filter((id) => id !== tabId);
    return {
        ...group,
        tabIds,
        activeTabId: group.activeTabId === tabId ? (mru[0] ?? null) : group.activeTabId,
        mru,
    };
}

export function replaceGroupTabId(group: TabGroupState, oldId: string, newId: string): TabGroupState {
    if (!group.tabIds.includes(oldId)) return group;
    const seen = new Set<string>();
    const tabIds = group.tabIds.flatMap((id) => {
        const nextId = id === oldId ? newId : id;
        if (seen.has(nextId)) return [];
        seen.add(nextId);
        return [nextId];
    });
    const mru = recentTabs(group).map((id) => id === oldId ? newId : id)
        .filter((id, index, values) => values.indexOf(id) === index);
    return {
        ...group,
        tabIds,
        activeTabId: group.activeTabId === oldId ? newId : group.activeTabId,
        mru,
    };
}

export function removeGroupPreviewTabs<TTab extends GroupTabState>(
    group: TabGroupState,
    tabsById: Readonly<Record<string, TTab>>,
    exceptTabId?: string,
): Readonly<{ group: TabGroupState; removedTabIds: readonly string[] }> {
    const removedTabIds = group.tabIds.filter((id) => id !== exceptTabId && Object.hasOwn(tabsById, id) && tabsById[id]?.preview === true);
    let nextGroup = group;
    for (const id of removedTabIds) nextGroup = closeGroupTab(nextGroup, id);
    return { group: nextGroup, removedTabIds };
}

export function moveGroupTab<TTab extends GroupTabState>(
    source: TabGroupState,
    target: TabGroupState,
    tab: TTab,
    tabsById: Readonly<Record<string, TTab>>,
    beforeTabId?: string | null,
): Readonly<{ source: TabGroupState; target: TabGroupState; replacedPreviewTabIds: readonly string[] }> {
    if (!source.tabIds.includes(tab.id)) {
        return { source, target, replacedPreviewTabIds: [] };
    }
    if (source.id === target.id) {
        const reordered = beforeTabId === undefined ? target : reorderGroupTab(target, tab.id, beforeTabId);
        const activated = activateGroupTab(reordered, tab.id);
        return { source: activated, target: activated, replacedPreviewTabIds: [] };
    }
    const previewResult = tab.preview
        ? removeGroupPreviewTabs(target, tabsById)
        : { group: target, removedTabIds: [] };
    return {
        source: closeGroupTab(source, tab.id),
        target: insertGroupTab(previewResult.group, tab.id, beforeTabId),
        replacedPreviewTabIds: previewResult.removedTabIds,
    };
}

export function setGroupTabPinned(tab: GroupTabState, pinned: boolean): GroupTabState {
    if (tab.pinned === pinned && tab.preview === !pinned) return tab;
    return { ...tab, pinned, preview: !pinned };
}
