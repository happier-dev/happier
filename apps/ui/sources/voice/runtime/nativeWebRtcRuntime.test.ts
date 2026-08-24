import { describe, expect, it, vi } from 'vitest';

import {
  loadVoiceNativeWebRtcRuntime,
  VOICE_NATIVE_WEBRTC_INCOMPATIBLE,
} from './nativeWebRtcRuntime';

const CURRENT_IOS_WEBRTC_AUDIO_LIFECYCLE = Object.freeze({
  audioDeviceModuleSetAutomaticAudioSessionConfiguration() {},
  audioDeviceModuleSetEngineCreatedActive() {},
  audioDeviceModuleSetWillEnableEngineActive() {},
  audioDeviceModuleSetWillStartEngineActive() {},
  audioDeviceModuleSetDidStopEngineActive() {},
  audioDeviceModuleSetDidDisableEngineActive() {},
  audioDeviceModuleSetWillReleaseEngineActive() {},
});

describe('Voice native WebRTC runtime boundary', () => {
  it('rejects an incompatible iOS native bridge before evaluating the JavaScript WebRTC runtime', () => {
    const loadRuntime = vi.fn();

    let error: unknown;
    try {
      loadVoiceNativeWebRtcRuntime({
        nativeWebRtcModule: Object.freeze({}),
        requiresIosAudioLifecycle: true,
        loadRuntime,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: VOICE_NATIVE_WEBRTC_INCOMPATIBLE });
    expect(loadRuntime).not.toHaveBeenCalled();
  });

  it('loads the runtime after a compatible iOS bridge passes the capability check', () => {
    class NativePeerConnection {}
    class NativeMediaStream {
      constructor(_tracks: unknown[]) {}
    }
    const runtime = {
      mediaDevices: {
        getUserMedia: async () => ({ release() {} }),
      },
      RTCPeerConnection: NativePeerConnection,
      MediaStream: NativeMediaStream,
    };
    const loadRuntime = vi.fn(() => runtime);

    expect(loadVoiceNativeWebRtcRuntime({
      nativeWebRtcModule: CURRENT_IOS_WEBRTC_AUDIO_LIFECYCLE,
      requiresIosAudioLifecycle: true,
      loadRuntime,
    })).toBe(runtime);
    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });
});
