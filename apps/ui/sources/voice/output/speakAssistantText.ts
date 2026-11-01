import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { speakWithLocalTtsProvider } from '@/voice/backends/tts/runtime';
import { patchLocalVoiceState, resolveLocalVoiceError } from '@/voice/local/localVoiceState';
import { toSpeechText, type SpeechTextContext } from '@/voice/output/speechText';

/**
 * Canonical entry for speaking assistant text in local voice. Normalizes markdown into speakable
 * text, routes to the configured provider, and reports provider failures as `tts_failed` in the
 * local voice state. A deliberate stop is not a failure. Never rejects: resolves `false` when the
 * provider failed (already reported) and `true` otherwise, so callers can skip the rest of a reply.
 */
export async function speakAssistantText(params: {
  text: string;
  speechTextContext?: SpeechTextContext;
  settings: any;
  networkTimeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  onSpeaking: () => void;
}): Promise<boolean> {
  const spoken = toSpeechText(params.text, params.speechTextContext);
  if (!spoken) return true;

  const voice = params.settings?.voice ?? null;
  const providerId = voice?.providerId;
  const adapter =
    providerId === 'local_direct'
      ? voice?.adapters?.local_direct
      : voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct;

  let providerLabel = 'unknown';
  try {
    const tts = VoiceLocalTtsSchema.parse(adapter?.tts ?? {});
    providerLabel = tts.provider;
    await speakWithLocalTtsProvider({
      text: spoken,
      settings: params.settings,
      tts,
      networkTimeoutMs: params.networkTimeoutMs,
      registerPlaybackStopper: params.registerPlaybackStopper,
      onSpeaking: params.onSpeaking,
    });
    return true;
  } catch (error) {
    console.warn(`[voice/tts] ${providerLabel} speech failed`, error instanceof Error ? error.message : error);
    patchLocalVoiceState(resolveLocalVoiceError(error, 'tts_failed'));
    return false;
  }
}
