import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import type { SplitCanvasDirection } from '../splitCanvas/model/splitCanvasTypes';
import { createWorkspaceEmptyTab, reduceWorkspaceState, type WorkspaceAction, type WorkspaceState, type WorkspaceTab } from './workspaceState';

export const WORKSPACE_VIEW_MINIMUM = {
    width: PANE_SIZING_DEFAULTS.mainMinPx,
    height: PANE_SIZING_DEFAULTS.bottom.minPx,
};

/** Publish neither the open nor the split until the existing measured owner admits both. */
export function createWorkspaceDestinationSplit(state: WorkspaceState, input: Readonly<{
    groupId: string;
    tab: WorkspaceTab;
    direction: SplitCanvasDirection;
    availableSizePx: number;
    minimumExistingSizePx: number;
    createId: () => string;
}>): Extract<WorkspaceAction, { type: 'openSplitTab' }> | null {
    if (!state.groups[input.groupId] || state.tabs[input.tab.id]) return null;
    const open: WorkspaceAction = { type: 'openTab', groupId: input.groupId, tab: { ...input.tab, preview: false } };
    const opened = reduceWorkspaceState(state, open);
    const split = createWorkspaceSplit(opened, {
        ...input, tabId: input.tab.id,
    });
    return split ? { type: 'openSplitTab', groupId: input.groupId, tab: input.tab,
        newGroupId: split.newGroupId, axis: split.axis, placement: split.placement,
        availableSizePx: split.availableSizePx, minimumFirstSizePx: split.minimumFirstSizePx,
        minimumSecondSizePx: split.minimumSecondSizePx } : null;
}

/** Both UI requests and Actions admit splits through the real workspace reducer. */
export function createWorkspaceSplit(state: WorkspaceState, input: Readonly<{
    groupId: string;
    tabId?: string;
    direction: SplitCanvasDirection;
    availableSizePx: number;
    minimumExistingSizePx: number;
    createId: () => string;
}>): Extract<WorkspaceAction, { type: 'splitTab' }> | null {
    const target = state.groups[input.groupId];
    const tabId = input.tabId;
    const source = tabId ? Object.values(state.groups).find((group) => group.tabIds.includes(tabId)) : target;
    if (!source || !target) return null;
    const axis = input.direction === 'left' || input.direction === 'right' ? 'row' : 'column';
    const action: Extract<WorkspaceAction, { type: 'splitTab' }> = {
        type: 'splitTab', tabId: input.tabId ?? source.activeTabId,
        sourceGroupId: source.id, targetGroupId: target.id, newGroupId: input.createId(), axis,
        placement: input.direction === 'left' || input.direction === 'up' ? 'before' : 'after',
        availableSizePx: input.availableSizePx,
        minimumFirstSizePx: input.minimumExistingSizePx,
        minimumSecondSizePx: axis === 'row' ? WORKSPACE_VIEW_MINIMUM.width : WORKSPACE_VIEW_MINIMUM.height,
        ...(source.id === target.id && source.tabIds.length === 1 ? { newTabForSource: createWorkspaceEmptyTab(input.createId()) } : {}),
    };
    return reduceWorkspaceState(state, action).root === state.root ? null : action;
}
