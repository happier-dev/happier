import type { EntityDragCarry } from './entityDragDropTypes';
import type { WindowPointer } from './treeDragDropTypes';

/** Incumbent whole-row activation distance shared by entity source adapters. */
export { ENTITY_DRAG_ACTIVATION_DISTANCE_PX } from '@happier-dev/protocol/plugins/ui';

/** RNGH onEnd(event, success) commits only success=true; onFinalize always runs, including failure. */
export function createEntityDragGestureAdapter(carry: EntityDragCarry) {
    let ended = false;
    return {
        update: (pointer: WindowPointer | null) => { if (!ended) carry.move(pointer); },
        end: (success: boolean, pointer?: WindowPointer | null) => {
            if (ended) return Promise.resolve(null);
            ended = true;
            if (!success) { carry.cancel('gesture-unsuccessful'); return Promise.resolve(null); }
            // An ended gesture may have no newer coordinates; retain its last measured target.
            if (pointer != null) carry.move(pointer);
            return carry.release();
        },
        finalize: () => {
            if (ended) return;
            ended = true;
            carry.cancel('gesture-finalize');
        },
        cancel: () => { if (!ended) { ended = true; carry.cancel('gesture-cancel'); } },
    };
}
