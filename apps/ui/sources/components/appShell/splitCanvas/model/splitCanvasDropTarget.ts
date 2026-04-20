import type { SplitCanvasDropTarget } from './splitCanvasTypes';

export type SplitCanvasClientRect = Readonly<{
    left: number;
    top: number;
    width: number;
    height: number;
}>;

const SPLIT_CANVAS_DROP_EDGE_RATIO = 0.24;

function clampRatio(value: number): number {
    if (Number.isNaN(value)) return 0.5;
    return Math.min(1, Math.max(0, value));
}

export function resolveSplitCanvasDropTarget(input: Readonly<{
    leafId: string;
    rect: SplitCanvasClientRect;
    clientX: number;
    clientY: number;
}>): SplitCanvasDropTarget {
    const xRatio = clampRatio((input.clientX - input.rect.left) / Math.max(1, input.rect.width));
    const yRatio = clampRatio((input.clientY - input.rect.top) / Math.max(1, input.rect.height));

    const distances = [
        { placement: 'left' as const, distance: xRatio },
        { placement: 'right' as const, distance: 1 - xRatio },
        { placement: 'up' as const, distance: yRatio },
        { placement: 'down' as const, distance: 1 - yRatio },
    ].sort((left, right) => left.distance - right.distance);

    const closest = distances[0] ?? null;
    if (closest && closest.distance <= SPLIT_CANVAS_DROP_EDGE_RATIO) {
        return {
            leafId: input.leafId,
            placement: closest.placement,
        };
    }

    return {
        leafId: input.leafId,
        placement: 'center',
    };
}
