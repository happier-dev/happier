import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { speakWithLocalTtsProvider } from '@/voice/backends/tts/runtime';

export async function speakAssistantText(params: {
  text: string;
  settings: any;
  networkTimeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  onSpeaking: () => void;
}): Promise<void> {
  const trimmed = params.text.trim();
  if (!trimmed) return;

  const voice = params.settings?.voice ?? null;
  const providerId = voice?.providerId;
  const adapter =
    providerId === 'local_direct'
      ? voice?.adapters?.local_direct
      : voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct;

  const tts = VoiceLocalTtsSchema.parse(adapter?.tts ?? {});
  await speakWithLocalTtsProvider({
    text: trimmed,
    settings: params.settings,
    tts,
    networkTimeoutMs: params.networkTimeoutMs,
    registerPlaybackStopper: params.registerPlaybackStopper,
    onSpeaking: params.onSpeaking,
  });
}
