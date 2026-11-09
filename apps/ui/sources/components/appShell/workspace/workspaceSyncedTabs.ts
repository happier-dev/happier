import type { WorkspaceTabsV1 } from '@happier-dev/protocol/workspace/workspaceTabsV1';
import { createWorkspaceEmptyTab, reduceWorkspaceState, type WorkspaceAction, type WorkspaceState, type WorkspaceTab } from './workspaceState';
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
    let order = [...record.order];
    let pairs = record.pairs;
    for (const intent of intents) {
        switch (intent.type) {
            case 'open':
                if (!tabsById[intent.tab.id]) { tabsById[intent.tab.id] = intent.tab; order.push(intent.tab.id); }
                break;
            case 'close':
                delete tabsById[intent.tabId];
                order = order.filter(id => id !== intent.tabId);
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
                order = order.filter(id => id !== intent.tabId);
                // The ordinary insertion fallback for a closed anchor is append.
                const index = intent.beforeId === null ? -1 : order.indexOf(intent.beforeId);
                order.splice(index < 0 ? order.length : index, 0, intent.tabId);
                break;
            case 'pairs': pairs = intent.pairs; break;
        }
    }
    pairs = pruneWorkspaceTabPairs(pairs, tabsById);
    const result: SharedWorkspaceTabs = { v: 1, tabsById, order, pairs };
    return same(result, record) ? record : result;
}

export function collectWorkspaceTabIntents(before: WorkspaceState, after: WorkspaceState, action?: WorkspaceAction): WorkspaceTabIntent[] {
    if (before === after) return [];
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

/** Import membership through the reducer; focus, surviving geometry and previews stay local. */
export function reconcileWorkspaceSyncedTabs(state: WorkspaceState, record: SharedWorkspaceTabs, createId: () => string): WorkspaceState {
    let next = state;
    for (const tab of Object.values(state.tabs)) {
        if (!intentional(tab) || record.tabsById[tab.id]) continue;
        const group = Object.values(next.groups).find(group => group.tabIds.includes(tab.id));
        // Shared membership is not presentation authority. A remote close may
        // retire a background tab, but cannot replace a device's visible pane.
        // Keep its existing instance until local navigation leaves it; importing
        // this record produces no open intent or write back to the shared set.
        if (group?.activeTabId === tab.id) continue;
        if (group) next = reduceWorkspaceState(next, { type: 'closeTab', groupId: group.id, tabId: tab.id, newTab: createWorkspaceEmptyTab(createId()), remember: false });
    }
    for (const id of record.order) {
        const shared = record.tabsById[id];
        const existing = next.tabs[id];
        if (!existing) next = reduceWorkspaceState(next, { type: 'openTab', groupId: next.focusedGroupId, tab: { ...shared, preview: false } });
        else {
            // An already-open destination belongs to this window. In particular,
            // singleton Workflows route params may name a consumed local handoff;
            // another client's navigation must not replace that mounted document.
            if (existing.pinned !== shared.pinned) next = reduceWorkspaceState(next, { type: 'setPinned', tabId: id, pinned: shared.pinned });
            if (existing.preview) next = reduceWorkspaceState(next, { type: 'promoteTab', tabId: id });
        }
    }
    const groups = { ...next.groups };
    for (const group of Object.values(next.groups)) {
        const sharedIds = record.order.filter(id => group.tabIds.includes(id));
        // Shared order fills the existing shared slots; previews and empty tabs keep
        // their device-local positions. New remote tabs precede trailing local tabs.
        const tabIds = group.tabIds.filter(id => !record.tabsById[id] || state.tabs[id]);
        let sharedIndex = 0;
        let insertionIndex = 0;
        for (let index = 0; index < tabIds.length; index++) {
            if (!record.tabsById[tabIds[index]]) continue;
            tabIds[index] = sharedIds[sharedIndex++];
            insertionIndex = index + 1;
        }
        tabIds.splice(insertionIndex, 0, ...sharedIds.slice(sharedIndex));
        const old = state.groups[group.id];
        const activeTabId = old && tabIds.includes(old.activeTabId) ? old.activeTabId : group.activeTabId;
        const mru = [...(old?.mru ?? group.mru).filter(id => tabIds.includes(id)), ...tabIds.filter(id => !(old?.mru ?? group.mru).includes(id))];
        if (!same(tabIds, group.tabIds) || activeTabId !== group.activeTabId || !same(mru, group.mru)) groups[group.id] = { ...group, tabIds, activeTabId, mru };
    }
    const focusedGroupId = groups[state.focusedGroupId] ? state.focusedGroupId : next.focusedGroupId;
    const maximizedGroupId = state.maximizedGroupId && groups[state.maximizedGroupId] ? state.maximizedGroupId : null;
    const tabPairs = same(state.tabPairs, record.pairs) ? state.tabPairs : record.pairs;
    const result = { ...next, groups, focusedGroupId, maximizedGroupId, tabPairs };
    return same(result, state) ? state : result;
}
