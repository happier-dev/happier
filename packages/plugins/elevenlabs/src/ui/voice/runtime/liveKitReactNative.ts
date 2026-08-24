type LiveKitReactNativeModule = Readonly<{
  registerGlobals(): void;
}>;

/**
 * Metro evaluates this dependency only after the native WebRTC capability gate
 * accepts the loaded app binary.
 */
export function loadLiveKitRegisterGlobals(): () => void {
  return (require('@livekit/react-native') as LiveKitReactNativeModule).registerGlobals;
}
