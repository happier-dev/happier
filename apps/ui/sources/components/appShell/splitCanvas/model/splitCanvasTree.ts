import type {
    SplitCanvasAxis,
    SplitCanvasDirection,
    SplitCanvasLeafNode,
    SplitCanvasLeafRect,
    SplitCanvasNode,
    SplitCanvasPlacement,
    SplitCanvasSplitNode,
} from './splitCanvasTypes';

let nextGeneratedSplitId = 1;

function clampRatio(ratio: number, minRatio: number, maxRatio: number): number {
    return Math.min(maxRatio, Math.max(minRatio, ratio));
}

export function createSplitCanvasSplitNode<TLeafPayload>(
    params: Readonly<{
        axis: SplitCanvasAxis;
        placement: SplitCanvasPlacement;
        targetLeaf: SplitCanvasLeafNode<TLeafPayload>;
        newLeaf: SplitCanvasLeafNode<TLeafPayload>;
        ratio: number;
    }>,
): SplitCanvasSplitNode<TLeafPayload> {
    const splitId = `split:${nextGeneratedSplitId++}`;
    if (params.placement === 'before') {
        return {
            id: splitId,
            kind: 'split',
            axis: params.axis,
            ratio: params.ratio,
            first: params.newLeaf,
            second: params.targetLeaf,
        };
    }
    return {
        id: splitId,
        kind: 'split',
        axis: params.axis,
        ratio: params.ratio,
        first: params.targetLeaf,
        second: params.newLeaf,
    };
}

export function collectSplitCanvasLeaves<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
): SplitCanvasLeafNode<TLeafPayload>[] {
    if (!node) return [];
    if (node.kind === 'leaf') return [node];
    return [
        ...collectSplitCanvasLeaves(node.first),
        ...collectSplitCanvasLeaves(node.second),
    ];
}

export function countSplitCanvasLeaves<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
): number {
    return collectSplitCanvasLeaves(node).length;
}

export function findSplitCanvasLeaf<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
    leafId: string,
): SplitCanvasLeafNode<TLeafPayload> | null {
    if (!node) return null;
    if (node.kind === 'leaf') {
        return node.id === leafId ? node : null;
    }
    return findSplitCanvasLeaf(node.first, leafId) ?? findSplitCanvasLeaf(node.second, leafId);
}

export function findSplitCanvasSplit<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
    splitId: string,
): SplitCanvasSplitNode<TLeafPayload> | null {
    if (!node || node.kind === 'leaf') return null;
    if (node.id === splitId) return node;
    return findSplitCanvasSplit(node.first, splitId) ?? findSplitCanvasSplit(node.second, splitId);
}

export function splitSplitCanvasLeaf<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
    params: Readonly<{
        targetLeafId: string;
        axis: SplitCanvasAxis;
        placement: SplitCanvasPlacement;
        newLeaf: SplitCanvasLeafNode<TLeafPayload>;
        ratio: number;
    }>,
): SplitCanvasNode<TLeafPayload> | null {
    if (!node) return null;
    if (node.kind === 'leaf') {
        if (node.id !== params.targetLeafId) return node;
        return createSplitCanvasSplitNode({
            axis: params.axis,
            placement: params.placement,
            targetLeaf: node,
            newLeaf: params.newLeaf,
            ratio: params.ratio,
        });
    }

    const nextFirst = splitSplitCanvasLeaf(node.first, params);
    if (nextFirst !== node.first) {
        return { ...node, first: nextFirst ?? node.first };
    }
    const nextSecond = splitSplitCanvasLeaf(node.second, params);
    if (nextSecond !== node.second) {
        return { ...node, second: nextSecond ?? node.second };
    }
    return node;
}

export function replaceSplitCanvasLeaf<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
    leafId: string,
    nextLeaf: SplitCanvasLeafNode<TLeafPayload>,
): SplitCanvasNode<TLeafPayload> | null {
    if (!node) return null;
    if (node.kind === 'leaf') {
        return node.id === leafId ? nextLeaf : node;
    }

    const nextFirst = replaceSplitCanvasLeaf(node.first, leafId, nextLeaf);
    if (nextFirst !== node.first) return { ...node, first: nextFirst ?? node.first };
    const nextSecond = replaceSplitCanvasLeaf(node.second, leafId, nextLeaf);
    if (nextSecond !== node.second) return { ...node, second: nextSecond ?? node.second };
    return node;
}

