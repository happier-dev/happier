import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileDelete = vi.fn(() => new Promise<void>(() => {}));
const playbackState: {
  playbackStatusListener: ((status: any) => void) | null;
} = {
  playbackStatusListener: null,
};
const { playbackLeaseRelease, acquirePlaybackLease } = vi.hoisted(() => {
  const release = vi.fn(async () => undefined);
  return {
    playbackLeaseRelease: release,
    acquirePlaybackLease: vi.fn(async () => Object.freeze({ release })),
  };
});
const nativePlayerPlay = vi.hoisted(() => vi.fn(() => undefined));
const nativeCreateAudioPlayer = vi.hoisted(() => vi.fn());

vi.mock('@/voice/runtime/voiceAudioMode', () => ({ acquireVoicePlaybackAudioMode: acquirePlaybackLease }));

async function waitForPlaybackStatusListener() {
  await vi.waitFor(() => {
    expect(playbackState.playbackStatusListener).toBeTruthy();
  });
}

async function waitForFileDeleteCall() {
  await vi.waitFor(() => {
    expect(fileDelete).toHaveBeenCalled();
  });
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'ios',
                    },
                }
    );
});

vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///tmp/' },
  File: class {
    uri: string;
    constructor(base: string, name: string) {
      this.uri = `${base}${name}`;
    }
    async write(_content: Uint8Array) {}
    delete = fileDelete;
  },
  deleteAsync: () => {
    throw new Error('deprecated_deleteAsync_called');
  },
}));

vi.mock('expo-audio', () => ({
  createAudioPlayer: (...args: unknown[]) => nativeCreateAudioPlayer(...args),
}));

import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';

describe('playAudioBytesWithStopper (native)', () => {
  beforeEach(() => {
    acquirePlaybackLease.mockClear();
    playbackLeaseRelease.mockClear();
    nativePlayerPlay.mockClear();
    nativeCreateAudioPlayer.mockReset();
    nativeCreateAudioPlayer.mockImplementation(() => ({
      addListener: (_event: string, cb: (status: any) => void) => {
        playbackState.playbackStatusListener = cb;
        return { remove() {} };
      },
      play: nativePlayerPlay,
      remove() {},
    }));
  });
  it('does not start native audio when a stale attempt is rejected during registration', async () => {
    playbackState.playbackStatusListener = null;
    const controller = createVoicePlaybackController();
    const staleAttempt = controller.registerStopper.captureAttempt?.() ?? controller.registerStopper;
    controller.interrupt();

    await playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: staleAttempt,
    });

    expect(nativePlayerPlay).not.toHaveBeenCalled();
    expect(playbackState.playbackStatusListener).toBeNull();
  });

  it('keeps the coordinator-owned iOS audio session active after byte playback finishes', async () => {
    playbackState.playbackStatusListener = null;

    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
    });

    await waitForPlaybackStatusListener();

    expect(nativeCreateAudioPlayer).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/\/tmp\/happier-voice-\d+\.mp3$/),
      { keepAudioSessionActive: true },
    );

    const notifyPlaybackFinished: (status: any) => void = playbackState.playbackStatusListener ?? (() => {
      throw new Error('Expected playback status listener to be registered');
    });
    notifyPlaybackFinished({ didJustFinish: true });
    await promise;
  });

  it('deletes the created temp file when player initialization throws', async () => {
    fileDelete.mockReset();
    fileDelete.mockResolvedValue(undefined);
    nativeCreateAudioPlayer.mockImplementationOnce(() => {
      throw new Error('native player construction failed');
    });

    await expect(playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
    })).rejects.toThrow('native player construction failed');

    await waitForFileDeleteCall();
    expect(fileDelete).toHaveBeenCalledOnce();
    expect(playbackLeaseRelease).toHaveBeenCalledOnce();
  });

  it('resolves promptly when playback finishes even if temp-file cleanup stalls', async () => {
    playbackState.playbackStatusListener = null;
    fileDelete.mockClear();
    acquirePlaybackLease.mockClear();
    playbackLeaseRelease.mockClear();

    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
    });

    await waitForPlaybackStatusListener();

    const notifyPlaybackFinished: (status: any) => void = playbackState.playbackStatusListener ?? (() => {
      throw new Error('Expected playback status listener to be registered');
    });
    let resolved = false;
    const observedResolution = promise.then(() => {
      resolved = true;
    });
    notifyPlaybackFinished({ didJustFinish: true });

    await vi.waitFor(() => {
      expect(resolved).toBe(true);
    });
    await observedResolution;

    expect(acquirePlaybackLease).toHaveBeenCalledTimes(1);
    expect(playbackLeaseRelease).toHaveBeenCalledTimes(1);

    await waitForFileDeleteCall();
    expect(fileDelete).toHaveBeenCalledTimes(1);
  });

  it('rejects rather than hanging when playback status reports an error', async () => {
    playbackState.playbackStatusListener = null;
    fileDelete.mockClear();
    const onPlaybackStarted = vi.fn();

    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
      onPlaybackStarted,
    });

    await waitForPlaybackStatusListener();
    const notify: (status: any) => void = playbackState.playbackStatusListener ?? (() => {
      throw new Error('Expected playback status listener to be registered');
    });

    // A post-play() failure surfaced via status must settle the promise.
    notify({ didJustFinish: false, error: 'decode_failed' });

    await expect(promise).rejects.toThrow('audio_playback_failed');
    expect(playbackLeaseRelease).toHaveBeenCalledTimes(1);
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    await waitForFileDeleteCall();
  });

  it('releases the playback lease and ignores queued status callbacks when explicitly stopped', async () => {
    playbackState.playbackStatusListener = null;
    playbackLeaseRelease.mockClear();
    const onPlaybackStarted = vi.fn();
    const stopperRef: { current: (() => void) | null } = { current: null };
    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: (next) => { stopperRef.current = next; return () => {}; },
      onPlaybackStarted,
    });

    await waitForPlaybackStatusListener();
    const queuedStatusCallback = playbackState.playbackStatusListener as ((status: any) => void) | null;
    const registeredStop = stopperRef.current;
    if (!registeredStop) throw new Error('Expected playback stopper to be registered');
    registeredStop();
    await promise;
    queuedStatusCallback?.({ didJustFinish: false, playing: true });

    expect(playbackLeaseRelease).toHaveBeenCalledTimes(1);
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });

  it('calls onPlaybackStarted after native playback status proves playback started', async () => {
    playbackState.playbackStatusListener = null;
    fileDelete.mockClear();
    const onPlaybackStarted = vi.fn();

    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
      onPlaybackStarted,
    });

    await waitForPlaybackStatusListener();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    const notifyPlaybackFinished = playbackState.playbackStatusListener as
      | ((status: any) => void)
      | null;
    if (!notifyPlaybackFinished) {
      throw new Error('Expected playback status listener to be registered');
    }
    notifyPlaybackFinished({ didJustFinish: false, playing: true });
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
    notifyPlaybackFinished({ didJustFinish: false, timeControlStatus: 'playing' });
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
    notifyPlaybackFinished({ didJustFinish: true });
    await promise;
  });
});
