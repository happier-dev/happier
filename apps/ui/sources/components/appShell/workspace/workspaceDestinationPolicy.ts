import type { CompactAppDestination, DestinationRef } from '../destinations/compactAppDestinationCatalog';
import { pruneWorkspaceTabPairs, type SharedWorkspaceTabs } from './workspaceSyncedTabs';
import { createWorkspaceEmptyTab, reduceWorkspaceState, type WorkspaceState } from './workspaceState';
import { collectSplitCanvasLeaves } from '../splitCanvas/model/splitCanvasTree';

export function workspaceSingletonDestinationIds(catalog: readonly CompactAppDestination[]): readonly string[] {
    return catalog.filter(item => item.id === 'workflows' || (item.kind === 'plugin' && item.container === 'appPage')).map(item => item.id);
}

export function isWorkspaceSingletonDestination(catalog: readonly CompactAppDestination[], target: DestinationRef): boolean {
    return workspaceSingletonDestinationIds(catalog).includes(target.kind);
}

/** Identity of an admitted merge, also used to validate pending sync aliases. */
export function workspaceDestinationAdmissionIdentity(target: DestinationRef): string {
    if (target.kind !== 'workflow' && target.kind !== 'workflowRun') return target.kind;
    return JSON.stringify([target.kind, Object.keys(target.params).sort().map(key => [key, target.params[key]])]);
}

function destinationAdmissionKey(target: DestinationRef, singletonKinds: ReadonlySet<string>): string | null {
    if (singletonKinds.has(target.kind)) return workspaceDestinationAdmissionIdentity(target);
    // Workflow definitions and runs are separate destinations; only identical
    // references contract, retaining Home/Account and other route qualifiers.
    if ((target.kind === 'workflow' && target.params.id) || (target.kind === 'workflowRun' && target.params.runId)) {
        return workspaceDestinationAdmissionIdentity(target);
    }
    return null;
}

/** Navigation admission and portable CAS rebase share one catalog-owned singleton policy. */
export function normalizeWorkspaceSingletonTabs(record: SharedWorkspaceTabs, catalog: readonly CompactAppDestination[]): SharedWorkspaceTabs {
    const firstByDestination = new Map<string, string>();
    const singletonKinds = new Set(workspaceSingletonDestinationIds(catalog));
    const retiredIds = new Map<string, string>();
    const tabsById = { ...record.tabsById };
    const order: string[] = [];
    let changed = false;
    for (const id of record.order) {
        const tab = record.tabsById[id];
        const key = destinationAdmissionKey(tab.target, singletonKinds);
        const first = key === null ? undefined : firstByDestination.get(key);
        if (first) {
            tabsById[first] = { ...tab, id: first };
            delete tabsById[id];
            retiredIds.set(id, first);
            changed = true;
        } else {
            if (key !== null) firstByDestination.set(key, id);
            order.push(id);
        }
    }
    if (!changed) return record;
    const pairs = pruneWorkspaceTabPairs(record.pairs.map(pair => pair.map(id => retiredIds.get(id) ?? id)), tabsById);
    return { ...record, tabsById, order, pairs };
}

/** Local admission preserves disposition; remote sharing separately excludes previews. */
export function admitWorkspaceSingletonState(state: WorkspaceState, catalog: readonly CompactAppDestination[], createId: () => string): WorkspaceState {
    const order = collectSplitCanvasLeaves(state.root).flatMap(leaf => state.groups[leaf.payload.groupId].tabIds);
    const singletonKinds = new Set(workspaceSingletonDestinationIds(catalog));
    const intentionalPinByDestination = new Map<string, boolean>();
    const localTabs: SharedWorkspaceTabs = { v: 1, order, pairs: state.tabPairs,
        tabsById: Object.fromEntries(order.map(id => {
            const tab = state.tabs[id];
            const key = destinationAdmissionKey(tab.target, singletonKinds);
            if (!tab.preview && key !== null) intentionalPinByDestination.set(key, tab.pinned);
            // A preview retarget preserves the intentional pin, just like a known singleton reopen.
            return [id, { id, target: tab.target, pinned: (key === null ? undefined : intentionalPinByDestination.get(key)) ?? tab.pinned }];
        })) };
    const normalized = normalizeWorkspaceSingletonTabs(localTabs, catalog);
    if (normalized === localTabs) return state;
    const retired = order.filter(id => !normalized.tabsById[id]);
    const focusedId = state.groups[state.focusedGroupId].activeTabId;
    const focusedKey = retired.includes(focusedId)
        ? destinationAdmissionKey(state.tabs[focusedId].target, singletonKinds) : null;
    const retainedFocusedId = focusedKey === null ? undefined : normalized.order.find(id =>
        destinationAdmissionKey(normalized.tabsById[id].target, singletonKinds) === focusedKey);
    const mergedStickyDestinations = new Set(retired.filter(id => !state.tabs[id].preview)
        .map(id => destinationAdmissionKey(state.tabs[id].target, singletonKinds)));
    let next = state;
    for (const id of normalized.order) {
        const tab = normalized.tabsById[id];
        next = reduceWorkspaceState(next, { type: 'setTarget', tabId: id, target: tab.target });
        if (next.tabs[id].pinned !== tab.pinned) next = reduceWorkspaceState(next, { type: 'setPinned', tabId: id, pinned: tab.pinned });
        if (next.tabs[id].preview && mergedStickyDestinations.has(destinationAdmissionKey(tab.target, singletonKinds))) {
            next = reduceWorkspaceState(next, { type: 'promoteTab', tabId: id });
        }
    }
    for (const id of retired) {
        const group = Object.values(next.groups).find(group => group.tabIds.includes(id));
        if (group) next = reduceWorkspaceState(next, { type: 'closeTab', groupId: group.id, tabId: id, newTab: createWorkspaceEmptyTab(createId()), remember: false });
    }
    if (retainedFocusedId) {
        const group = Object.values(next.groups).find(group => group.tabIds.includes(retainedFocusedId));
        if (group) next = reduceWorkspaceState(next, { type: 'activateTab', groupId: group.id, tabId: retainedFocusedId });
    }
    return JSON.stringify(next.tabPairs) === JSON.stringify(normalized.pairs) ? next : { ...next, tabPairs: normalized.pairs };
}
