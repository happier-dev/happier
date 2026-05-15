import type { WindowBounds, WindowPointer } from '../treeDragDropTypes';

export type VerticalThird = 'top' | 'middle' | 'bottom';

export function classifyVerticalThird(bounds: WindowBounds, pointer: WindowPointer): VerticalThird {
    const topBoundary = bounds.y + bounds.height / 3;
    const bottomBoundary = bounds.y + (bounds.height * 2) / 3;
    if (pointer.y < topBoundary) return 'top';
    if (pointer.y >= bottomBoundary) return 'bottom';
    return 'middle';
}
