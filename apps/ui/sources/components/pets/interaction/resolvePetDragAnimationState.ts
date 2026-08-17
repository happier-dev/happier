import type { PetAnimationStateV1 } from '@happier-dev/protocol';

import { COMPANION_DRAG_THRESHOLD_PX } from '@/components/companion/interaction/companionPointerDragConfig';

/**
 * The pet's own reading of a drag: horizontal motion becomes a running animation. This is the
 * `resolveDragState` the pet hands to the shared companion drag hooks — the hooks themselves know
 * nothing about pet animation vocabulary.
 */
export function resolvePetDragAnimationState(
    deltaX: number,
    fallbackState: PetAnimationStateV1 | null,
): PetAnimationStateV1 | null {
    'worklet';
    if (deltaX >= COMPANION_DRAG_THRESHOLD_PX) return 'running-right';
    if (deltaX <= -COMPANION_DRAG_THRESHOLD_PX) return 'running-left';
    return fallbackState;
}

/**
 * The `resolveDragState` slot of `useCompanionNativePanGesture` is read from inside
 * `Gesture.Pan().onUpdate`, which the worklets Babel plugin runs on the UI runtime. Its input is the
 * live per-frame translation, so there is nothing to hoist out of the worklet — the resolver has to
 * run there, and therefore has to be one. Naming the slot value here, instead of letting each native
 * mount inline an unmarked arrow, keeps that obligation in a single checkable place.
 */
export function resolvePetNativeDragAnimationState(deltaX: number): PetAnimationStateV1 | null {
    'worklet';
    return resolvePetDragAnimationState(deltaX, null);
}
