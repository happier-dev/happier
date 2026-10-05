import type { NativeWebRtcRuntime } from './nativeWebRtcRuntime.shared';

export type { VoiceNativeWebRtcMediaStream } from './nativeWebRtcRuntime.shared';

// Browser WebRTC is supplied by the browser. Keep native SDK imports behind
// Metro's .native resolution, even when a caller also guards Platform.OS.
export function initializeVoiceNativeWebRtcBootstrap(): void {}

export function requireVoiceNativeWebRtcBootstrap(): void {}

export function getVoiceNativeWebRtcRuntime(): NativeWebRtcRuntime {
  throw new Error('Native WebRTC is unavailable on web.');
}