export function setSplitCanvasRatio<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
    params: Readonly<{
        splitId: string;
        ratio: number;
        minRatio: number;
        maxRatio: number;
    }>,
): SplitCanvasNode<TLeafPayload> | null {
    if (!node) return null;
    if (node.kind === 'leaf') return node;
    if (node.id === params.splitId) {
        return {
            ...node,
            ratio: clampRatio(params.ratio, params.minRatio, params.maxRatio),
        };
    }
    const nextFirst = setSplitCanvasRatio(node.first, params);
    if (nextFirst !== node.first) return { ...node, first: nextFirst ?? node.first };
    const nextSecond = setSplitCanvasRatio(node.second, params);
    if (nextSecond !== node.second) return { ...node, second: nextSecond ?? node.second };
    return node;
}

export function rebalanceSplitCanvasTree<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
    params: Readonly<{
        minRatio: number;
        maxRatio: number;
    }>,
): SplitCanvasNode<TLeafPayload> | null {
    if (!node || node.kind === 'leaf') return node;
    return {
        ...node,
        ratio: clampRatio(node.ratio, params.minRatio, params.maxRatio),
        first: rebalanceSplitCanvasTree(node.first, params) ?? node.first,
        second: rebalanceSplitCanvasTree(node.second, params) ?? node.second,
    };
}

export type RemoveSplitCanvasLeafResult<TLeafPayload> = Readonly<{
    nextRoot: SplitCanvasNode<TLeafPayload> | null;
    removedLeaf: SplitCanvasLeafNode<TLeafPayload> | null;
    fallbackFocusLeafId: string | null;
}>;

export function removeSplitCanvasLeaf<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
    leafId: string,
): RemoveSplitCanvasLeafResult<TLeafPayload> {
    if (!node) {
        return {
            nextRoot: null,
            removedLeaf: null,
            fallbackFocusLeafId: null,
        };
    }

    if (node.kind === 'leaf') {
        if (node.id !== leafId) {
            return {
                nextRoot: node,
                removedLeaf: null,
                fallbackFocusLeafId: null,
            };
        }
        return {
            nextRoot: null,
            removedLeaf: node,
            fallbackFocusLeafId: null,
        };
    }

    const left = removeSplitCanvasLeaf(node.first, leafId);
    if (left.removedLeaf) {
        if (!left.nextRoot) {
            return {
                nextRoot: node.second,
                removedLeaf: left.removedLeaf,
                fallbackFocusLeafId: getFirstSplitCanvasLeafId(node.second),
            };
        }
        return {
            nextRoot: { ...node, first: left.nextRoot },
            removedLeaf: left.removedLeaf,
            fallbackFocusLeafId: left.fallbackFocusLeafId,
        };
    }

    const right = removeSplitCanvasLeaf(node.second, leafId);
    if (right.removedLeaf) {
        if (!right.nextRoot) {
            return {
                nextRoot: node.first,
                removedLeaf: right.removedLeaf,
                fallbackFocusLeafId: getLastSplitCanvasLeafId(node.first),
            };
        }
        return {
            nextRoot: { ...node, second: right.nextRoot },
            removedLeaf: right.removedLeaf,
            fallbackFocusLeafId: right.fallbackFocusLeafId,
        };
    }

    return {
        nextRoot: node,
        removedLeaf: null,
        fallbackFocusLeafId: null,
    };
}

export function getFirstSplitCanvasLeafId<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
): string | null {
    if (!node) return null;
    if (node.kind === 'leaf') return node.id;
    return getFirstSplitCanvasLeafId(node.first) ?? getFirstSplitCanvasLeafId(node.second);
}

