import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';

describe('playAudioBytesWithStopper (web)', () => {
  it('uses WebAudio when available', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    (globalThis as any).URL = { createObjectURL, revokeObjectURL };

    const audioCtor = vi.fn();
    (globalThis as any).Audio = audioCtor;

    let endedHandler: (() => void) | null = null;
    const stop = vi.fn(() => {
      endedHandler?.();
    });

    class FakeAudioBufferSourceNode {
      onended: (() => void) | null = null;
      connect() {}
      disconnect() {}
      start() {
        // let the test drive completion via onended
      }
      stop() {
        stop();
      }
    }

    class FakeAudioContext {
      state: 'suspended' | 'running' = 'suspended';
      destination = {};
      async resume() {
        this.state = 'running';
      }
      async decodeAudioData(_buf: ArrayBuffer) {
        return { duration: 0.1 } as any;
      }
      createBufferSource() {
        const node = new FakeAudioBufferSourceNode();
        Object.defineProperty(node, 'onended', {
          get() {
            return endedHandler;
          },
          set(v) {
            endedHandler = v;
          },
        });
        return node as any;
      }
    }

    (globalThis as any).AudioContext = FakeAudioContext;

    let registeredStopper: (() => void) | null = null;
    const registerPlaybackStopper = (s: () => void) => {
      registeredStopper = s;
      return () => {};
    };

    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'wav',
      registerPlaybackStopper,
    });

    expect(typeof registeredStopper).toBe('function');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(audioCtor).not.toHaveBeenCalled();

    // Allow the async decode/play pipeline to attach handlers.
    await new Promise((r) => setTimeout(r, 0));
    if (!endedHandler) throw new Error('Expected onended to be set');
    endedHandler();
    await promise;
  });

  it('registers a stopper and resolves when playback finishes', async () => {
    (globalThis as any).AudioContext = undefined;
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    (globalThis as any).URL = { createObjectURL, revokeObjectURL };

    let endedHandler: (() => void) | null = null;
    const pause = vi.fn();
    const play = vi.fn(() => Promise.resolve());

    (globalThis as any).Audio = function AudioMock(_url: string) {
      return {
        pause,
        play,
        set onended(cb: any) {
          endedHandler = cb;
        },
        get onended() {
          return endedHandler;
        },
        onerror: null,
      };
    } as any;

    let registeredStopper: (() => void) | null = null;
    let cleared = false;
    const registerPlaybackStopper = (stopper: () => void) => {
      registeredStopper = stopper;
      return () => {
        cleared = true;
      };
    };

    const promise = playAudioBytesWithStopper({
      bytes: new ArrayBuffer(4),
      format: 'wav',
      registerPlaybackStopper,
    });

    expect(typeof registeredStopper).toBe('function');
    expect(play).toHaveBeenCalledTimes(1);

    if (!endedHandler) {
      throw new Error('Expected audio ended handler to be registered');
    }
    (endedHandler as unknown as () => void)();

    await promise;

    expect(pause).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(cleared).toBe(true);
  });

  it('rejects when Audio.play() returns a rejected promise (autoplay blocked)', async () => {
    (globalThis as any).AudioContext = undefined;
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    (globalThis as any).URL = { createObjectURL, revokeObjectURL };

    const pause = vi.fn();
    const play = vi.fn(() => Promise.reject(new Error('NotAllowedError')));

    (globalThis as any).Audio = function AudioMock(_url: string) {
      return { pause, play, onended: null, onerror: null };
    } as any;

    await expect(
      playAudioBytesWithStopper({
        bytes: new ArrayBuffer(4),
        format: 'wav',
        registerPlaybackStopper: () => () => {},
      }),
    ).rejects.toThrow(/NotAllowedError/);

    expect(pause).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });
});
