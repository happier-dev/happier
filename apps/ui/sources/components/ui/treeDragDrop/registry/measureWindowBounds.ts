import type { WindowBounds } from '../treeDragDropTypes';
import type { TreeDropMeasurableRef } from './treeDropRegistryTypes';
import { isFiniteRect } from '../geometry/treeDropCoordinateSpace';

/**
 * Platform measurement boundary for tree drag/drop geometry.
 *
 * Plan section 3.1: this is the ONLY place that touches a platform measurement
 * API. It has two paths:
 * - synchronous web path: when the ref exposes `getBoundingClientRectFn`, read
 *   it directly. This shares the DOM clock with `scrollTop`, eliminating the
 *   stale-bounds drift the old async `measureInWindow` + scroll-rebase model
 *   produced (plan section 1.4).
 * - asynchronous native path: fall back to `measureInWindow` for native refs.
 *
 * Window bounds are a boundary type only — callers immediately convert them to
 * content coordinates via `treeDropCoordinateSpace` and never store them.
 */
export function measureWindowBounds(ref: TreeDropMeasurableRef | null): Promise<WindowBounds | null> {
    if (!ref) return Promise.resolve(null);

    if (typeof ref.getBoundingClientRectFn === 'function') {
        const rect = ref.getBoundingClientRectFn();
        const bounds: WindowBounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        return Promise.resolve(isFiniteRect(bounds) ? bounds : null);
    }

    if (typeof ref.measureInWindow !== 'function') return Promise.resolve(null);
    return new Promise((resolve) => {
        ref.measureInWindow?.((x, y, width, height) => {
            const bounds: WindowBounds = { x, y, width, height };
            resolve(isFiniteRect(bounds) ? bounds : null);
        });
    });
}
