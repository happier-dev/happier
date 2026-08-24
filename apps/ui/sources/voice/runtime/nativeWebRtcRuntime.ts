import { NativeModules, Platform } from 'react-native';

export const VOICE_NATIVE_WEBRTC_INCOMPATIBLE = 'voice_native_webrtc_incompatible';

export type VoiceNativeWebRtcMediaStream = Readonly<{
  release(): void;
}>;

type NativeWebRtcRuntime = Readonly<{
  mediaDevices: Readonly<{
    getUserMedia(
      constraints: Readonly<{ audio: boolean; video: boolean }>,
    ): Promise<VoiceNativeWebRtcMediaStream>;
  }>;
  RTCPeerConnection: new () => unknown;
  MediaStream: new (tracks: unknown[]) => unknown;
}>;

type NativeWebRtcRuntimeDependencies = Readonly<{
  nativeWebRtcModule: unknown;
  requiresIosAudioLifecycle: boolean;
  loadRuntime(): NativeWebRtcRuntime;
}>;

const REQUIRED_IOS_WEBRTC_AUDIO_LIFECYCLE_METHODS = [
  'audioDeviceModuleSetAutomaticAudioSessionConfiguration',
  'audioDeviceModuleSetEngineCreatedActive',
  'audioDeviceModuleSetWillEnableEngineActive',
  'audioDeviceModuleSetWillStartEngineActive',
  'audioDeviceModuleSetDidStopEngineActive',
  'audioDeviceModuleSetDidDisableEngineActive',
  'audioDeviceModuleSetWillReleaseEngineActive',
] as const;

function supportsIosWebRtcAudioLifecycle(nativeWebRtcModule: unknown): boolean {
  if (!nativeWebRtcModule || typeof nativeWebRtcModule !== 'object') return false;
  const nativeModule = nativeWebRtcModule as Readonly<Record<string, unknown>>;
  return REQUIRED_IOS_WEBRTC_AUDIO_LIFECYCLE_METHODS.every(
    (method) => typeof nativeModule[method] === 'function',
  );
}

function nativeWebRtcIncompatible(): Error {
  return Object.assign(
    new Error('Voice requires a current iOS WebRTC native module.'),
    { code: VOICE_NATIVE_WEBRTC_INCOMPATIBLE },
  );
}

export function loadVoiceNativeWebRtcRuntime(
  dependencies: NativeWebRtcRuntimeDependencies,
): NativeWebRtcRuntime {
  if (
    dependencies.requiresIosAudioLifecycle
    && !supportsIosWebRtcAudioLifecycle(dependencies.nativeWebRtcModule)
  ) {
    throw nativeWebRtcIncompatible();
  }
  return dependencies.loadRuntime();
}

/**
 * The host owns the app-bundled WebRTC runtime boundary. Do not evaluate the
 * native package until the loaded iOS binary confirms its audio lifecycle ABI.
 */
export function getVoiceNativeWebRtcRuntime(): NativeWebRtcRuntime {
  return loadVoiceNativeWebRtcRuntime({
    nativeWebRtcModule: NativeModules.WebRTCModule,
    requiresIosAudioLifecycle: Platform.OS === 'ios',
    loadRuntime: () => (
      require('@livekit/react-native-webrtc') as NativeWebRtcRuntime
    ),
  });
}
