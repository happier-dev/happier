import type { WorkspaceTabsV1 } from '@happier-dev/protocol/workspace/workspaceTabsV1';
import type { WorkspaceAction, WorkspaceState, WorkspaceTab } from './workspaceState';
import { collectSplitCanvasLeaves } from '../splitCanvas/model/splitCanvasTree';

export type SharedWorkspaceTab = Readonly<WorkspaceTabsV1['tabsById'][string]>;
export type SharedWorkspaceTabs = Readonly<Omit<WorkspaceTabsV1, 'tabsById' | 'order' | 'pairs'> & {
    tabsById: Readonly<Record<string, SharedWorkspaceTab>>;
    order: readonly string[];
    pairs: readonly (readonly string[])[];
}>;
export type WorkspaceTabIntent =
    | Readonly<{ type: 'open'; tab: SharedWorkspaceTab }>
    | Readonly<{ type: 'close'; tabId: string }>
    | Readonly<{ type: 'patch'; tabId: string; target?: WorkspaceTab['target']; pinned?: boolean }>
    | Readonly<{ type: 'move'; tabId: string; beforeId: string | null }>
    | Readonly<{ type: 'pairs'; pairs: readonly (readonly string[])[] }>;

export function emptyWorkspaceTabs(): SharedWorkspaceTabs { return { v: 1, tabsById: {}, order: [], pairs: [] }; }

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function portable(tab: WorkspaceTab): SharedWorkspaceTab { return { id: tab.id, target: tab.target, pinned: tab.pinned }; }
function intentional(tab: WorkspaceTab): boolean { return !tab.preview && tab.target.kind !== 'newTab'; }

/** Only admitted live pairs reserve IDs; discarded singletons cannot block a later pair. */
export function pruneWorkspaceTabPairs(pairs: SharedWorkspaceTabs['pairs'], tabsById: SharedWorkspaceTabs['tabsById']): SharedWorkspaceTabs['pairs'] {
    const used = new Set<string>();
    const accepted: string[][] = [];
    for (const pair of pairs) {
        const members = [...new Set(pair)].filter(id => Boolean(tabsById[id]) && !used.has(id));
        if (members.length < 2) continue;
        accepted.push(members);
        for (const id of members) used.add(id);
    }
    return accepted;
}

export function projectWorkspaceSharedTabs(state: WorkspaceState, pairs: SharedWorkspaceTabs['pairs'] = state.tabPairs): SharedWorkspaceTabs {
    const order = collectSplitCanvasLeaves(state.root).flatMap(leaf => state.groups[leaf.payload.groupId].tabIds).filter(id => intentional(state.tabs[id]));
    const tabsById = Object.fromEntries(order.map(id => [id, portable(state.tabs[id])]));
    return { v: 1, tabsById, order, pairs: pruneWorkspaceTabPairs(pairs, tabsById) };
}

/** Replay only accepted edits, never infer a remote deletion from an older local snapshot. */
export function applyWorkspaceTabIntents(record: SharedWorkspaceTabs, intents: readonly WorkspaceTabIntent[]): SharedWorkspaceTabs {
    if (!intents.length) return record;
    const tabsById = { ...record.tabsById };
    // A reorder replays one move per tab, so order edits are O(1) each on a linked order, read back once.
    const order = createLinkedOrder(record.order);
    let pairs = record.pairs;
    for (const intent of intents) {
        switch (intent.type) {
            case 'open':
                if (!tabsById[intent.tab.id]) { tabsById[intent.tab.id] = intent.tab; order.insertBefore(intent.tab.id, null); }
                break;
            case 'close':
                delete tabsById[intent.tabId];
                order.remove(intent.tabId);
                break;
            case 'patch': {
                const tab = tabsById[intent.tabId];
                if (tab) tabsById[intent.tabId] = { ...tab,
                    ...(intent.target === undefined ? {} : { target: intent.target }),
                    ...(intent.pinned === undefined ? {} : { pinned: intent.pinned }),
                };
                break;
            }
            case 'move':
                if (!tabsById[intent.tabId] || intent.beforeId === intent.tabId) break;
                order.remove(intent.tabId);
                // The ordinary insertion fallback for a closed anchor is append.
                order.insertBefore(intent.tabId, intent.beforeId !== null && order.has(intent.beforeId) ? intent.beforeId : null);
                break;
            case 'pairs': pairs = intent.pairs; break;
        }
    }
    pairs = pruneWorkspaceTabPairs(pairs, tabsById);
    const result: SharedWorkspaceTabs = { v: 1, tabsById, order: order.read(), pairs };
    return same(result, record) ? record : result;
}

/** An order as a doubly linked list keyed by id; ids are unique, as in every shared order. */
function createLinkedOrder(ids: readonly string[]) {
    const previous = new Map<string, string | null>();
    const next = new Map<string, string | null>();
    let head: string | null = null;
    let tail: string | null = null;
    const insertBefore = (id: string, beforeId: string | null) => {
        const prior = beforeId === null ? tail : previous.get(beforeId)!;
        previous.set(id, prior);
        next.set(id, beforeId);
        if (prior === null) head = id; else next.set(prior, id);
        if (beforeId === null) tail = id; else previous.set(beforeId, id);
    };
    for (const id of ids) insertBefore(id, null);
    return {
        has: (id: string) => next.has(id),
        insertBefore,
        remove: (id: string) => {
            if (!next.has(id)) return;
            const prior = previous.get(id)!;
            const after = next.get(id)!;
            if (prior === null) head = after; else next.set(prior, after);
            if (after === null) tail = prior; else previous.set(after, prior);
            previous.delete(id);
            next.delete(id);
        },
        read: () => {
            const result: string[] = [];
            for (let id = head; id !== null; id = next.get(id)!) result.push(id);
            return result;
        },
    };
}

