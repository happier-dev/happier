import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

const nativeWebRtc = vi.hoisted(() => ({
  initializeVoiceNativeWebRtcBootstrap: vi.fn(),
  requireVoiceNativeWebRtcBootstrap: vi.fn(),
}));

const connections = vi.hoisted(() => ({
  createSdkHandleConnection: vi.fn(),
  createWebSocketPcmConnection: vi.fn(),
}));

vi.mock('@/voice/runtime/nativeWebRtcRuntime', () => nativeWebRtc);
vi.mock('@/voice/runtime/connection/VoiceRealtimeConnection', () => connections);

import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';

describe('bundled conversation runtime host native WebRTC admission', () => {
  const originalPlatformOs = Platform.OS;

  afterEach(() => {
    Platform.OS = originalPlatformOs;
    nativeWebRtc.initializeVoiceNativeWebRtcBootstrap.mockReset();
    nativeWebRtc.requireVoiceNativeWebRtcBootstrap.mockReset();
    connections.createSdkHandleConnection.mockReset();
  });

  it('rejects provider-managed native WebRTC before the ElevenLabs SDK connection is created', () => {
    Platform.OS = 'ios';
    const incompatibleBridge = Object.assign(
      new Error('Voice requires a current iOS WebRTC native module.'),
      { code: 'voice_native_webrtc_incompatible' },
    );
    nativeWebRtc.requireVoiceNativeWebRtcBootstrap.mockImplementation(() => {
      throw incompatibleBridge;
    });
    const lease = createBundledConversationRuntimeHostLease();

    try {
      expect(nativeWebRtc.initializeVoiceNativeWebRtcBootstrap).toHaveBeenCalledTimes(1);
      expect(() => lease.host.createSdkHandleConnection({ driver: {} as never })).toThrow(
        incompatibleBridge,
      );
      expect(nativeWebRtc.requireVoiceNativeWebRtcBootstrap).toHaveBeenCalledTimes(1);
      expect(connections.createSdkHandleConnection).not.toHaveBeenCalled();
    } finally {
      lease.revoke();
    }
  });
});
