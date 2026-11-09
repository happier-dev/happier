import type { AnchoredListPositionV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import type { WindowBounds, WindowPointer } from '../treeDragDropTypes';

/** How a flat list lays its items out: a column of rows, or a row of tabs (the spaces strip). */
export type EntityFlatAxis = 'vertical' | 'horizontal';

/**
 * The measured flat-row strategy; layout/custody decisions remain with the domain owner. A row splits at its
 * vertical middle; a tab in a row splits at its horizontal middle, mirrored right to left.
 */
export function resolveEntityFlatRowPosition(id: string, bounds: WindowBounds, pointer: WindowPointer,
    axis: EntityFlatAxis = 'vertical', rtl = false): AnchoredListPositionV1 {
    const leading = axis === 'vertical' ? pointer.y < bounds.y + bounds.height / 2
        : (pointer.x < bounds.x + bounds.width / 2) !== rtl;
    return { anchorId: id, placement: leading ? 'before' : 'after' };
}

/** Index is presentation-only. The staged destination and final mutation always use an anchor. */
export function entityFlatPositionAtIndex(ids: readonly string[], sourceId: string, index: number): AnchoredListPositionV1 | null {
    if (!ids.includes(sourceId)) return null;
    const others = ids.filter(id => id !== sourceId);
    const clamped = Math.max(0, Math.min(index, others.length));
    return clamped === 0
        ? { anchorId: others[0] ?? null, placement: 'before' }
        : { anchorId: others[clamped - 1]!, placement: 'after' };
}
