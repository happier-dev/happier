import type { WorkspaceState, WorkspaceTab } from './workspaceState';
import {
    hrefForDestinationRef, resolveDestinationRefFromHref, SEARCH_DESTINATION_ID, SESSIONS_DESTINATION_ID, type CompactAppDestination,
} from '../destinations/compactAppDestinationCatalog';
import { collectSplitCanvasLeaves } from '../splitCanvas/model/splitCanvasTree';

export type WorkspacePhoneTab = Readonly<{
    id: string;
    panes: readonly WorkspaceTab[];
    activeTabId: string;
}>;

/** A phone view of the same destination instances; pairs carry membership only. */
export function projectWorkspacePhoneTabs(
    state: WorkspaceState,
    pairs: readonly (readonly string[])[] = state.tabPairs,
): readonly WorkspacePhoneTab[] {
    const orderedIds = collectSplitCanvasLeaves(state.root).flatMap((leaf) => state.groups[leaf.payload.groupId]?.tabIds ?? []);
    const liveIds = new Set(orderedIds);
    const membership = new Map<string, readonly string[]>();
    for (const pair of pairs) {
        const members = [...new Set(pair)].filter((id) => liveIds.has(id) && !membership.has(id));
        for (const id of members) membership.set(id, members);
    }
    const focusedTabId = state.groups[state.focusedGroupId]?.activeTabId;
    const emitted = new Set<string>();
    return orderedIds.flatMap((id) => {
        if (emitted.has(id)) return [];
        const memberIds = membership.get(id) ?? [id];
        const panes = memberIds.flatMap((member) => state.tabs[member] ? [state.tabs[member]] : []);
        for (const member of memberIds) emitted.add(member);
        if (panes.length === 0) return [];
        return [{ id: panes[0].id, panes,
            activeTabId: focusedTabId && memberIds.includes(focusedTabId) ? focusedTabId : panes[0].id }];
    });
}

/**
 * The phone's own main tabs: they are where tabs are opened from, never tabs themselves. Read at call
 * time: the catalog module sits in an import cycle with the workspace, so its constants may not be
 * initialized while this module evaluates.
 */
function isPhoneMainTabKind(kind: string): boolean {
    return kind === 'newTab' || kind === SESSIONS_DESTINATION_ID || kind === SEARCH_DESTINATION_ID
        || kind === 'inbox' || kind === 'projects' || kind === 'friends' || kind === 'settings';
}

/**
 * The tab a phone route shows, as the href the workspace keys it by, or null when the route is one of
 * the phone's main tabs. Explicit entity leaves retain their route and Home;
 * only the base Session's mobileSurface is device-local presentation.
 */
export function resolvePhoneWorkspaceTabHref(catalog: readonly CompactAppDestination[], href: string): string | null {
    let url: URL;
    try { url = new URL(href, 'https://happier.invalid'); } catch { return null; }
    const normalized = `${url.pathname}${url.search}${url.hash}`;
    const target = resolveDestinationRefFromHref(catalog, normalized);
    if (!target) return null;
    if (target.kind === 'session') {
        const { mobileSurface: _mobileSurface, ...params } = target.params;
        return hrefForDestinationRef(catalog, { ...target, params });
    }
    const entityLeaf = Boolean(target.params.workspacePathname && target.params.id);
    return !isPhoneMainTabKind(target.kind) || entityLeaf ? normalized : null;
}
