export const VOICE_NATIVE_WEBRTC_INCOMPATIBLE = 'voice_native_webrtc_incompatible';

export type VoiceNativeWebRtcMediaStream = Readonly<{
  release(): void;
}>;

export type NativeWebRtcRuntime = Readonly<{
  mediaDevices: Readonly<{
    getUserMedia(
      constraints: Readonly<{ audio: boolean; video: boolean }>,
    ): Promise<VoiceNativeWebRtcMediaStream>;
  }>;
  RTCPeerConnection: new () => unknown;
  MediaStream: new (tracks: unknown[]) => unknown;
}>;

export type LiveKitRegisterGlobals = (
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
