import type { VoiceAttemptControlProjection } from '../attempt/useVoiceAttemptControl';
import type { VoiceReadAloud } from './VoiceReadAloud';

export type VoicePresenceReading = Readonly<{
    readAloud: VoiceReadAloud;
    /**
     * No call that can still be stopped runs beside the reading (idle, a clean end, or a retained
     * failure): the compact containers show the reading alone, with its Stop as their one control.
     * Otherwise the call keeps its own controls and the reading's Stop joins them.
     */
    alone: boolean;
}>;

/**
 * Active reading, projected once for every presence host. A retained failure still reads as `live`
 * (its recovery stays presented) but has no call to keep controllable, so it is not one here.
 */
export function resolveVoicePresenceReadAloud(
    voice: Pick<VoiceAttemptControlProjection, 'canStop'>,
    readAloud: VoiceReadAloud | null | undefined,
): VoicePresenceReading | null {
    if (!readAloud || readAloud.phase === 'idle') return null;
    return { readAloud, alone: !voice.canStop };
}
