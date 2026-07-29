import {
  createHappierAudioStreamNativePlatform,
  getOptionalHappierAudioStreamNativeModule,
  supportsVoiceAudioSessionCoordination,
  type HappierAudioStreamNativeModule,
} from './internal';
import {
  createVoiceAudioSessionCoordinator,
  type VoiceAudioSessionCoordinator,
} from './voiceAudioSessionCoordinator';
import { createVoicePcmCapture, type VoicePcmCapture } from './voicePcmCapture';

export type SharedVoicePcmCaptureRegistry = Readonly<{
  get: () => VoicePcmCapture | null;
  getAudioSessionCoordinator: () => VoiceAudioSessionCoordinator | null;
}>;

export function createSharedVoicePcmCaptureRegistry(options: Readonly<{
  getNativeModule: () => HappierAudioStreamNativeModule | null;
}>): SharedVoicePcmCaptureRegistry {
  let resolved = false;
  let capture: VoicePcmCapture | null = null;
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
    } catch {
      coordinator = null;
      capture = null;
    }
  };
  return {
    get: () => {
      resolve();
      return capture;
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

/** The sole native audio-session lease owner for this JavaScript runtime. */
export function getSharedVoiceAudioSessionCoordinator(): VoiceAudioSessionCoordinator | null {
  return sharedRegistry.getAudioSessionCoordinator();
}
