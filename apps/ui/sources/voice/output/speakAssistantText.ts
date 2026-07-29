import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import type { VoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { speakWithLocalTtsProvider } from '@/voice/backends/tts/runtime';
import { parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';

export async function speakAssistantText(params: {
  sessionId?: string | null;
  text: string;
  settings: any;
  networkTimeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  onSpeaking: () => void;
  onTtsFailed?: (error: VoiceMachineError) => void;
}): Promise<void> {
  const trimmed = params.text.trim();
  if (!trimmed) return;

  const { config } = resolveLocalVoiceAdapterSettings(params.settings);
  const tts = parseLocalVoiceTtsSettings(config?.tts);
  const registerPlaybackStopper =
    params.registerPlaybackStopper.captureAttempt?.() ?? params.registerPlaybackStopper;
  await speakWithLocalTtsProvider({
    sessionId: params.sessionId ?? null,
    text: trimmed,
    settings: params.settings,
    tts,
    networkTimeoutMs: params.networkTimeoutMs,
    registerPlaybackStopper,
    onSpeaking: params.onSpeaking,
    onTtsFailed: params.onTtsFailed,
  });
}
