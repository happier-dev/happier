import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { SplitCanvasAxis, SplitCanvasNode, SplitCanvasPlacement, SplitCanvasState } from '../splitCanvas/model/splitCanvasTypes';
import { splitCanvasReduce } from '../splitCanvas/model/splitCanvasReducer';
import { collectSplitCanvasLeaves } from '../splitCanvas/model/splitCanvasTree';
import {
    activateGroupTab, closeGroupTab, insertGroupTab, moveGroupTab,
    removeGroupPreviewTabs, reorderGroupTab,
} from './tabGroups/tabGroupTransitions';

export type WorkspaceTab = Readonly<{ id: string; target: DestinationRef; pinned: boolean; preview: boolean }>;
export function createWorkspaceEmptyTab(id: string): WorkspaceTab {
    return { id, target: { kind: 'newTab', params: {} }, pinned: false, preview: false };
}
export type WorkspaceGroup = Readonly<{ id: string; tabIds: readonly string[]; activeTabId: string; mru: readonly string[] }>;
export type ClosedWorkspaceTab = Readonly<{
    tab: WorkspaceTab;
    groupId: string;
    index: number;
    fallbackTitle?: string;
    placement?: Readonly<{ siblingId: string; splitId: string; axis: SplitCanvasAxis; ratio: number; side: 'first' | 'second' }>;
}>;
export type WorkspaceState = Readonly<{
    v: 1;
    tabs: Readonly<Record<string, WorkspaceTab>>;
    groups: Readonly<Record<string, WorkspaceGroup>>;
    root: SplitCanvasNode<Readonly<{ groupId: string }>>;
    focusedGroupId: string;
    maximizedGroupId: string | null;
    fallbackTitlesByTabId: Readonly<Record<string, string>>;
    tabPairs: readonly (readonly string[])[];
    recentlyClosed: readonly ClosedWorkspaceTab[];
}>;

type MeasuredSplit = Readonly<{
    availableSizePx: number;
    minimumFirstSizePx: number;
    minimumSecondSizePx: number;
}>;

export type WorkspaceAction =
    | Readonly<{ type: 'openTab'; groupId: string; tab: WorkspaceTab; fallbackTitle?: string; beforeTabId?: string | null }>
    | (MeasuredSplit & Readonly<{ type: 'openSplitTab'; groupId: string; tab: WorkspaceTab;
        newGroupId: string; axis: SplitCanvasAxis; placement: SplitCanvasPlacement }>)
    | Readonly<{ type: 'activateTab'; groupId: string; tabId: string }>
    | Readonly<{ type: 'closeTab'; groupId: string; tabId: string; newTab: WorkspaceTab; remember?: boolean }>
    | Readonly<{ type: 'reopenTab'; tabId?: string; reuseTabId?: string }>
    | Readonly<{ type: 'moveTab'; tabId: string; sourceGroupId: string; targetGroupId: string; beforeTabId?: string | null }>
    | (Readonly<{ type: 'reorderTab'; groupId: string; tabId: string }> & (
        | Readonly<{ index: number; beforeTabId?: never }>
        | Readonly<{ beforeTabId: string | null; index?: never }>
    ))
    | Readonly<{ type: 'focusGroup'; groupId: string }>
    | Readonly<{ type: 'toggleMaximize'; groupId: string }>
    | Readonly<{ type: 'restoreMaximize' }>
    | Readonly<{ type: 'setTarget'; tabId: string; target: DestinationRef }>
    | Readonly<{ type: 'setFallbackTitle'; tabId: string; title: string }>
    | Readonly<{ type: 'setPinned'; tabId: string; pinned: boolean }>
    | Readonly<{ type: 'promoteTab'; tabId: string }>
    | (MeasuredSplit & Readonly<{
        type: 'splitTab'; tabId: string; sourceGroupId: string; targetGroupId: string;
        newGroupId: string; axis: SplitCanvasAxis; placement: SplitCanvasPlacement;
        newTabForSource?: WorkspaceTab;
    }>)
    | (MeasuredSplit & Readonly<{ type: 'resize'; splitId: string; ratio: number }>);

type WorkspaceCanvas = SplitCanvasState<Readonly<{ groupId: string }>>;

function canvasFor(state: WorkspaceState): WorkspaceCanvas {
    return {
        root: state.root,
        focusedLeafId: state.focusedGroupId,
        maximizedLeafId: state.maximizedGroupId,
    };
}

