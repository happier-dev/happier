import type { WindowBounds } from '../treeDragDropTypes';
import type { TreeDropMeasurableRef } from './treeDropRegistryTypes';

function isUsableBounds(bounds: WindowBounds): boolean {
    return Number.isFinite(bounds.x)
        && Number.isFinite(bounds.y)
        && Number.isFinite(bounds.width)
        && Number.isFinite(bounds.height)
        && bounds.width >= 0
        && bounds.height >= 0;
}

export function measureWindowBounds(ref: TreeDropMeasurableRef | null): Promise<WindowBounds | null> {
    if (!ref || typeof ref.measureInWindow !== 'function') return Promise.resolve(null);
    return new Promise((resolve) => {
        ref.measureInWindow?.((x, y, width, height) => {
            const bounds = { x, y, width, height };
            resolve(isUsableBounds(bounds) ? bounds : null);
        });
    });
}
