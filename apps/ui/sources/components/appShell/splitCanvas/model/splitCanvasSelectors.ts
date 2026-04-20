import type {
    SplitCanvasDirection,
    SplitCanvasLeafNode,
    SplitCanvasState,
} from './splitCanvasTypes';
import {
    collectSplitCanvasLeaves,
    findAdjacentSplitCanvasLeafIdInTree,
    findSplitCanvasLeaf,
    splitCanvasSubtreeContainsLeaf,
} from './splitCanvasTree';

export function collectSplitCanvasLeafIds<TLeafPayload>(
    state: Readonly<Pick<SplitCanvasState<TLeafPayload>, 'root'>>,
): string[] {
    return collectSplitCanvasLeaves(state.root).map((leaf) => leaf.id);
}

export function findSplitCanvasLeafById<TLeafPayload>(
    state: Readonly<Pick<SplitCanvasState<TLeafPayload>, 'root'>>,
    leafId: string,
): SplitCanvasLeafNode<TLeafPayload> | null {
    return findSplitCanvasLeaf(state.root, leafId);
}

export function findAdjacentSplitCanvasLeafId<TLeafPayload>(
    state: Readonly<Pick<SplitCanvasState<TLeafPayload>, 'root'>>,
    leafId: string,
    direction: SplitCanvasDirection,
): string | null {
    return findAdjacentSplitCanvasLeafIdInTree(state.root, leafId, direction);
}

export function isSplitCanvasLeafVisible<TLeafPayload>(
    state: Readonly<Pick<SplitCanvasState<TLeafPayload>, 'root' | 'maximizedLeafId'>>,
    leafId: string,
): boolean {
    if (!state.maximizedLeafId) return true;
    return splitCanvasSubtreeContainsLeaf(state.root, state.maximizedLeafId) && state.maximizedLeafId === leafId;
}
