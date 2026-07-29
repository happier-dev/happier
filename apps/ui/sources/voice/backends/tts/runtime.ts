import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import type { VoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { localVoiceTtsController } from '@/voice/backends/tts/localVoiceTtsController';

export async function speakWithLocalTtsProvider(ctx: {
  sessionId?: string | null;
  text: string;
  settings: any;
  tts: VoiceLocalTtsSettings;
  networkTimeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  onSpeaking: () => void;
  onTtsFailed?: (error: VoiceMachineError) => void;
}): Promise<void> {
  await localVoiceTtsController.speak(ctx);
}
