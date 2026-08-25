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

type LiveKitRegisterGlobals = (
  options?: Readonly<{ autoConfigureAudioSession?: boolean }>,
) => void;

type VoiceNativeWebRtcBootstrapDependencies = Readonly<{
  nativeWebRtcModule: unknown;
  requiresIosAudioLifecycle: boolean;
  loadRegisterGlobals(): LiveKitRegisterGlobals;
}>;

type NativeWebRtcRuntimeDependencies = Readonly<{
  nativeWebRtcModule: unknown;
  requiresIosAudioLifecycle: boolean;
  initializeWebRtc?(): void;
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

/**
 * The host owns the one native WebRTC bootstrap shared by OpenAI, Codex, and
 * provider-managed media engines. LiveKit only installs WebRTC globals and
 * lifecycle hooks here; the native coordinator remains the sole owner of the
 * AVAudioSession policy and lease lifetime.
 */
export function createVoiceNativeWebRtcBootstrap(
  dependencies: VoiceNativeWebRtcBootstrapDependencies,
): Readonly<{ initialize(): void; require(): void }> {
  let initialized = false;
  const requireCompatibleBridge = (): void => {
    if (
      dependencies.requiresIosAudioLifecycle
      && !supportsIosWebRtcAudioLifecycle(dependencies.nativeWebRtcModule)
    ) {
      throw nativeWebRtcIncompatible();
    }
  };
  const initialize = (): void => {
    if (initialized) return;
    if (
      dependencies.requiresIosAudioLifecycle
      && !supportsIosWebRtcAudioLifecycle(dependencies.nativeWebRtcModule)
    ) {
      return;
    }
    dependencies.loadRegisterGlobals()({ autoConfigureAudioSession: false });
    initialized = true;
  };
  return Object.freeze({
    initialize,
    require(): void {
      requireCompatibleBridge();
      initialize();
    },
  });
}

const nativeWebRtcBootstrap = createVoiceNativeWebRtcBootstrap({
  nativeWebRtcModule: NativeModules.WebRTCModule,
  requiresIosAudioLifecycle: Platform.OS === 'ios',
  loadRegisterGlobals: () => (
    require('@livekit/react-native') as Readonly<{
      registerGlobals: LiveKitRegisterGlobals;
    }>
  ).registerGlobals,
});

export function initializeVoiceNativeWebRtcBootstrap(): void {
  nativeWebRtcBootstrap.initialize();
}

/**
 * Provider-managed native media reaches the same host bootstrap before its
 * SDK can create a WebRTC session. Unlike eager host setup, this admission is
 * explicit so an incompatible iOS bridge is surfaced as a typed failure.
 */
export function requireVoiceNativeWebRtcBootstrap(): void {
  nativeWebRtcBootstrap.require();
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
  dependencies.initializeWebRtc?.();
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
    initializeWebRtc: initializeVoiceNativeWebRtcBootstrap,
    loadRuntime: () => (
      require('@livekit/react-native-webrtc') as NativeWebRtcRuntime
    ),
  });
}
