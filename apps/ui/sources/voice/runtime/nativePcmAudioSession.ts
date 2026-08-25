/**
 * Shared host PCM capture runs while the native player can render Voice output.
 * Every such consumer uses one conversation request so the coordinator can
 * admit the capture only after native AEC becomes active.
 */
export const VOICE_PCM_CONVERSATION_AUDIO_SESSION = Object.freeze({
  mode: 'conversation' as const,
  input: true,
  output: true,
  aec: 'required' as const,
});
