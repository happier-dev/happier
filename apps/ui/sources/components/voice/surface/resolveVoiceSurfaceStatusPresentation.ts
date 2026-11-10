import type { VoiceSurfaceState } from './resolveVoiceSurfaceState';

/**
 * Semantic paint intent, not a colour. Presentations map a tone onto their own material
 * (`theme.colors.status.*` for the panel surfaces) so the projection stays theme-agnostic and
 * every presentation of a state agrees on what that state means.
 */
export type VoiceSurfaceStatusTone = 'neutral' | 'pending' | 'active' | 'error';

export type VoiceSurfaceStatusPresentation = Readonly<{
  tone: VoiceSurfaceStatusTone;
  /** Compact presence text; the full label remains the accessibility/description source. */
  wordKey?: 'voiceAssistant.microphoneBlocked';
  labelKey:
    | 'voiceAssistant.label'
    | 'voiceAssistant.connected'
    | 'voiceAssistant.connecting'
    | 'voiceAssistant.ending'
    | 'voiceAssistant.reconnecting'
    | 'voiceAssistant.listening'
    | 'voiceAssistant.transcribing'
    | 'voiceAssistant.thinking'
    | 'voiceAssistant.speaking'
    | 'voiceAssistant.microphonePermissionRequired'
    | 'voiceAssistant.interrupted'
    | 'common.error'
    | 'voiceAssistant.connectionError';
}>;

/**
 * Single owner of `surfaceState → { tone, labelKey }`. It carries no `default` branch on purpose:
 * a widened `VoiceSurfaceState` must fail to compile here rather than render as "Voice assistant"
 * in every presentation at once.
 */
export function resolveVoiceSurfaceStatusPresentation(
  state: VoiceSurfaceState,
  failureReason?: string | null,
): VoiceSurfaceStatusPresentation {
  switch (state) {
    case 'idle':
      return { tone: 'neutral', labelKey: 'voiceAssistant.label' };
    case 'live':
      return { tone: 'active', labelKey: 'voiceAssistant.connected' };
    case 'connecting':
      return { tone: 'pending', labelKey: 'voiceAssistant.connecting' };
    case 'ending':
      return { tone: 'pending', labelKey: 'voiceAssistant.ending' };
    case 'reconnecting':
      return { tone: 'pending', labelKey: 'voiceAssistant.reconnecting' };
    case 'listening':
      return { tone: 'active', labelKey: 'voiceAssistant.listening' };
    case 'transcribing':
      return { tone: 'pending', labelKey: 'voiceAssistant.transcribing' };
    case 'thinking':
      return { tone: 'pending', labelKey: 'voiceAssistant.thinking' };
    case 'speaking':
      return { tone: 'active', labelKey: 'voiceAssistant.speaking' };
    case 'permission_required':
      return { tone: 'error', labelKey: 'voiceAssistant.microphonePermissionRequired', wordKey: 'voiceAssistant.microphoneBlocked' };
    case 'interrupted':
      return { tone: 'pending', labelKey: 'voiceAssistant.interrupted' };
    case 'error':
      return {
        tone: 'error',
        labelKey: failureReason === 'voice_connection_failed' || failureReason === 'voice_connection_timeout'
          ? 'voiceAssistant.connectionError' : 'common.error',
      };
  }
  const exhaustive: never = state;
  throw new Error(`Unhandled voice surface state: ${String(exhaustive)}`);
}
