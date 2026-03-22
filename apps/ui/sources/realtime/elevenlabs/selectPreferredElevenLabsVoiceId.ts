import type { ElevenLabsVoiceSummary } from './elevenLabsVoices';

export function selectPreferredElevenLabsVoiceId(params: {
  requestedVoiceId: string | null;
  availableVoices: ElevenLabsVoiceSummary[];
}): string | null {
  const requestedVoiceId = typeof params.requestedVoiceId === 'string' ? params.requestedVoiceId.trim() : '';
  const availableVoices = Array.isArray(params.availableVoices) ? params.availableVoices : [];

  if (requestedVoiceId.length > 0 && availableVoices.some((voice) => voice.voiceId === requestedVoiceId)) {
    return requestedVoiceId;
  }

  const firstAvailableVoiceId = availableVoices.find((voice) => typeof voice.voiceId === 'string' && voice.voiceId.trim().length > 0)?.voiceId ?? null;
  if (firstAvailableVoiceId) return firstAvailableVoiceId;
  return requestedVoiceId.length > 0 ? requestedVoiceId : null;
}
