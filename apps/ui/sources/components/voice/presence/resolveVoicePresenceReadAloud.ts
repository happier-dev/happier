import type { VoiceAttemptControlProjection } from '../attempt/useVoiceAttemptControl';
import type { VoiceReadAloud } from './VoiceReadAloud';

/** Active reading takes the presence slot over retained call results, without dismissing them. */
export function resolveVoicePresenceReadAloud(
    voice: Pick<VoiceAttemptControlProjection, 'live' | 'canDismissFailedAttempt'>,
    readAloud: VoiceReadAloud | undefined,
): VoiceReadAloud | null {
    // Failed attempts retain live=true; the lifecycle's dismissal fact identifies their result.
    if (voice.live && voice.canDismissFailedAttempt !== true) return null;
    return readAloud && readAloud.phase !== 'idle' ? readAloud : null;
}
