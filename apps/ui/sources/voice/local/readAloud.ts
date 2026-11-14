import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { localVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';

import { resolveLocalVoiceAdapterSettings, type LocalVoiceSettingsInput } from './localVoiceSettings';
import {
  finishReadAloudRun,
  getReadAloudActiveKey,
  startReadAloudRun,
  stopReadAloud,
  trackReadAloudStopper,
} from './readAloudState';

/**
 * Reads one transcript message aloud with the configured local TTS provider, or stops it when it
 * is already the one playing. Starting one stops whatever else is speaking (another message or a
 * live voice reply). Resolves `false` only when the provider failed.
 */
export async function toggleReadAloud(params: Readonly<{
  key: string;
  text: string;
  settings: LocalVoiceSettingsInput;
}>): Promise<boolean> {
  if (getReadAloudActiveKey() === params.key) {
    stopReadAloud();
    return true;
  }

  localVoicePlaybackController.interrupt();
  const run = startReadAloudRun(params.key);
  const { config } = resolveLocalVoiceAdapterSettings(params.settings);
  try {
    return await speakAssistantText({
      text: params.text,
      settings: params.settings,
      networkTimeoutMs: resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000),
      // Registered with the shared controller (a live barge-in stops read-aloud) and tracked here
      // (a live reply can stop read-aloud without counting as a barge-in).
      registerPlaybackStopper: (stopper) => {
        const unregisterShared = localVoicePlaybackController.registerStopper(stopper);
        const untrack = trackReadAloudStopper(stopper);
        return () => {
          unregisterShared();
          untrack();
        };
      },
      onSpeaking: () => {},
      takeOverReadAloud: false,
    });
  } finally {
    finishReadAloudRun(run);
  }
}
