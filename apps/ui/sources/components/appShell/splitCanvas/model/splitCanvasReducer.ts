import type {
    SplitCanvasAction,
    SplitCanvasLeafNode,
    SplitCanvasState,
} from './splitCanvasTypes';
import {
    findSplitCanvasLeaf,
    getFirstSplitCanvasLeafId,
    rebalanceSplitCanvasTree,
    removeSplitCanvasLeaf,
    replaceSplitCanvasLeaf,
    setSplitCanvasRatio,
    splitSplitCanvasLeaf,
} from './splitCanvasTree';

export const SPLIT_CANVAS_RATIO_MIN = 0.2;
export const SPLIT_CANVAS_RATIO_MAX = 0.8;

function measuredRatioBounds(input: Readonly<{
    availableSizePx?: number;
    minimumFirstSizePx?: number;
    minimumSecondSizePx?: number;
}>): Readonly<{ minRatio: number; maxRatio: number }> | null {
    const { availableSizePx, minimumFirstSizePx, minimumSecondSizePx } = input;
    if (
        typeof availableSizePx !== 'number' || !Number.isFinite(availableSizePx) || availableSizePx <= 0
        || typeof minimumFirstSizePx !== 'number' || !Number.isFinite(minimumFirstSizePx) || minimumFirstSizePx < 0
        || typeof minimumSecondSizePx !== 'number' || !Number.isFinite(minimumSecondSizePx) || minimumSecondSizePx < 0
        || minimumFirstSizePx + minimumSecondSizePx > availableSizePx
    ) return null;
    return {
        minRatio: minimumFirstSizePx / availableSizePx,
        maxRatio: 1 - minimumSecondSizePx / availableSizePx,
    };
}

export function createSplitCanvasState<TLeafPayload>(input: Readonly<{
    root: SplitCanvasLeafNode<TLeafPayload> | null;
    focusedLeafId?: string | null;
    maximizedLeafId?: string | null;
}>): SplitCanvasState<TLeafPayload> {
    return {
        root: input.root,
        focusedLeafId: input.focusedLeafId ?? input.root?.id ?? null,
        maximizedLeafId: input.maximizedLeafId ?? null,
    };
}

function resolveValidFocusedLeafId<TLeafPayload>(
    root: SplitCanvasState<TLeafPayload>['root'],
    requestedLeafId: string | null | undefined,
): string | null {
    if (requestedLeafId && findSplitCanvasLeaf(root, requestedLeafId)) {
        return requestedLeafId;
    }
    return getFirstSplitCanvasLeafId(root);
}

export function splitCanvasReduce<TLeafPayload>(
    state: SplitCanvasState<TLeafPayload>,
    action: SplitCanvasAction<TLeafPayload>,
): SplitCanvasState<TLeafPayload> {
    const next = reduceSplitCanvasAction(state, action);
    // Every focus-producing transition must reveal its target, including tree edits.
    return next.maximizedLeafId && next.maximizedLeafId !== next.focusedLeafId
        ? { ...next, maximizedLeafId: null }
        : next;
}

