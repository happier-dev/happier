import { describe, expect, it, vi } from 'vitest';

const deleteAsync = vi.fn(() => new Promise<void>(() => {}));
const playbackState: {
  playbackStatusListener: ((status: any) => void) | null;
} = {
  playbackStatusListener: null,
};

async function waitForPlaybackStatusListener() {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    if (playbackState.playbackStatusListener) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for playbackStatusListener registration');
}

async function waitForDeleteAsyncCall() {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    if (deleteAsync.mock.calls.length > 0) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for deleteAsync call');
}

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

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
    notifyPlaybackFinished({ didJustFinish: true });

    await expect(
      Promise.race([
        promise.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 0)),
      ]),
    ).resolves.toBe('resolved');

    await waitForDeleteAsyncCall();
    expect(deleteAsync).toHaveBeenCalledTimes(1);
  });
});