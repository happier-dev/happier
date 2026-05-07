import type { PetAnimationStateV1 } from '@happier-dev/protocol';

import {
    resolvePetAnimationTimeline,
    type ResolvedPetAnimationFrame,
} from '@/components/pets/animation/resolvePetAnimationTimeline';

export type { ResolvedPetAnimationFrame };

export type ResolvePetAnimationFrameInput = Readonly<{
    state: PetAnimationStateV1;
    elapsedMs: number;
    reducedMotion: boolean;
}>;

export function resolvePetAnimationFrame(input: ResolvePetAnimationFrameInput): ResolvedPetAnimationFrame {
    return resolvePetAnimationTimeline(input);
}
