import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { SplitCanvasNode } from '../splitCanvas/model/splitCanvasTypes';
import type { WorkspaceGroup, WorkspaceState, WorkspaceTab } from './workspaceState';

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function nonempty(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function parseTarget(value: unknown): DestinationRef | null {
    const candidate = record(value);
    const params = record(candidate?.params);
    if (!candidate || !nonempty(candidate.kind) || !params
        || !Object.values(params).every((entry) => typeof entry === 'string')) return null;
    // A removed catalog kind remains intact so the destination host can show its tombstone.
    return { kind: candidate.kind, params: params as Record<string, string> };
}

function parseTab(value: unknown, id: string): WorkspaceTab | null {
    const candidate = record(value);
    const target = parseTarget(candidate?.target);
    if (!candidate || candidate.id !== id || !target
        || typeof candidate.pinned !== 'boolean' || typeof candidate.preview !== 'boolean'
        || (candidate.pinned && candidate.preview)) return null;
    const presentation = candidate.presentation === undefined ? null : record(candidate.presentation);
    if (candidate.presentation !== undefined && !nonempty(presentation?.windowId)) return null;
    return { id, target, pinned: candidate.pinned, preview: candidate.preview,
        ...(presentation ? { presentation: { windowId: presentation.windowId as string } } : {}),
    };
}

function parseGroup(value: unknown, id: string): WorkspaceGroup | null {
    const candidate = record(value);
    const tabIds = candidate?.tabIds;
    const mru = candidate?.mru;
    if (!candidate || candidate.id !== id || !Array.isArray(tabIds)
        || tabIds.length === 0 || !tabIds.every(nonempty)
        || new Set(tabIds).size !== tabIds.length
        || !nonempty(candidate.activeTabId) || !tabIds.includes(candidate.activeTabId)
        || !Array.isArray(mru) || !mru.every(nonempty)
        || new Set(mru).size !== mru.length
        || !mru.includes(candidate.activeTabId)
        || mru.some((tabId: string) => !tabIds.includes(tabId))) return null;
    return {
        id, tabIds, activeTabId: candidate.activeTabId,
        mru,
    };
}

function parseNode(
    value: unknown,
    leafIds: Set<string>,
    splitIds: Set<string>,
): WorkspaceState['root'] | null {
    const candidate = record(value);
    if (!candidate || !nonempty(candidate.id)) return null;
    if (candidate.kind === 'leaf') {
        const payload = record(candidate.payload);
        if (candidate.leafKind !== 'workspace-group' || payload?.groupId !== candidate.id
            || leafIds.has(candidate.id)) return null;
        leafIds.add(candidate.id);
        return { id: candidate.id, kind: 'leaf', leafKind: 'workspace-group', payload: { groupId: candidate.id } };
    }
    if (candidate.kind !== 'split' || (candidate.axis !== 'row' && candidate.axis !== 'column')
        || typeof candidate.ratio !== 'number' || !Number.isFinite(candidate.ratio)
        || candidate.ratio <= 0 || candidate.ratio >= 1 || splitIds.has(candidate.id)) return null;
    splitIds.add(candidate.id);
    const first = parseNode(candidate.first, leafIds, splitIds);
    const second = parseNode(candidate.second, leafIds, splitIds);
    if (!first || !second) return null;
    return {
        id: candidate.id, kind: 'split', axis: candidate.axis,
        ratio: candidate.ratio, first, second,
    } satisfies SplitCanvasNode<Readonly<{ groupId: string }>>;
}

export function serializeWorkspaceLayout(state: WorkspaceState): Omit<WorkspaceState, 'recentlyClosed'> {
    const { recentlyClosed: _recentlyClosed, ...layout } = state;
    return layout;
}

export type WorkspaceLayoutScope = Readonly<{ serverId: string; accountId: string; windowId: string }>;

export function workspaceLayoutScopeKey(scope: WorkspaceLayoutScope): string {
    return JSON.stringify([scope.serverId, scope.accountId, scope.windowId]);
}

export function readScopedWorkspaceLayout(layouts: Readonly<Record<string, unknown>>, scopeKey: string): WorkspaceState | null {
    return Object.hasOwn(layouts, scopeKey) ? parseWorkspaceLayout(layouts[scopeKey]) : null;
}

export function writeScopedWorkspaceLayout(
    layouts: Readonly<Record<string, unknown>>, scopeKey: string, state: WorkspaceState,
): Readonly<Record<string, unknown>> {
    return { ...layouts, [scopeKey]: serializeWorkspaceLayout(state) };
}

export function parseWorkspaceLayout(value: unknown): WorkspaceState | null {
    const candidate = record(value);
    const rawTabs = record(candidate?.tabs);
    const rawGroups = record(candidate?.groups);
    const rawTitles = candidate?.fallbackTitlesByTabId === undefined
        ? {} : record(candidate.fallbackTitlesByTabId);
    if (!candidate || candidate.v !== 1 || !rawTabs || !rawGroups || !rawTitles
        || !nonempty(candidate.focusedGroupId)
        || (candidate.maximizedGroupId !== null && !nonempty(candidate.maximizedGroupId))) return null;

    const tabs = Object.fromEntries(Object.entries(rawTabs).map(([id, raw]) => [id, parseTab(raw, id)]));
    if (Object.values(tabs).some((tab) => tab === null)) return null;
    const groups = Object.fromEntries(Object.entries(rawGroups).map(([id, raw]) => [id, parseGroup(raw, id)]));
    if (Object.keys(groups).length === 0 || Object.values(groups).some((group) => group === null)) return null;
    const leafIds = new Set<string>();
    const root = parseNode(candidate.root, leafIds, new Set<string>());
    if (!root || leafIds.size !== Object.keys(groups).length
        || [...leafIds].some((id) => !Object.hasOwn(groups, id))
        || !Object.hasOwn(groups, candidate.focusedGroupId)
        || (candidate.maximizedGroupId !== null && !Object.hasOwn(groups, candidate.maximizedGroupId))) return null;
    const memberships = Object.values(groups).flatMap((group) => group?.tabIds ?? []);
    if (memberships.length !== Object.keys(tabs).length || new Set(memberships).size !== memberships.length
        || memberships.some((id) => !Object.hasOwn(tabs, id))
        || Object.entries(rawTitles).some(([id, title]) => !Object.hasOwn(tabs, id) || typeof title !== 'string')) return null;
    for (const group of Object.values(groups)) {
        if (!group) return null;
        if (group.tabIds.filter((id) => tabs[id]?.preview).length > 1) return null;
    }
    const tabPairs = candidate.tabPairs;
    if (!Array.isArray(tabPairs)) return null;
    const paired = new Set<string>();
    for (const pair of tabPairs) {
        if (!Array.isArray(pair) || pair.length < 2) return null;
        for (const id of pair) {
            if (!nonempty(id) || !tabs[id] || paired.has(id)) return null;
            paired.add(id);
        }
    }
    return {
        v: 1,
        tabs: tabs as Record<string, WorkspaceTab>,
        groups: groups as Record<string, WorkspaceGroup>,
        root,
        focusedGroupId: candidate.focusedGroupId,
        maximizedGroupId: candidate.maximizedGroupId as string | null,
        fallbackTitlesByTabId: rawTitles as Record<string, string>,
        tabPairs,
        recentlyClosed: [],
    };
}
