import type { PlanetDotPose } from '@happier-dev/brand/planet';

import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';

/** `mic` is the rest control; every other value is a Daybreak planet pose. */
export type VoiceMarkPose = 'mic' | PlanetDotPose;

/**
 * The attempt's semantic mark pose (owned by the attempt projection) drawn as a Brand planet pose:
 * Light = ready, Shadow = waiting on something outside, partial shade (rose) = failed or blocked.
 */
export function resolveVoiceMarkPose(voice: Pick<VoiceAttemptControlProjection, 'markPose'>): VoiceMarkPose {
    switch (voice.markPose) {
        case 'mic':
            return 'mic';
        case 'shadow':
            return 'shadow';
        case 'blocked':
            return 'shade';
        case 'light':
            return 'ready';
    }
}
