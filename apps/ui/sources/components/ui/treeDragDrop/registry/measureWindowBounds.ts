import type { WindowBounds } from '../treeDragDropTypes';
import type { TreeDropMeasurableRef } from './treeDropRegistryTypes';
import { isFiniteRect } from '../geometry/treeDropCoordinateSpace';

/** Narrow RN, DOM and ScrollView hosts at the single platform measurement boundary. */
export function toTreeDropMeasurableRef(node: unknown): TreeDropMeasurableRef | null {
    const visited = new Set<object>();
    let nativeRef: TreeDropMeasurableRef | null = null;
    while (node && typeof node === 'object' && !visited.has(node)) {
        visited.add(node);
        const host = node as TreeDropMeasurableRef & { getNativeScrollRef?: () => unknown; getBoundingClientRect?: () => WindowBounds };
        // RN Web decorates the DOM scroll node with getNativeScrollRef returning itself.
        // Measure that node before unwrapping; a cycle must not discard usable geometry.
        if (typeof host.getBoundingClientRect === 'function') return { getBoundingClientRectFn: () => host.getBoundingClientRect!() };
        if (typeof host.getBoundingClientRectFn === 'function') return host;
        if (typeof host.measureInWindow === 'function') nativeRef = { measureInWindow: callback => host.measureInWindow!(callback) };
        node = typeof host.getNativeScrollRef === 'function' ? host.getNativeScrollRef() : null;
    }
    return nativeRef;
}

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
export function measureWindowBounds(node: unknown): Promise<WindowBounds | null> {
    const ref = toTreeDropMeasurableRef(node);
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

/** Runtime hit-testing shares the DOM clock with scrolling; native callers use the async boundary. */
export function readWindowBounds(node: unknown): WindowBounds | null {
    const ref = toTreeDropMeasurableRef(node);
    if (!ref?.getBoundingClientRectFn) return null;
    const rect = ref.getBoundingClientRectFn();
    const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    return isFiniteRect(bounds) ? bounds : null;
}