function fromCanvas(state: WorkspaceState, canvas: WorkspaceCanvas): WorkspaceState {
    if (!canvas.root) throw new Error('Workspace canvas unexpectedly empty');
    return {
        ...state,
        root: canvas.root,
        focusedGroupId: canvas.focusedLeafId ?? state.focusedGroupId,
        maximizedGroupId: canvas.maximizedLeafId,
    };
}

function withoutTabs<T>(values: Readonly<Record<string, T>>, removed: readonly string[]): Record<string, T> {
    const excluded = new Set(removed);
    return Object.fromEntries(Object.entries(values).filter(([id]) => !excluded.has(id)));
}

function groupContaining(state: WorkspaceState, tabId: string): WorkspaceGroup | null {
    return Object.values(state.groups).find((group) => group.tabIds.includes(tabId)) ?? null;
}

function leaf(groupId: string): Extract<WorkspaceState['root'], { kind: 'leaf' }> {
    return { id: groupId, kind: 'leaf', leafKind: 'workspace-group', payload: { groupId } };
}

function closedPanePlacement(node: WorkspaceState['root'], groupId: string): ClosedWorkspaceTab['placement'] {
    if (node.kind === 'leaf') return undefined;
    for (const side of ['first', 'second'] as const) {
        if (node[side].kind === 'leaf' && node[side].id === groupId) {
            return { siblingId: node[side === 'first' ? 'second' : 'first'].id, splitId: node.id, axis: node.axis, ratio: node.ratio, side };
        }
    }
    return closedPanePlacement(node.first, groupId) ?? closedPanePlacement(node.second, groupId);
}

function restoreClosedPane(root: WorkspaceState['root'], entry: ClosedWorkspaceTab): WorkspaceState['root'] {
    const placement = entry.placement;
    if (!placement) return root;
    const ids = new Set<string>();
    const collect = (node: WorkspaceState['root']): void => {
        ids.add(node.id);
        if (node.kind === 'split') { collect(node.first); collect(node.second); }
    };
    collect(root);
    let splitId = placement.splitId;
    for (let index = 1; ids.has(splitId); index++) splitId = `split:${index}`;
    const restore = (node: WorkspaceState['root']): WorkspaceState['root'] => {
        if (node.id === placement.siblingId) return {
            id: splitId, kind: 'split', axis: placement.axis, ratio: placement.ratio,
            first: placement.side === 'first' ? leaf(entry.groupId) : node,
            second: placement.side === 'second' ? leaf(entry.groupId) : node,
        };
        if (node.kind === 'leaf') return node;
        const first = restore(node.first);
        const second = restore(node.second);
        return first === node.first && second === node.second ? node : { ...node, first, second };
    };
    return restore(root);
}

export function projectWorkspaceSplitTabPairs(state: Pick<WorkspaceState, 'root' | 'groups'>): WorkspaceState['tabPairs'] {
    const ids = collectSplitCanvasLeaves(state.root).map(leaf => state.groups[leaf.payload.groupId].activeTabId);
    return ids.length >= 2 ? [ids] : [];
}

function removePairMembers(state: WorkspaceState, ids: readonly string[]): WorkspaceState['tabPairs'] {
    if (!state.tabPairs.some(pair => pair.some(id => ids.includes(id)))) return state.tabPairs;
    return state.tabPairs.map(pair => pair.filter(id => !ids.includes(id))).filter(pair => pair.length >= 2);
}

export function createWorkspaceState(tab: WorkspaceTab): WorkspaceState {
    return {
        v: 1,
        tabs: { [tab.id]: tab },
        groups: { 'group:1': { id: 'group:1', tabIds: [tab.id], activeTabId: tab.id, mru: [tab.id] } },
        root: { id: 'group:1', kind: 'leaf', leafKind: 'workspace-group', payload: { groupId: 'group:1' } },
        focusedGroupId: 'group:1',
        maximizedGroupId: null,
        fallbackTitlesByTabId: {},
        tabPairs: [],
        recentlyClosed: [],
    };
}