/**
 * Whether two states share every input of {@link projectWorkspaceSharedTabs}: the tab table, the pairs, and each
 * pane's member list in canvas order. A tab switch moves only the active tab and focus, so it projects nothing.
 */
function sameSharedTabInputs(before: WorkspaceState, after: WorkspaceState): boolean {
    if (before.tabs !== after.tabs || before.tabPairs !== after.tabPairs) return false;
    if (before.root === after.root && before.groups === after.groups) return true;
    const previous = collectSplitCanvasLeaves(before.root);
    const next = collectSplitCanvasLeaves(after.root);
    if (previous.length !== next.length) return false;
    for (let index = 0; index < next.length; index++) {
        const groupId = next[index]!.payload.groupId;
        if (previous[index]!.payload.groupId !== groupId || before.groups[groupId]?.tabIds !== after.groups[groupId]?.tabIds) return false;
    }
    return true;
}

export function collectWorkspaceTabIntents(before: WorkspaceState, after: WorkspaceState, action?: WorkspaceAction): WorkspaceTabIntent[] {
    if (before === after || sameSharedTabInputs(before, after)) return [];
    const previous = projectWorkspaceSharedTabs(before);
    const next = projectWorkspaceSharedTabs(after);
    const intents: WorkspaceTabIntent[] = [];
    for (const id of previous.order) if (!next.tabsById[id]) intents.push({ type: 'close', tabId: id });
    for (const id of next.order) {
        const tab = next.tabsById[id];
        const prior = previous.tabsById[id];
        if (!prior) intents.push({ type: 'open', tab });
        else if (!same(prior, tab)) intents.push({ type: 'patch', tabId: id,
            ...(same(prior.target, tab.target) ? {} : { target: tab.target }),
            ...(prior.pinned === tab.pinned ? {} : { pinned: tab.pinned }),
        });
    }
    const replayOrder = applyWorkspaceTabIntents(previous, intents).order;
    if (!same(replayOrder, next.order)) {
        for (let index = next.order.length - 1; index >= 0; index--) {
            intents.push({ type: 'move', tabId: next.order[index], beforeId: next.order[index + 1] ?? null });
        }
    }
    if (!same(previous.pairs, next.pairs)) intents.push({ type: 'pairs', pairs: next.pairs });
    return intents;
}

/** Apply one shared record without replaying local navigation for each membership change. */
export function reconcileWorkspaceSyncedTabs(state: WorkspaceState, record: SharedWorkspaceTabs): WorkspaceState {
    let tabs: Record<string, WorkspaceTab> | undefined;
    let fallbackTitles: Record<string, string> | undefined;
    const groupByTabId = new Map<string, string>();
    for (const group of Object.values(state.groups)) {
        for (const id of group.tabIds) {
            const tab = state.tabs[id];
            // A remote close can retire a background tab, but the device still owns every visible pane.
            if (id !== group.activeTabId && intentional(tab) && !record.tabsById[id]) {
                delete (tabs ??= { ...state.tabs })[id];
                if (Object.hasOwn(state.fallbackTitlesByTabId, id)) {
                    delete (fallbackTitles ??= { ...state.fallbackTitlesByTabId })[id];
                }
            } else {
                groupByTabId.set(id, group.id);
            }
        }
    }

    const sharedIdsByGroup = new Map<string, string[]>();
    for (const id of record.order) {
        const shared = record.tabsById[id];
        const existing = state.tabs[id];
        if (!existing) (tabs ??= { ...state.tabs })[id] = { ...shared, preview: false };
        // The local destination and presentation stay with the mounted instance.
        else if (existing.preview || existing.pinned !== shared.pinned) {
            (tabs ??= { ...state.tabs })[id] = { ...existing, pinned: shared.pinned, preview: false };
        }
        const groupId = groupByTabId.get(id) ?? state.focusedGroupId;
        const ids = sharedIdsByGroup.get(groupId);
        if (ids) ids.push(id);
        else sharedIdsByGroup.set(groupId, [id]);
    }

    let groups: Record<string, WorkspaceState['groups'][string]> | undefined;
    for (const group of Object.values(state.groups)) {
        const sharedIds = sharedIdsByGroup.get(group.id) ?? [];
        // Shared order fills existing shared slots, then extends ahead of trailing device-local tabs.
        const tabIds = group.tabIds.filter(id => groupByTabId.has(id));
        let sharedIndex = 0;
        let insertionIndex = 0;
        for (let index = 0; index < tabIds.length; index++) {
            if (!record.tabsById[tabIds[index]]) continue;
            tabIds[index] = sharedIds[sharedIndex++];
            insertionIndex = index + 1;
        }
        if (sharedIndex < sharedIds.length) {
            tabIds.splice(insertionIndex, 0, ...sharedIds.slice(sharedIndex));
        }
        if (same(tabIds, group.tabIds)) continue;
        const keptTabIds = new Set(tabIds);
        const previousMruIds = new Set(group.mru);
        const mru = [...group.mru.filter(id => keptTabIds.has(id)), ...tabIds.filter(id => !previousMruIds.has(id))];
        (groups ??= { ...state.groups })[group.id] = { ...group, tabIds, mru: same(mru, group.mru) ? group.mru : mru };
    }
    const tabPairs = same(state.tabPairs, record.pairs) ? state.tabPairs : record.pairs;
    if (!tabs && !groups && tabPairs === state.tabPairs) return state;
    return { ...state, tabs: tabs ?? state.tabs, groups: groups ?? state.groups,
        fallbackTitlesByTabId: fallbackTitles ?? state.fallbackTitlesByTabId, tabPairs };
}
