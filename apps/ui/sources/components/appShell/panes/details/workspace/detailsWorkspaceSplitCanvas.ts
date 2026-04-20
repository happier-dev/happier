import {
    SPLIT_CANVAS_DEFAULT_MAX_LEAVES,
    splitCanvasReduce,
} from '@/components/appShell/splitCanvas/model/splitCanvasReducer';
import {
    collectSplitCanvasLeaves,
} from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import type {
    SplitCanvasAction,
    SplitCanvasAxis,
    SplitCanvasDirection,
    SplitCanvasLeafNode,
    SplitCanvasPlacement,
    SplitCanvasState,
} from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import type {
    DetailsWorkspaceAxis,
    DetailsWorkspaceLeafNode,
    DetailsWorkspaceLeafPayload,
    DetailsWorkspaceNode,
    PaneDetailsState,
} from './detailsWorkspaceTypes';

export const DETAILS_WORKSPACE_LEAF_KIND = 'details-group';

export function createDetailsWorkspaceLeafNode(groupId: string): DetailsWorkspaceLeafNode {
    return {
        id: groupId,
        kind: 'leaf',
        leafKind: DETAILS_WORKSPACE_LEAF_KIND,
        payload: { groupId },
    };
}

export function readDetailsWorkspaceGroupId(
    leaf: Readonly<Pick<SplitCanvasLeafNode<DetailsWorkspaceLeafPayload>, 'id' | 'payload'>>,
): string {
    return typeof leaf.payload?.groupId === 'string' && leaf.payload.groupId.length > 0
        ? leaf.payload.groupId
        : leaf.id;
}

export function listDetailsWorkspaceGroupIds(root: DetailsWorkspaceNode | null): string[] {
    return collectSplitCanvasLeaves(root).map(readDetailsWorkspaceGroupId);
}

export function createDetailsWorkspaceSplitCanvasState(
    details: Readonly<Pick<PaneDetailsState, 'root' | 'focusedGroupId' | 'maximizedGroupId'>>,
): SplitCanvasState<DetailsWorkspaceLeafPayload> {
    return {
        root: details.root,
        focusedLeafId: details.focusedGroupId,
        maximizedLeafId: details.maximizedGroupId,
        maxLeaves: SPLIT_CANVAS_DEFAULT_MAX_LEAVES,
    };
}

export function applyDetailsWorkspaceSplitCanvasAction(
    details: PaneDetailsState,
    action: SplitCanvasAction<DetailsWorkspaceLeafPayload>,
): PaneDetailsState {
    const nextCanvas = splitCanvasReduce(createDetailsWorkspaceSplitCanvasState(details), action);
    return {
        ...details,
        root: nextCanvas.root,
        focusedGroupId: nextCanvas.focusedLeafId,
        maximizedGroupId: nextCanvas.maximizedLeafId,
    };
}

export function mapDetailsWorkspaceAxisToSplitCanvasAxis(axis: DetailsWorkspaceAxis): SplitCanvasAxis {
    return axis === 'vertical' ? 'row' : 'column';
}

export function mapSplitCanvasDirectionToDetailsWorkspaceAxis(direction: SplitCanvasDirection): DetailsWorkspaceAxis {
    return direction === 'left' || direction === 'right' ? 'vertical' : 'horizontal';
}

export function mapSplitCanvasDirectionToDetailsWorkspacePlacement(
    direction: SplitCanvasDirection,
): SplitCanvasPlacement {
    return direction === 'left' || direction === 'up' ? 'before' : 'after';
}
