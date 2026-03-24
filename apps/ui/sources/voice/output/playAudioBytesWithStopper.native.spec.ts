import { describe, expect, it, vi } from 'vitest';

const deleteAsync = vi.fn(() => new Promise<void>(() => {}));
const playbackState: {
  playbackStatusListener: ((status: any) => void) | null;
} = {
  playbackStatusListener: null,
};

async function waitForPlaybackStatusListener() {
  await vi.waitFor(() => {
    expect(playbackState.playbackStatusListener).toBeTruthy();
  });
}

async function waitForDeleteAsyncCall() {
  await vi.waitFor(() => {
    expect(deleteAsync).toHaveBeenCalled();
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
  },
  deleteAsync,
}));

vi.mock('expo-audio', () => ({
  createAudioPlayer: (_source?: string) => ({
    addListener: (_event: string, cb: (status: any) => void) => {
      playbackState.playbackStatusListener = cb;
      return { remove() {} };
    },
    play: () => undefined,
    remove() {},
  }),
}));

import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';

describe('playAudioBytesWithStopper (native)', () => {
  it('resolves promptly when playback finishes even if temp-file cleanup stalls', async () => {
    playbackState.playbackStatusListener = null;
    deleteAsync.mockClear();

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

    await waitForDeleteAsyncCall();
    expect(deleteAsync).toHaveBeenCalledTimes(1);
  });
});
