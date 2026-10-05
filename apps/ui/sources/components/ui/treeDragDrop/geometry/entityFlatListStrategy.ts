import type { AnchoredListPositionV1 } from '@happier-dev/protocol';
import type { WindowBounds, WindowPointer } from '../treeDragDropTypes';

/** The measured flat-row strategy; layout/custody decisions remain with the domain owner. */
export function resolveEntityFlatRowPosition(id: string, bounds: WindowBounds, pointer: WindowPointer): AnchoredListPositionV1 {
    return { anchorId: id, placement: pointer.y < bounds.y + bounds.height / 2 ? 'before' : 'after' };
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
