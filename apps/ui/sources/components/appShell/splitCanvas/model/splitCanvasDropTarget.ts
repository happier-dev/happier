import type { SplitCanvasDropTarget } from './splitCanvasTypes';

export type SplitCanvasClientRect = Readonly<{
    left: number;
    top: number;
    width: number;
    height: number;
}>;

const SPLIT_CANVAS_DROP_EDGE_RATIO = 0.24;

/** Normalized pane regions shared by hit-testing and feedback. Side edges own corners. */
const edge = SPLIT_CANVAS_DROP_EDGE_RATIO;
const far = 1 - edge;
const DROP_ZONES = {
    left: { left: 0, top: 0, right: edge, bottom: 1 },
    right: { left: far, top: 0, right: 1, bottom: 1 },
    up: { left: edge, top: 0, right: far, bottom: edge },
    down: { left: edge, top: far, right: far, bottom: 1 },
    center: { left: edge, top: edge, right: far, bottom: far },
} as const;

export function readSplitCanvasDropZone(placement: SplitCanvasDropTarget['placement']) {
    return DROP_ZONES[placement];
}

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

    for (const placement of ['left', 'right', 'up', 'down'] as const) {
        const zone = readSplitCanvasDropZone(placement);
        if (xRatio >= zone.left && xRatio <= zone.right && yRatio >= zone.top && yRatio <= zone.bottom) {
            return { leafId: input.leafId, placement };
        }
    }

    return {
        leafId: input.leafId,
        placement: 'center',
    };
}
