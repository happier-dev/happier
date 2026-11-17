import type { PetAnimationStateV1 } from '@happier-dev/protocol/pets/constants';
import type { BotFaceMood } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';
import type { BotActivity } from '@/components/sessions/bots/botActivity';

export const petActivityPose = {
    needsYou: 'waiting',
    working: 'running',
    quiet: 'idle',
} as const satisfies Record<BotActivity, PetAnimationStateV1>;

/** A pet worn as a Bot's face: the companion's poses, plus the face's two outcomes (DECISIONS-R11 §8). */
export const petFacePose = {
    ...petActivityPose,
    done: 'waving',
    failed: 'failed',
} as const satisfies Record<BotFaceMood, PetAnimationStateV1>;
