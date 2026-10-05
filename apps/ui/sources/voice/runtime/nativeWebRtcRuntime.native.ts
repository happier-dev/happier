import { NativeModules, Platform } from 'react-native';
import {
  createVoiceNativeWebRtcBootstrap,
  loadVoiceNativeWebRtcRuntime,
  type LiveKitRegisterGlobals,
  type NativeWebRtcRuntime,
} from './nativeWebRtcRuntime.shared';

export type { VoiceNativeWebRtcMediaStream } from './nativeWebRtcRuntime.shared';

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