export function getLastSplitCanvasLeafId<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
): string | null {
    if (!node) return null;
    if (node.kind === 'leaf') return node.id;
    return getLastSplitCanvasLeafId(node.second) ?? getLastSplitCanvasLeafId(node.first);
}

export function splitCanvasSubtreeContainsLeaf<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
    leafId: string | null,
): boolean {
    if (!node || !leafId) return false;
    if (node.kind === 'leaf') return node.id === leafId;
    return splitCanvasSubtreeContainsLeaf(node.first, leafId) || splitCanvasSubtreeContainsLeaf(node.second, leafId);
}

export function collectSplitCanvasLeafRects<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
    rect: Readonly<{ x: number; y: number; width: number; height: number }> = {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
    },
): SplitCanvasLeafRect[] {
    if (!node) return [];
    if (node.kind === 'leaf') {
        return [{
            leafId: node.id,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        }];
    }

    if (node.axis === 'row') {
        const firstWidth = rect.width * node.ratio;
        const secondWidth = rect.width - firstWidth;
        return [
            ...collectSplitCanvasLeafRects(node.first, {
                x: rect.x,
                y: rect.y,
                width: firstWidth,
                height: rect.height,
            }),
            ...collectSplitCanvasLeafRects(node.second, {
                x: rect.x + firstWidth,
                y: rect.y,
                width: secondWidth,
                height: rect.height,
            }),
        ];
    }

    const firstHeight = rect.height * node.ratio;
    const secondHeight = rect.height - firstHeight;
    return [
        ...collectSplitCanvasLeafRects(node.first, {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: firstHeight,
        }),
        ...collectSplitCanvasLeafRects(node.second, {
            x: rect.x,
            y: rect.y + firstHeight,
            width: rect.width,
            height: secondHeight,
        }),
    ];
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
    return Math.min(endA, endB) - Math.max(startA, startB) > 0.0001;
}

function resolveDirectionCandidateDistance(
    current: SplitCanvasLeafRect,
    candidate: SplitCanvasLeafRect,
    direction: SplitCanvasDirection,
): number | null {
    const epsilon = 0.0001;
    if (direction === 'left') {
        if (Math.abs((candidate.x + candidate.width) - current.x) > epsilon) return null;
        if (!rangesOverlap(current.y, current.y + current.height, candidate.y, candidate.y + candidate.height)) return null;
        return Math.abs((candidate.y + (candidate.height / 2)) - (current.y + (current.height / 2)));
    }
    if (direction === 'right') {
        if (Math.abs((current.x + current.width) - candidate.x) > epsilon) return null;
        if (!rangesOverlap(current.y, current.y + current.height, candidate.y, candidate.y + candidate.height)) return null;
        return Math.abs((candidate.y + (candidate.height / 2)) - (current.y + (current.height / 2)));
    }
    if (direction === 'up') {
        if (Math.abs((candidate.y + candidate.height) - current.y) > epsilon) return null;
        if (!rangesOverlap(current.x, current.x + current.width, candidate.x, candidate.x + candidate.width)) return null;
        return Math.abs((candidate.x + (candidate.width / 2)) - (current.x + (current.width / 2)));
    }
    if (Math.abs((current.y + current.height) - candidate.y) > epsilon) return null;
    if (!rangesOverlap(current.x, current.x + current.width, candidate.x, candidate.x + candidate.width)) return null;
    return Math.abs((candidate.x + (candidate.width / 2)) - (current.x + (current.width / 2)));
}

export function findAdjacentSplitCanvasLeafIdInTree<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
    leafId: string,
    direction: SplitCanvasDirection,
): string | null {
    const rects = collectSplitCanvasLeafRects(node);
    const current = rects.find((entry) => entry.leafId === leafId);
    if (!current) return null;

    let bestLeafId: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of rects) {
        if (candidate.leafId === leafId) continue;
        const distance = resolveDirectionCandidateDistance(current, candidate, direction);
        if (distance == null) continue;
        if (distance < bestDistance) {
            bestDistance = distance;
            bestLeafId = candidate.leafId;
        }
    }

    return bestLeafId;
}
