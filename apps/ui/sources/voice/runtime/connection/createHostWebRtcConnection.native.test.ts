import { describe, expect, it, vi } from 'vitest';

import { attachNativeRemoteStream } from './createHostWebRtcConnection.native';

describe('native Voice WebRTC platform binding', () => {
  it('ducks and restores peer-owned remote audio without releasing it', () => {
    const setVolume = vi.fn();
    const release = vi.fn();
    const stream = {
      getAudioTracks: () => [{ _setVolume: setVolume }],
      release,
    } as unknown as MediaStream;
    const attachment = attachNativeRemoteStream(stream, 0.18);

    expect(attachment.beginOutputInterruptionCandidate()).toBe('ducked');
    expect(setVolume).toHaveBeenCalledWith(0.18);
    attachment.resolveOutputInterruptionCandidate('false_alarm');
    expect(setVolume).toHaveBeenLastCalledWith(1);
    attachment.dispose();
    expect(release).not.toHaveBeenCalled();
  });

  it('reports ducking unsupported when the native track has no volume capability', () => {
    const attachment = attachNativeRemoteStream({
      getAudioTracks: () => [{}],
    } as unknown as MediaStream, 0.18);

    expect(attachment.beginOutputInterruptionCandidate()).toBe('unsupported');
  });
});
