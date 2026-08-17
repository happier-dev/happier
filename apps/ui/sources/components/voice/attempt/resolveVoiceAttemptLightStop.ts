import type { VoiceLightStop } from '@/components/voice/light/voiceLightTokens';
import type { VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';

/**
 * Which light stop the presence burns at, per canonical surface state.
 *
 * One owner for the whole app: the orb, the composer planet and Horizon all read the same answer,
 * so the colour of "thinking" cannot drift between surfaces. Values are the ones the design lab
 * established (`voiceLabModel.ts`), carried across unchanged.
 *
 * No `default` branch on purpose: a widened `VoiceSurfaceState` must fail to compile here rather
 * than silently render every new state in the idle colour.
 */
export function resolveVoiceAttemptLightStop(state: VoiceSurfaceState): VoiceLightStop {
    switch (state) {
        case 'idle':
        case 'connecting':
        case 'listening':
            return 'cool';
        case 'transcribing':
        case 'thinking':
        case 'reconnecting':
            return 'violet';
        case 'speaking':
        case 'permission_required':
        case 'error':
            return 'warm';
        case 'interrupted':
            return 'blush';
    }
    const exhaustive: never = state;
    throw new Error(`Unhandled voice surface state: ${String(exhaustive)}`);
}
