import type { WindowBounds, WindowPointer } from '../treeDragDropTypes';
import { isFiniteRect } from './treeDropCoordinateSpace';

export type EntityHostedViewport = Readonly<{
    bounds: WindowBounds;
    localWidth: number;
    localHeight: number;
}>;

/** Convert the hosted viewport's client coordinates using its current measured embedding. */
export function entityHostedPointerToWindow(pointer: WindowPointer, viewport: EntityHostedViewport): WindowPointer | null {
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)
        || !isFiniteRect(viewport.bounds) || viewport.bounds.width <= 0 || viewport.bounds.height <= 0
        || !Number.isFinite(viewport.localWidth) || viewport.localWidth <= 0
        || !Number.isFinite(viewport.localHeight) || viewport.localHeight <= 0) return null;
    return {
        x: viewport.bounds.x + pointer.x * viewport.bounds.width / viewport.localWidth,
        y: viewport.bounds.y + pointer.y * viewport.bounds.height / viewport.localHeight,
    };
}
