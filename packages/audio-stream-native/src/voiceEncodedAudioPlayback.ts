import {
  getOptionalHappierAudioStreamNativeModule,
  supportsVoiceEncodedAudioPlayback,
} from './HappierAudioStreamNative';
import type {
  HappierAudioStreamNativeModule,
  VoiceEncodedAudioPlaybackEvent,
} from './HappierAudioStreamNative.types';

let playbackSequence = 0;

export type VoiceEncodedAudioPlayback = Readonly<{
  start: (uri: string) => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  stop: () => Promise<void>;
  subscribe: (listener: (event: VoiceEncodedAudioPlaybackEvent) => void) => () => void;
}>;

export function createVoiceEncodedAudioPlayback(
  nativeModule: HappierAudioStreamNativeModule | null = getOptionalHappierAudioStreamNativeModule(),
): VoiceEncodedAudioPlayback | null {
  if (!supportsVoiceEncodedAudioPlayback(nativeModule)) return null;
  const playbackId = `voice-encoded-${++playbackSequence}`;
  let active = false;
  const listeners = new Set<(event: VoiceEncodedAudioPlaybackEvent) => void>();
  const subscription = nativeModule.addListener('encodedAudioPlayback', (event) => {
    if (event.playbackId !== playbackId) return;
    if (event.status !== 'started') active = false;
    for (const listener of listeners) listener(event);
  });

  return Object.freeze({
    start: async (uri) => {
      if (active) throw new Error('voice_encoded_audio_playback_already_active');
      active = true;
      try {
        await nativeModule.startEncodedAudioPlayback({ playbackId, uri });
      } catch (error) {
        active = false;
        subscription.remove();
        throw error;
      }
    },
    stop: async () => {
      if (!active) {
        subscription.remove();
        return;
      }
      active = false;
      try {
        await nativeModule.stopEncodedAudioPlayback({ playbackId });
      } finally {
        subscription.remove();
      }
    },
    setPaused: async (paused) => {
      if (!active) return;
      await nativeModule.setEncodedAudioPlaybackPaused({ playbackId, paused });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
