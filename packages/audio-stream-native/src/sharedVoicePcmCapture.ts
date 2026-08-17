import {
  createHappierAudioStreamNativePlatform,
  getOptionalHappierAudioStreamNativeModule,
  supportsVoiceAudioSessionCoordination,
  supportsVoicePcmPlayback,
  type HappierAudioStreamNativeModule,
} from './internal';
import {
  createVoiceAudioSessionCoordinator,
  type VoiceAudioSessionCoordinator,
} from './voiceAudioSessionCoordinator';
import { createVoicePcmCapture, type VoicePcmCapture } from './voicePcmCapture';
import { createVoicePcmPlayback, type VoicePcmPlayback } from './voicePcmPlayback';

export type SharedVoicePcmCaptureRegistry = Readonly<{
  get: () => VoicePcmCapture | null;
  getPlayback: () => VoicePcmPlayback | null;
  getAudioSessionCoordinator: () => VoiceAudioSessionCoordinator | null;
}>;

export function createSharedVoicePcmCaptureRegistry(options: Readonly<{
  getNativeModule: () => HappierAudioStreamNativeModule | null;
}>): SharedVoicePcmCaptureRegistry {
  let resolved = false;
  let capture: VoicePcmCapture | null = null;
  let playback: VoicePcmPlayback | null = null;
  let coordinator: VoiceAudioSessionCoordinator | null = null;
  const resolve = (): void => {
    if (resolved) return;
    resolved = true;
    let nativeModule: HappierAudioStreamNativeModule | null;
    try {
      nativeModule = options.getNativeModule();
    } catch {
      nativeModule = null;
    }
    if (!supportsVoiceAudioSessionCoordination(nativeModule)) return;
    try {
      coordinator = createVoiceAudioSessionCoordinator({
        platform: createHappierAudioStreamNativePlatform(nativeModule),
      });
      capture = createVoicePcmCapture({ nativeModule, audioSessionCoordinator: coordinator });
      if (supportsVoicePcmPlayback(nativeModule)) {
        playback = createVoicePcmPlayback({ nativeModule, capture });
      }
    } catch {
      coordinator = null;
      capture = null;
      playback = null;
    }
  };
  return {
    get: () => {
      resolve();
      return capture;
    },
    getPlayback: () => {
      resolve();
      return playback;
    },
    getAudioSessionCoordinator: () => {
      resolve();
      return coordinator;
    },
  };
}

const sharedRegistry = createSharedVoicePcmCaptureRegistry({
  getNativeModule: getOptionalHappierAudioStreamNativeModule,
});

/**
 * The sole package-owned native capture service for this JavaScript runtime.
 * A missing/legacy native module fails closed until the app process reloads.
 */
export function getSharedVoicePcmCapture(): VoicePcmCapture | null {
  return sharedRegistry.get();
}

/** The sole package-owned native PCM output service for this JavaScript runtime. */
export function getSharedVoicePcmPlayback(): VoicePcmPlayback | null {
  return sharedRegistry.getPlayback();
}

/** The sole native audio-session lease owner for this JavaScript runtime. */
export function getSharedVoiceAudioSessionCoordinator(): VoiceAudioSessionCoordinator | null {
  return sharedRegistry.getAudioSessionCoordinator();
}
