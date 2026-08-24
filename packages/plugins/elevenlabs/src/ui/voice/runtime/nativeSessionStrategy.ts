type NativeSessionStrategyDependencies<TOptions, TConnection, TResult> = Readonly<{
  nativeWebRtcModule: unknown;
  requiresAudioDeviceModuleBridge: boolean;
  loadRegisterGlobals(): () => void;
  setSetupStrategy(
    strategy: (options: TOptions) => Promise<TResult>,
  ): void;
  createConnection(options: TOptions): Promise<TConnection>;
  setupWebRTCSession(connection: TConnection): TResult;
}>;

export const ELEVENLABS_NATIVE_WEBRTC_INCOMPATIBLE =
  'elevenlabs_native_webrtc_incompatible';

type ElevenLabsNativeSessionStrategyInstallation =
  | Readonly<{ kind: 'installed' }>
  | Readonly<{
    kind: 'unavailable';
    code: typeof ELEVENLABS_NATIVE_WEBRTC_INCOMPATIBLE;
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

function rejectsReactNativeWebSocketSetup(options: unknown): boolean {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  const { connectionType, signedUrl } = options as Readonly<{
    connectionType?: unknown;
    signedUrl?: unknown;
  }>;
  return connectionType === 'websocket' || typeof signedUrl === 'string';
}

/**
 * Installs the ElevenLabs WebRTC setup strategy for React Native.
 *
 * Native Voice's attempt already owns the LiveKit audio-session lease. This
 * adapter deliberately limits itself to LiveKit globals plus the provider
 * connection/controller setup, leaving attach/detach and audio-session
 * lifetime with their existing owners.
 */
export function installElevenLabsNativeSessionStrategy<TOptions, TConnection, TResult>(
  dependencies: NativeSessionStrategyDependencies<TOptions, TConnection, TResult>,
): ElevenLabsNativeSessionStrategyInstallation {
  if (
    dependencies.requiresAudioDeviceModuleBridge
    && !supportsIosWebRtcAudioLifecycle(dependencies.nativeWebRtcModule)
  ) {
    return {
      kind: 'unavailable',
      code: ELEVENLABS_NATIVE_WEBRTC_INCOMPATIBLE,
    };
  }

  dependencies.loadRegisterGlobals()();
  dependencies.setSetupStrategy(async (options) => {
    if (rejectsReactNativeWebSocketSetup(options)) {
      throw new Error(
        'WebSocket connections are not supported on React Native. '
        + 'Only WebRTC connections are available. '
        + 'Remove the connectionType/signedUrl option or use connectionType: \'webrtc\'.',
      );
    }
    return dependencies.setupWebRTCSession(await dependencies.createConnection(options));
  });
  return { kind: 'installed' };
}
