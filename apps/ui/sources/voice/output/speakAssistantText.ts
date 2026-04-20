import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { speakWithLocalTtsProvider } from '@/voice/backends/tts/runtime';
import { parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';

export async function speakAssistantText(params: {
  sessionId?: string | null;
  text: string;
  settings: any;
  networkTimeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  onSpeaking: () => void;
}): Promise<void> {
  const trimmed = params.text.trim();
  if (!trimmed) return;

  const { config } = resolveLocalVoiceAdapterSettings(params.settings);
  const tts = parseLocalVoiceTtsSettings(config?.tts);
  await speakWithLocalTtsProvider({
    sessionId: params.sessionId ?? null,
    text: trimmed,
    settings: params.settings,
    tts,
    networkTimeoutMs: params.networkTimeoutMs,
    registerPlaybackStopper: params.registerPlaybackStopper,
    onSpeaking: params.onSpeaking,
  });
}
