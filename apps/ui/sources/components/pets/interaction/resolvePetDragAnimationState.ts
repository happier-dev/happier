import type { PetAnimationStateV1 } from '@happier-dev/protocol';

import { PET_DRAG_THRESHOLD_PX } from './petPointerDragConfig';

export function resolvePetDragAnimationState(
    deltaX: number,
    fallbackState: PetAnimationStateV1 | null,
): PetAnimationStateV1 | null {
    if (deltaX >= PET_DRAG_THRESHOLD_PX) return 'running-right';
    if (deltaX <= -PET_DRAG_THRESHOLD_PX) return 'running-left';
    return fallbackState;
}
