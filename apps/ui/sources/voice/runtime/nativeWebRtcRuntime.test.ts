import { describe, expect, it, vi } from 'vitest';

import {
  createVoiceNativeWebRtcBootstrap,
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
  it('registers shared WebRTC lifecycle hooks once without granting LiveKit AVAudioSession ownership', () => {
    const registerGlobals = vi.fn();
    const loadRegisterGlobals = vi.fn(() => registerGlobals);
    const bootstrap = createVoiceNativeWebRtcBootstrap({
      nativeWebRtcModule: CURRENT_IOS_WEBRTC_AUDIO_LIFECYCLE,
      requiresIosAudioLifecycle: true,
      loadRegisterGlobals,
    });

    bootstrap.initialize();
    bootstrap.initialize();

    expect(loadRegisterGlobals).toHaveBeenCalledTimes(1);
    expect(registerGlobals).toHaveBeenCalledTimes(1);
    expect(registerGlobals).toHaveBeenCalledWith({ autoConfigureAudioSession: false });
  });

  it('fails closed when a provider-managed native WebRTC caller requires an incompatible iOS bridge', () => {
    const registerGlobals = vi.fn();
    const bootstrap = createVoiceNativeWebRtcBootstrap({
      nativeWebRtcModule: Object.freeze({}),
      requiresIosAudioLifecycle: true,
      loadRegisterGlobals: () => registerGlobals,
    });

    expect(() => bootstrap.require()).toThrow(
      expect.objectContaining({ code: VOICE_NATIVE_WEBRTC_INCOMPATIBLE }),
    );
    expect(registerGlobals).not.toHaveBeenCalled();
  });

  it('rejects an incompatible iOS native bridge before evaluating the JavaScript WebRTC runtime', () => {
    const loadRuntime = vi.fn();
    const initializeWebRtc = vi.fn();

    let error: unknown;
    try {
      loadVoiceNativeWebRtcRuntime({
        nativeWebRtcModule: Object.freeze({}),
        requiresIosAudioLifecycle: true,
        initializeWebRtc,
        loadRuntime,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: VOICE_NATIVE_WEBRTC_INCOMPATIBLE });
    expect(initializeWebRtc).not.toHaveBeenCalled();
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
    const initializeWebRtc = vi.fn();

    expect(loadVoiceNativeWebRtcRuntime({
      nativeWebRtcModule: CURRENT_IOS_WEBRTC_AUDIO_LIFECYCLE,
      requiresIosAudioLifecycle: true,
      initializeWebRtc,
      loadRuntime,
    })).toBe(runtime);
    expect(initializeWebRtc).toHaveBeenCalledTimes(1);
    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });
});
