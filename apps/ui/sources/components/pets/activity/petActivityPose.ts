import type { PetAnimationStateV1 } from '@happier-dev/protocol/pets/constants';
import type { BotActivity } from '@/components/sessions/bots/botActivity';

export const petActivityPose = {
    needsYou: 'waiting',
    working: 'running',
    quiet: 'idle',
} as const satisfies Record<BotActivity, PetAnimationStateV1>;