export function reduceWorkspaceState(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
    switch (action.type) {
        case 'openSplitTab': {
            if (!state.groups[action.groupId] || state.tabs[action.tab.id]) return state;
            const opened = reduceWorkspaceState(state, { type: 'openTab', groupId: action.groupId,
                tab: { ...action.tab, preview: false } });
            const split = reduceWorkspaceState(opened, { ...action, type: 'splitTab', tabId: action.tab.id,
                sourceGroupId: action.groupId, targetGroupId: action.groupId });
            return split.root === state.root ? state : split;
        }
        case 'openTab': {
            const group = state.groups[action.groupId];
            if (!group) return state;
            const existing = groupContaining(state, action.tab.id);
            if (existing) return reduceWorkspaceState(state, { type: 'activateTab', groupId: existing.id, tabId: action.tab.id });
            const preview = action.tab.preview
                ? removeGroupPreviewTabs(group, state.tabs)
                : { group, removedTabIds: [] };
            const nextGroup = insertGroupTab(preview.group, action.tab.id, action.beforeTabId);
            const focused = splitCanvasReduce(canvasFor(state), { type: 'focusLeaf', leafId: group.id });
            return {
                ...fromCanvas(state, focused),
                tabs: { ...withoutTabs(state.tabs, preview.removedTabIds), [action.tab.id]: action.tab },
                groups: { ...state.groups, [group.id]: nextGroup as WorkspaceGroup },
                fallbackTitlesByTabId: {
                    ...withoutTabs(state.fallbackTitlesByTabId, preview.removedTabIds),
                    ...(action.fallbackTitle === undefined ? {} : { [action.tab.id]: action.fallbackTitle }),
                },
                tabPairs: removePairMembers(state, preview.removedTabIds),
            };
        }
        case 'activateTab': {
            const group = state.groups[action.groupId];
            if (!group || !group.tabIds.includes(action.tabId)) return state;
            const nextGroup = activateGroupTab(group, action.tabId);
            const focused = splitCanvasReduce(canvasFor(state), { type: 'focusLeaf', leafId: group.id });
            if (nextGroup === group && focused.focusedLeafId === state.focusedGroupId
                && focused.maximizedLeafId === state.maximizedGroupId) return state;
            return { ...fromCanvas(state, focused), groups: { ...state.groups, [group.id]: nextGroup as WorkspaceGroup } };
        }
        case 'closeTab': {
            const group = state.groups[action.groupId];
            if (!group?.tabIds.includes(action.tabId)) return state;
            const tabs = withoutTabs(state.tabs, [action.tabId]);
            const titles = withoutTabs(state.fallbackTitlesByTabId, [action.tabId]);
            const nextGroup = closeGroupTab(group, action.tabId);
            const tab = state.tabs[action.tabId];
            const recentlyClosed = action.remember === false || tab.target.kind === 'newTab' ? state.recentlyClosed : [
                { tab, groupId: group.id, index: group.tabIds.indexOf(tab.id),
                    ...(state.fallbackTitlesByTabId[tab.id] === undefined ? {} : { fallbackTitle: state.fallbackTitlesByTabId[tab.id] }),
                    ...(nextGroup.tabIds.length === 0 ? { placement: closedPanePlacement(state.root, group.id) } : {}),
                },
                ...state.recentlyClosed.filter(entry => entry.tab.id !== tab.id),
            ];
            if (nextGroup.tabIds.length > 0) {
                return { ...state, recentlyClosed, tabs, fallbackTitlesByTabId: titles, groups: { ...state.groups, [group.id]: nextGroup as WorkspaceGroup }, tabPairs: removePairMembers(state, [action.tabId]) };
            }
            if (Object.keys(state.groups).length === 1) {
                if (action.newTab.target.kind !== 'newTab' || action.newTab.id === action.tabId || state.tabs[action.newTab.id]) return state;
                const replacement = insertGroupTab({ ...nextGroup, activeTabId: null }, action.newTab.id);
                return {
                    ...state, recentlyClosed, tabs: { ...tabs, [action.newTab.id]: action.newTab },
                    groups: { [group.id]: replacement as WorkspaceGroup }, fallbackTitlesByTabId: titles,
                    tabPairs: removePairMembers(state, [action.tabId]),
                };
            }
            const closed = splitCanvasReduce(canvasFor(state), { type: 'closeLeaf', leafId: group.id });
            const groups = { ...state.groups };
            delete groups[group.id];
            return { ...fromCanvas(state, closed), recentlyClosed, tabs, groups, fallbackTitlesByTabId: titles, tabPairs: removePairMembers(state, [action.tabId]) };
        }
        case 'reopenTab': {
            const entry = action.tabId ? state.recentlyClosed.find(item => item.tab.id === action.tabId) : state.recentlyClosed[0];
            if (!entry) return state;
            const recentlyClosed = state.recentlyClosed.filter(item => item !== entry);
            const existingTabId = action.reuseTabId ?? entry.tab.id;
            const existing = groupContaining(state, existingTabId);
            if (existing) {
                const retargeted = reduceWorkspaceState(state, { type: 'setTarget', tabId: existingTabId, target: entry.tab.target });
                const kept = reduceWorkspaceState(retargeted, { type: 'promoteTab', tabId: existingTabId });
                return { ...reduceWorkspaceState(kept, { type: 'activateTab', groupId: existing.id, tabId: existingTabId }), recentlyClosed };
            }
            const root = state.groups[entry.groupId] ? state.root : restoreClosedPane(state.root, entry);
            const restoredPane = root !== state.root;
            const groupId = state.groups[entry.groupId] || restoredPane ? entry.groupId : state.focusedGroupId;
            const group = state.groups[groupId] ?? { id: groupId, tabIds: [], activeTabId: '', mru: [] };
            const restoredGroup = insertGroupTab(group, entry.tab.id, group.tabIds[entry.index] ?? null);
            const reopened = {
                ...state, root, recentlyClosed, focusedGroupId: groupId, maximizedGroupId: null,
                tabs: { ...state.tabs, [entry.tab.id]: { ...entry.tab, preview: false } },
                groups: { ...state.groups, [groupId]: restoredGroup as WorkspaceGroup },
                fallbackTitlesByTabId: { ...state.fallbackTitlesByTabId, ...(entry.fallbackTitle === undefined ? {} : { [entry.tab.id]: entry.fallbackTitle }) },
            };
            return restoredPane ? { ...reopened, tabPairs: projectWorkspaceSplitTabPairs(reopened) } : reopened;
        }
        case 'reorderTab': {
            const group = state.groups[action.groupId];
            if (!group) return state;
            let beforeTabId = action.beforeTabId;
            if (action.index !== undefined) {
                if (!Number.isInteger(action.index) || action.index < 0 || action.index >= group.tabIds.length) return state;
                beforeTabId = group.tabIds.filter(id => id !== action.tabId)[action.index] ?? null;
            }
            const reordered = reorderGroupTab(group, action.tabId, beforeTabId ?? null);
            return reordered === group ? state : { ...state, groups: { ...state.groups, [group.id]: reordered as WorkspaceGroup } };
        }
        case 'moveTab': {
            const source = state.groups[action.sourceGroupId];
            const target = state.groups[action.targetGroupId];
            const tab = state.tabs[action.tabId];
            if (!source || !target || !tab || !source.tabIds.includes(tab.id)) return state;
            // Moving an existing view is an explicit keep intent. Its destination's
            // current preview remains open rather than being replaced by the move.
            const keptTab = source.id !== target.id && tab.preview ? { ...tab, preview: false } : tab;
            const moved = moveGroupTab(source, target, keptTab, state.tabs, action.beforeTabId);
            if (source.id === target.id) {
                const activated = reduceWorkspaceState(state, { type: 'activateTab', groupId: target.id, tabId: tab.id });
                return moved.target === target ? activated : { ...activated, groups: { ...activated.groups, [target.id]: moved.target as WorkspaceGroup } };
            }
            const groups = { ...state.groups, [source.id]: moved.source as WorkspaceGroup, [target.id]: moved.target as WorkspaceGroup };
            let canvas = canvasFor(state);
            if (moved.source.tabIds.length === 0) {
                delete groups[source.id];
                canvas = splitCanvasReduce(canvas, { type: 'closeLeaf', leafId: source.id });
            }
            canvas = splitCanvasReduce(canvas, { type: 'focusLeaf', leafId: target.id });
            return {
                ...fromCanvas(state, canvas), groups,
                tabs: keptTab === tab ? state.tabs : { ...state.tabs, [tab.id]: keptTab },
                fallbackTitlesByTabId: state.fallbackTitlesByTabId,
                tabPairs: projectWorkspaceSplitTabPairs({ root: canvas.root!, groups }),
            };
        }
        case 'splitTab': {
            const source = state.groups[action.sourceGroupId];
            const target = state.groups[action.targetGroupId];
            const tab = state.tabs[action.tabId];
            if (!source || !target || !tab || !source.tabIds.includes(tab.id) || state.groups[action.newGroupId]) return state;
            if (source.id === target.id && source.tabIds.length === 1
                && (!action.newTabForSource || action.newTabForSource.target.kind !== 'newTab'
                    || state.tabs[action.newTabForSource.id])) return state;
            let canvas = splitCanvasReduce(canvasFor(state), {
                type: 'splitLeaf', targetLeafId: target.id, axis: action.axis,
                placement: action.placement, newLeaf: leaf(action.newGroupId),
                availableSizePx: action.availableSizePx,
                minimumFirstSizePx: action.minimumFirstSizePx,
                minimumSecondSizePx: action.minimumSecondSizePx,
            });
            if (canvas.root === state.root) return state;
            const remainder = closeGroupTab(source, tab.id);
            const groups = {
                ...state.groups,
                [source.id]: remainder as WorkspaceGroup,
                [action.newGroupId]: {
                    id: action.newGroupId, tabIds: [tab.id], activeTabId: tab.id, mru: [tab.id],
                },
            };
            let tabs = state.tabs;
            if (remainder.tabIds.length === 0) {
                if (source.id === target.id && action.newTabForSource) {
                    const replacement = insertGroupTab({ ...remainder, activeTabId: null }, action.newTabForSource.id);
                    groups[source.id] = replacement as WorkspaceGroup;
                    tabs = { ...tabs, [action.newTabForSource.id]: action.newTabForSource };
                } else {
                    delete groups[source.id];
                    canvas = splitCanvasReduce(canvas, { type: 'closeLeaf', leafId: source.id });
                }
            }
            canvas = splitCanvasReduce(canvas, { type: 'focusLeaf', leafId: action.newGroupId });
            return { ...fromCanvas(state, canvas), tabs, groups, tabPairs: projectWorkspaceSplitTabPairs({ root: canvas.root!, groups }) };
        }
        case 'resize': {
            const canvas = splitCanvasReduce(canvasFor(state), {
                type: 'setSplitRatio', splitId: action.splitId, ratio: action.ratio,
                availableSizePx: action.availableSizePx,
                minimumFirstSizePx: action.minimumFirstSizePx,
                minimumSecondSizePx: action.minimumSecondSizePx,
            });
            return canvas.root === state.root ? state : fromCanvas(state, canvas);
        }
        case 'focusGroup': {
            if (!state.groups[action.groupId]) return state;
            const canvas = splitCanvasReduce(canvasFor(state), { type: 'focusLeaf', leafId: action.groupId });
            return canvas.focusedLeafId === state.focusedGroupId && canvas.maximizedLeafId === state.maximizedGroupId
                ? state : fromCanvas(state, canvas);
        }
        case 'toggleMaximize': {
            if (!state.groups[action.groupId]) return state;
            return fromCanvas(state, splitCanvasReduce(canvasFor(state), { type: 'toggleMaximizeLeaf', leafId: action.groupId }));
        }
        case 'restoreMaximize': {
            if (!state.maximizedGroupId) return state;
            return fromCanvas(state, splitCanvasReduce(canvasFor(state), { type: 'restoreMaximize' }));
        }
        case 'setTarget': {
            const tab = state.tabs[action.tabId];
            if (!tab || tab.target === action.target) return state;
            return { ...state, tabs: { ...state.tabs, [tab.id]: { ...tab, target: action.target } } };
        }
        case 'setFallbackTitle': {
            if (!state.tabs[action.tabId] || state.fallbackTitlesByTabId[action.tabId] === action.title) return state;
            return { ...state, fallbackTitlesByTabId: { ...state.fallbackTitlesByTabId, [action.tabId]: action.title } };
        }
        case 'promoteTab': {
            const tab = state.tabs[action.tabId];
            if (!tab?.preview || !groupContaining(state, action.tabId)) return state;
            return { ...state, tabs: { ...state.tabs, [tab.id]: { ...tab, preview: false } } };
        }
        case 'setPinned': {
            const tab = state.tabs[action.tabId];
            if (!tab || !groupContaining(state, action.tabId)) return state;
            const preview = action.pinned ? false : tab.preview;
            if (tab.pinned === action.pinned && tab.preview === preview) return state;
            return { ...state, tabs: { ...state.tabs, [tab.id]: { ...tab, pinned: action.pinned, preview } } };
        }
    }
}
