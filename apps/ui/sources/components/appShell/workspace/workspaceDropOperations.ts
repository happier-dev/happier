import type { SplitCanvasDropTarget } from '../splitCanvas/model/splitCanvasTypes';
import { reduceWorkspaceState, type WorkspaceAction, type WorkspaceState } from './workspaceState';
import { createWorkspaceSplit } from './workspaceSplit';

/** Semantic ordering is resolved by the shared tab-group owner against current membership. */
export function resolveWorkspaceTabStripDrop(state: WorkspaceState, input: Readonly<{
    tabId: string;
    groupId: string;
    beforeTabId: string | null;
}>): readonly WorkspaceAction[] {
    const target = state.groups[input.groupId];
    const source = Object.values(state.groups).find(group => group.tabIds.includes(input.tabId));
    if (!target || !source || input.tabId === input.beforeTabId) return [];
    const action: WorkspaceAction = source.id === target.id
        ? { type: 'reorderTab', groupId: target.id, tabId: input.tabId, beforeTabId: input.beforeTabId }
        : { type: 'moveTab', sourceGroupId: source.id, targetGroupId: target.id, tabId: input.tabId, beforeTabId: input.beforeTabId };
    return reduceWorkspaceState(state, action) === state ? [] : [action];
}

/** Centre moves a tab; measured edges use the existing workspace split owner. */
export function resolveWorkspaceTabCanvasDrop(state: WorkspaceState, input: Readonly<{
    tabId: string;
    target: SplitCanvasDropTarget;
    availableSizePx?: number;
    minimumExistingSizePx?: number;
    createId: () => string;
}>): WorkspaceAction | null {
    const source = Object.values(state.groups).find(group => group.tabIds.includes(input.tabId));
    if (!source || !state.groups[input.target.leafId]) return null;
    if (input.target.placement === 'center') {
        return source.id === input.target.leafId ? null
            : { type: 'moveTab', tabId: input.tabId, sourceGroupId: source.id, targetGroupId: input.target.leafId };
    }
    if (source.id === input.target.leafId && source.tabIds.length === 1) return null;
    if (input.availableSizePx === undefined || input.minimumExistingSizePx === undefined) return null;
    return createWorkspaceSplit(state, {
        groupId: input.target.leafId, tabId: input.tabId, direction: input.target.placement,
        availableSizePx: input.availableSizePx, minimumExistingSizePx: input.minimumExistingSizePx, createId: input.createId,
    });
}
