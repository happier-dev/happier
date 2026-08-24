import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.doMock('@livekit/react-native-webrtc', () => {
    throw new Error('unsupported native WebRTC event registration');
  });
});

afterEach(() => {
  vi.doUnmock('@livekit/react-native-webrtc');
  vi.resetModules();
});

describe('native Voice WebRTC binding loading', () => {
  it('keeps the host peer-connection binding importable before the native runtime is needed', async () => {
    const binding = await import('./createHostWebRtcConnection.native');

    expect(binding.createHostWebRtcConnection).toEqual(expect.any(Function));
  });

  it('keeps the host microphone binding importable before the native runtime is needed', async () => {
    const binding = await import('../mic/createRealtimeMicSession');

    expect(binding.createRealtimeMicSession).toEqual(expect.any(Function));
  });
});