function reduceSplitCanvasAction<TLeafPayload>(
    state: SplitCanvasState<TLeafPayload>,
    action: SplitCanvasAction<TLeafPayload>,
): SplitCanvasState<TLeafPayload> {
    switch (action.type) {
        case 'replaceRoot': {
            return {
                ...state,
                root: action.root,
                focusedLeafId: resolveValidFocusedLeafId(action.root, action.focusedLeafId ?? state.focusedLeafId),
                maximizedLeafId: state.maximizedLeafId && findSplitCanvasLeaf(action.root, state.maximizedLeafId)
                    ? state.maximizedLeafId
                    : null,
            };
        }
        case 'focusLeaf': {
            const focusedLeafId = resolveValidFocusedLeafId(state.root, action.leafId);
            if (state.focusedLeafId === focusedLeafId) {
                return state;
            }
            return {
                ...state,
                focusedLeafId,
            };
        }
        case 'splitLeaf': {
            if (!findSplitCanvasLeaf(state.root, action.targetLeafId)) return state;
            if (action.availableSizePx !== undefined || action.minimumFirstSizePx !== undefined || action.minimumSecondSizePx !== undefined) {
                const bounds = measuredRatioBounds(action);
                if (!bounds || bounds.minRatio > 0.5 || bounds.maxRatio < 0.5) return state;
            }
            const nextRoot = splitSplitCanvasLeaf(state.root, {
                targetLeafId: action.targetLeafId,
                axis: action.axis,
                placement: action.placement,
                newLeaf: action.newLeaf,
                ratio: 0.5,
            });
            return {
                ...state,
                root: nextRoot,
                focusedLeafId: action.newLeaf.id,
                maximizedLeafId: null,
            };
        }
        case 'replaceLeaf': {
            if (!findSplitCanvasLeaf(state.root, action.leafId)) return state;
            return {
                ...state,
                root: replaceSplitCanvasLeaf(state.root, action.leafId, action.nextLeaf),
                focusedLeafId: state.focusedLeafId === action.leafId ? action.nextLeaf.id : state.focusedLeafId,
                maximizedLeafId: state.maximizedLeafId === action.leafId ? action.nextLeaf.id : state.maximizedLeafId,
            };
        }
        case 'moveLeaf': {
            if (action.sourceLeafId === action.targetLeafId) return state;
            const sourceLeaf = findSplitCanvasLeaf(state.root, action.sourceLeafId);
            if (!sourceLeaf || !findSplitCanvasLeaf(state.root, action.targetLeafId)) return state;
            const removed = removeSplitCanvasLeaf(state.root, action.sourceLeafId);
            if (!removed.removedLeaf || !removed.nextRoot) return state;
            const nextRoot = splitSplitCanvasLeaf(removed.nextRoot, {
                targetLeafId: action.targetLeafId,
                axis: 'row',
                placement: action.placement,
                newLeaf: removed.removedLeaf,
                ratio: 0.5,
            });
            return {
                ...state,
                root: nextRoot,
                focusedLeafId: sourceLeaf.id,
                maximizedLeafId: state.maximizedLeafId === action.sourceLeafId ? sourceLeaf.id : state.maximizedLeafId,
            };
        }
        case 'closeLeaf': {
            const removed = removeSplitCanvasLeaf(state.root, action.leafId);
            if (!removed.removedLeaf) return state;
            return {
                ...state,
                root: removed.nextRoot,
                focusedLeafId: resolveValidFocusedLeafId(removed.nextRoot, removed.fallbackFocusLeafId),
                maximizedLeafId: state.maximizedLeafId === action.leafId ? null : state.maximizedLeafId,
            };
        }
        case 'toggleMaximizeLeaf': {
            if (!findSplitCanvasLeaf(state.root, action.leafId)) return state;
            return {
                ...state,
                maximizedLeafId: state.maximizedLeafId === action.leafId ? null : action.leafId,
                focusedLeafId: action.leafId,
            };
        }
        case 'restoreMaximize': {
            if (state.maximizedLeafId == null) return state;
            return {
                ...state,
                maximizedLeafId: null,
            };
        }
        case 'setSplitRatio': {
            const measured = action.availableSizePx !== undefined || action.minimumFirstSizePx !== undefined || action.minimumSecondSizePx !== undefined;
            const bounds = measured ? measuredRatioBounds(action) : null;
            if (measured && !bounds) return state;
            return {
                ...state,
                root: setSplitCanvasRatio(state.root, {
                    splitId: action.splitId,
                    ratio: action.ratio,
                    minRatio: bounds?.minRatio ?? SPLIT_CANVAS_RATIO_MIN,
                    maxRatio: bounds?.maxRatio ?? SPLIT_CANVAS_RATIO_MAX,
                }),
            };
        }
        case 'rebalanceRatios': {
            return {
                ...state,
                root: rebalanceSplitCanvasTree(state.root, {
                    minRatio: SPLIT_CANVAS_RATIO_MIN,
                    maxRatio: SPLIT_CANVAS_RATIO_MAX,
                }),
            };
        }
        default: {
            return state;
        }
    }
}
