import type { VoiceAttemptControlProjection } from '../attempt/useVoiceAttemptControl';
import type { VoiceReadAloud } from './VoiceReadAloud';

/** Active reading is projected once; callers choose whether a live call keeps its controls. */
export function resolveVoicePresenceReadAloud(
    voice: Pick<VoiceAttemptControlProjection, 'live' | 'canDismissFailedAttempt'>,
    readAloud: VoiceReadAloud | undefined,
    options: Readonly<{ includeLiveCall?: boolean }> = {},
): VoiceReadAloud | null {
    // Plugins retain their established standalone read-aloud surface by default. Core presence
    // containers opt into a live call's Reading label while retaining End/Mute/Stop controls.
    if (options.includeLiveCall !== true && voice.live && voice.canDismissFailedAttempt !== true) return null;
    return readAloud && readAloud.phase !== 'idle' ? readAloud : null;
}
