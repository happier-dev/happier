import type { VoiceAttemptControlProjection } from '../attempt/useVoiceAttemptControl';
import type { VoiceReadAloud } from './VoiceReadAloud';

/** Active reading is projected once; live calls keep their controls and show the phase in them. */
export function resolveVoicePresenceReadAloud(
    voice: Pick<VoiceAttemptControlProjection, 'live' | 'canDismissFailedAttempt'>,
    readAloud: VoiceReadAloud | undefined,
): VoiceReadAloud | null {
    // Containers decide whether the phase replaces a retained result or joins a live call.
    void voice;
    return readAloud && readAloud.phase !== 'idle' ? readAloud : null;
}
