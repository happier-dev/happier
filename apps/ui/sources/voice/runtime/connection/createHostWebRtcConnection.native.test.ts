import { describe, expect, it, vi } from 'vitest';

import { attachNativeRemoteStream } from './createHostWebRtcConnection.native';

describe('native Voice WebRTC platform binding', () => {
  it('ducks and restores peer-owned remote audio without releasing it', () => {
    const setVolume = vi.fn();
    const release = vi.fn();
    const stop = vi.fn();
    const remoteTrack = { _setVolume: setVolume, stop, enabled: true };
    const stream = {
      getAudioTracks: () => [remoteTrack],
      release,
    } as unknown as MediaStream;
    const attachment = attachNativeRemoteStream(stream, 0.18, 'peer');

    expect(attachment.beginOutputInterruptionCandidate()).toBe('ducked');
    expect(setVolume).toHaveBeenCalledWith(0.18);
    attachment.resolveOutputInterruptionCandidate('false_alarm');
    expect(setVolume).toHaveBeenLastCalledWith(1);
    expect(attachment.setOutputFocusState('suspended')).toBe('applied');
    expect(setVolume).toHaveBeenLastCalledWith(0);
    // A barge-in candidate must not undo an active focus suspension.
    expect(attachment.beginOutputInterruptionCandidate()).toBe('ducked');
    expect(setVolume).toHaveBeenLastCalledWith(0);
    attachment.resolveOutputInterruptionCandidate('false_alarm');
    expect(setVolume).toHaveBeenLastCalledWith(0);
    expect(attachment.setOutputFocusState('ducked')).toBe('applied');
    expect(setVolume).toHaveBeenLastCalledWith(0.18);
    expect(attachment.setOutputFocusState('active')).toBe('applied');
    expect(setVolume).toHaveBeenLastCalledWith(1);
    attachment.dispose();
    expect(setVolume).toHaveBeenLastCalledWith(0);
    expect(remoteTrack.enabled).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('silences and releases a retired host-created fallback stream exactly once', () => {
    const setVolume = vi.fn();
    const release = vi.fn();
    const stream = {
      getAudioTracks: () => [{ _setVolume: setVolume }],
      release,
    } as unknown as MediaStream;
    const attachment = attachNativeRemoteStream(stream, 0.18, 'host_fallback');

    attachment.dispose();
    attachment.dispose();

    expect(setVolume).toHaveBeenCalledTimes(1);
    expect(setVolume).toHaveBeenCalledWith(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('reports ducking unsupported when the native track has no volume capability', () => {
    const attachment = attachNativeRemoteStream({
      getAudioTracks: () => [{}],
    } as unknown as MediaStream, 0.18, 'peer');

    expect(attachment.beginOutputInterruptionCandidate()).toBe('unsupported');
    expect(attachment.setOutputFocusState('suspended')).toBe('unsupported');
  });
});
