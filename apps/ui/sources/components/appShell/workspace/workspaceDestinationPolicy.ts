import type { CompactAppDestination, DestinationRef } from '../destinations/compactAppDestinationCatalog';
import { hrefForDestinationRef } from '../destinations/compactAppDestinationCatalog';
import { matchWorkspaceDestinationRoute, workspaceMachinePageRouteKey } from './workspaceRoutes';
import { pruneWorkspaceTabPairs, type SharedWorkspaceTabs } from './workspaceSyncedTabs';
import { createWorkspaceEmptyTab, reduceWorkspaceState, type WorkspaceState } from './workspaceState';
import { collectSplitCanvasLeaves } from '../splitCanvas/model/splitCanvasTree';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export function workspaceSingletonDestinationIds(catalog: readonly CompactAppDestination[]): readonly string[] {
    return catalog.filter(item => item.id === 'workflows' || (item.kind === 'plugin' && item.container === 'appPage')).map(item => item.id);
}

/** New workflow documents are independent editors, even though their route belongs to the hub. */
function isWorkflowDraftDestination(target: DestinationRef): boolean {
    return target.kind === 'workflows' && target.params.workspacePathname === '/workflows/new';
}

export function isWorkspaceSingletonDestination(catalog: readonly CompactAppDestination[], target: DestinationRef): boolean {
    return !isWorkflowDraftDestination(target) && workspaceSingletonDestinationIds(catalog).includes(target.kind);
}

/** Keep the door in the URL, while the catalog's Machine policy owns its resource identity. */
function navigationResourceTarget(target: DestinationRef, catalog: readonly CompactAppDestination[]): DestinationRef {
    if (target.kind !== 'settings') return target;
    const href = hrefForDestinationRef(catalog, target);
    const route = href ? matchWorkspaceDestinationRoute(href) : null;
    return route && workspaceMachinePageRouteKey(route.routeKey)
        ? { kind: 'machines', params: { ...target.params, ...route.params } } : target;
}

/** Qualify a catalog-addressed resource once, at admission, so later Home changes cannot retarget it. */
export function resolveWorkspaceDestinationScope(target: DestinationRef, catalog: readonly CompactAppDestination[], scope?: ServerAccountScope | null): DestinationRef {
    const resourceTarget = navigationResourceTarget(target, catalog);
    const destination = catalog.find(item => item.id === resourceTarget.kind);
    const policy = destination?.kind === 'builtin' ? destination.workspaceNavigationIdentity : undefined;
    if (!policy || resourceTarget.params[policy.resourceParam] === undefined || !policy.scopeParams.includes('serverId')
        || target.params.serverId !== undefined || !scope?.serverId) return target;
    return { ...target, params: { ...target.params, serverId: scope.serverId } };
}

/** Catalog-declared resource identity; an index has no resource or Home qualifier. */
export function workspaceDestinationNavigationIdentity(target: DestinationRef, catalog: readonly CompactAppDestination[], scope?: ServerAccountScope | null): string | null {
    target = resolveWorkspaceDestinationScope(target, catalog, scope);
    target = navigationResourceTarget(target, catalog);
    const destination = catalog.find(item => item.id === target.kind);
    const policy = destination?.kind === 'builtin' ? destination.workspaceNavigationIdentity : undefined;
    if (!policy) return null;
    const resource = target.params[policy.resourceParam];
    return JSON.stringify(resource === undefined ? [target.kind] : [target.kind, resource,
        policy.scopeParams.map(key => [key, target.params[key] ?? null])]);
}

/** Identity of an admitted merge, also used to validate retained and pending sync aliases. */
export function workspaceDestinationAdmissionIdentity(target: DestinationRef, catalog: readonly CompactAppDestination[] = []): string {
    const navigationIdentity = workspaceDestinationNavigationIdentity(target, catalog);
    if (navigationIdentity !== null) return navigationIdentity;
    if (target.kind !== 'workflow' && target.kind !== 'workflowRun' && !isWorkflowDraftDestination(target)) return target.kind;
    return JSON.stringify([target.kind, Object.keys(target.params).sort().map(key => [key, target.params[key]])]);
}

function destinationAdmissionKey(target: DestinationRef, singletonKinds: ReadonlySet<string>): string | null {
    if (isWorkflowDraftDestination(target)) return null;
    if (singletonKinds.has(target.kind)) return workspaceDestinationAdmissionIdentity(target);
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
export function admitWorkspaceSingletonState(state: WorkspaceState, catalog: readonly CompactAppDestination[], createId: () => string, retainedState?: WorkspaceState): WorkspaceState {
    // A peer may use a different shared ID for an already-open singleton. Its
    // membership must not retire this window's retained instance or navigate it.
    // Ordinary local navigation/restoration still uses the usual admission below.
    if (retainedState) {
        const singletonKinds = new Set(workspaceSingletonDestinationIds(catalog));
        const retainedKeys = new Set(Object.values(retainedState.tabs).filter(tab => state.tabs[tab.id])
            .map(tab => destinationAdmissionKey(tab.target, singletonKinds)).filter(key => key !== null));
        for (const tab of Object.values(state.tabs)) {
            if (retainedState.tabs[tab.id]) continue;
            const key = destinationAdmissionKey(tab.target, singletonKinds);
            if (key === null || !retainedKeys.has(key)) continue;
            const group = Object.values(state.groups).find(group => group.tabIds.includes(tab.id));
            if (group) state = reduceWorkspaceState(state, { type: 'closeTab', groupId: group.id, tabId: tab.id,
                newTab: createWorkspaceEmptyTab(createId()), remember: false });
        }
    }
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
