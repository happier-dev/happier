import { afterEach, describe, expect, it, vi } from 'vitest';

const platformOsMock = vi.hoisted(() => ({ value: 'web' as 'web' | 'ios' }));
const nativePlaybackLeaseRelease = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@happier-dev/audio-stream-native', () => ({
  getSharedVoiceAudioSessionCoordinator: () => ({
    acquire: async () => Object.freeze({ release: nativePlaybackLeaseRelease }),
  }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        get OS() {
                            return platformOsMock.value;
                        },
                    },
                }
    );
});

import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { resetWebAudioContextForTests } from '@/voice/output/webAudioContext';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import {
  getVoiceQaOutputTapSnapshot,
  resetVoiceQaOutputTapForTests,
  setVoiceQaOutputTapEnabled,
  subscribeToVoiceQaOutputTap,
} from '@/voice/qa/voiceQaOutputTap';

const realURL = globalThis.URL;
const realCreateObjectURLDescriptor = Object.getOwnPropertyDescriptor(realURL, 'createObjectURL');
const realRevokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(realURL, 'revokeObjectURL');
const realAudio = (globalThis as typeof globalThis & { Audio?: unknown }).Audio;
const realAudioContext = (globalThis as typeof globalThis & { AudioContext?: unknown }).AudioContext;
const realExpoPublicDebug = process.env.EXPO_PUBLIC_DEBUG;

function restoreUrlHelper(
    name: 'createObjectURL' | 'revokeObjectURL',
    descriptor: PropertyDescriptor | undefined,
): void {
    if (descriptor) {
        Object.defineProperty(realURL, name, descriptor);
        return;
    }
    delete (realURL as unknown as Record<string, unknown>)[name];
}

function stubBlobUrlHelpers(input: Readonly<{
    createObjectURL: (value: Blob | MediaSource) => string;
    revokeObjectURL: (url: string) => void;
}>): void {
    Object.defineProperty(realURL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: input.createObjectURL,
    });
    Object.defineProperty(realURL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: input.revokeObjectURL,
    });
}

afterEach(() => {
    resetWebAudioContextForTests();
    platformOsMock.value = 'web';
    (globalThis as typeof globalThis & { URL: typeof URL }).URL = realURL;
    restoreUrlHelper('createObjectURL', realCreateObjectURLDescriptor);
    restoreUrlHelper('revokeObjectURL', realRevokeObjectURLDescriptor);
    (globalThis as typeof globalThis & { Audio?: unknown }).Audio = realAudio;
    (globalThis as typeof globalThis & { AudioContext?: unknown }).AudioContext = realAudioContext;
    process.env.EXPO_PUBLIC_DEBUG = realExpoPublicDebug;
    resetVoiceQaOutputTapForTests();
    vi.restoreAllMocks();
});

describe('playAudioBytesWithStopper (web)', () => {
  it('does not start HTML audio when a stale attempt is rejected during registration', async () => {
    (globalThis as unknown as { AudioContext?: unknown }).AudioContext = undefined;
    stubBlobUrlHelpers({
      createObjectURL: vi.fn(() => 'blob:stale-attempt'),
      revokeObjectURL: vi.fn(),
    });
    const play = vi.fn(async () => {});
    const onPlaybackStarted = vi.fn();
    (globalThis as unknown as { Audio?: unknown }).Audio = function AudioMock() {
      return {
        pause: vi.fn(),
        play,
        onended: null,
        onerror: null,
      };
    };
    const controller = createVoicePlaybackController();
    const staleAttempt = controller.registerStopper.captureAttempt?.() ?? controller.registerStopper;
    controller.interrupt();

    await playAudioBytesWithStopper({
      bytes: new ArrayBuffer(4),
      format: 'wav',
      registerPlaybackStopper: staleAttempt,
      onPlaybackStarted,
    });

    expect(play).not.toHaveBeenCalled();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });

  it('meters the currently playing WebAudio window instead of repeating whole-buffer RMS', async () => {
    vi.useFakeTimers();
    try {
      const samples = new Float32Array(400);
      samples.fill(1, 0, 100);
      let currentTime = 0;
      let endedHandler: (() => void) | null = null;
      class WindowedMeterAudioContext {
        destination = {};
        get currentTime() { return currentTime; }
        async resume() {}
        async decodeAudioData() {
          return {
            duration: 0.4,
            length: samples.length,
            numberOfChannels: 1,
            sampleRate: 1_000,
            getChannelData: () => samples,
          } as unknown as AudioBuffer;
        }
        createBufferSource() {
          return {
            buffer: null,
            connect: vi.fn(),
            disconnect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
            set onended(value: (() => void) | null) { endedHandler = value; },
            get onended() { return endedHandler; },
          } as unknown as AudioBufferSourceNode;
        }
      }
      (globalThis as any).AudioContext = WindowedMeterAudioContext;
      let registeredStopper: (() => void) | null = null;

      const playback = playAudioBytesWithStopper({
        bytes: new ArrayBuffer(4),
        format: 'wav',
        registerPlaybackStopper: (stopper) => {
          registeredStopper = stopper;
          return () => {};
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(voiceRuntimeLevelStore.getSnapshot().outputLevel).toBeGreaterThan(0);

      currentTime = 0.15;
      await vi.advanceTimersByTimeAsync(100);
      expect(voiceRuntimeLevelStore.getSnapshot().outputLevel).toBe(0);

      if (!registeredStopper) throw new Error('Expected playback stopper');
      (registeredStopper as () => void)();
      await playback;
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses WebAudio when available', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    stubBlobUrlHelpers({ createObjectURL, revokeObjectURL });
    const onPlaybackStarted = vi.fn();

    const audioCtor = vi.fn();
    (globalThis as any).Audio = audioCtor;

    let endedHandler: (() => void) | null = null;
    const stop = vi.fn(() => {
      if (endedHandler) endedHandler();
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
        return {
          duration: 0.1,
          numberOfChannels: 1,
          getChannelData: () => new Float32Array([0.5, -0.5]),
        } as any;
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
      onPlaybackStarted,
    });

    expect(typeof registeredStopper).toBe('function');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(audioCtor).not.toHaveBeenCalled();

    // Allow the async decode/play pipeline to attach handlers.
    await vi.waitFor(() => {
      expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
    });
    expect(voiceRuntimeLevelStore.getSnapshot()).toMatchObject({ outputSourceActive: true });
    expect(voiceRuntimeLevelStore.getSnapshot().outputLevel).toBeGreaterThan(0);
    if (!endedHandler) throw new Error('Expected onended to be set');
    const onEnded: () => void = endedHandler;
    onEnded();
    await promise;
    expect(voiceRuntimeLevelStore.getSnapshot()).toMatchObject({ outputLevel: 0, outputSourceActive: false });
  });

  it('captures the canonical web sink artifact without letting QA observers break playback', async () => {
    process.env.EXPO_PUBLIC_DEBUG = '1';
    setVoiceQaOutputTapEnabled(true);
    subscribeToVoiceQaOutputTap(() => {
      throw new Error('qa_observer_failed');
    });

    let endedHandler: (() => void) | null = null;
    (globalThis as any).AudioContext = undefined;
    stubBlobUrlHelpers({
      createObjectURL: vi.fn(() => 'blob:qa-output'),
      revokeObjectURL: vi.fn(),
    });
    (globalThis as any).Audio = function AudioMock() {
      return {
        pause: vi.fn(),
        play: vi.fn(async () => {}),
        set onended(value: (() => void) | null) {
          endedHandler = value;
        },
        get onended() {
          return endedHandler;
        },
        onerror: null,
      };
    } as any;

    const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer;
    const playback = playAudioBytesWithStopper({
      bytes,
      format: 'wav',
      registerPlaybackStopper: () => () => {},
    });

    await vi.waitFor(() => {
      expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('playing');
      expect(getVoiceQaOutputTapSnapshot().artifact?.bytesBase64).toBe('UklGRgECAwQ=');
    });
    if (!endedHandler) throw new Error('Expected web completion handler');
    (endedHandler as () => void)();
    await playback;

    expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('completed');
  });

  it('marks a canonical WebAudio artifact cancelled when its registered stopper runs', async () => {
    process.env.EXPO_PUBLIC_DEBUG = '1';
    setVoiceQaOutputTapEnabled(true);
    let registeredStopper: (() => void) | null = null;
    class FakeAudioContext {
      destination = {};
      async resume() {}
      async decodeAudioData() {
        return { duration: 1 } as AudioBuffer;
      }
      createBufferSource() {
        return {
          buffer: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null,
        } as unknown as AudioBufferSourceNode;
      }
    }
    (globalThis as any).AudioContext = FakeAudioContext;

    const playback = playAudioBytesWithStopper({
      bytes: new Uint8Array([82, 73, 70, 70]).buffer,
      format: 'wav',
      registerPlaybackStopper: (stopper) => {
        registeredStopper = stopper;
        return () => {};
      },
    });
    await vi.waitFor(() => expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('playing'));
    if (!registeredStopper) throw new Error('Expected playback stopper');
    (registeredStopper as () => void)();
    await playback;

    expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('cancelled');
  });

  it('captures canonical WebAudio bytes before decodeAudioData detaches its input buffer', async () => {
    process.env.EXPO_PUBLIC_DEBUG = '1';
    setVoiceQaOutputTapEnabled(true);
    let endedHandler: (() => void) | null = null;
    class DetachingAudioContext {
      destination = {};
      async resume() {}
      async decodeAudioData(bytes: ArrayBuffer) {
        structuredClone(bytes, { transfer: [bytes] });
        return { duration: 0.2 } as AudioBuffer;
      }
      createBufferSource() {
        return {
          buffer: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          set onended(value: (() => void) | null) {
            endedHandler = value;
          },
          get onended() {
            return endedHandler;
          },
        } as unknown as AudioBufferSourceNode;
      }
    }
    (globalThis as any).AudioContext = DetachingAudioContext;

    const playback = playAudioBytesWithStopper({
      bytes: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer,
      format: 'wav',
      registerPlaybackStopper: () => () => {},
    });
    await vi.waitFor(() => {
      expect(getVoiceQaOutputTapSnapshot().artifact).toMatchObject({
        originalByteLength: 8,
        capturedByteLength: 8,
        bytesBase64: 'UklGRgECAwQ=',
        lifecycle: 'playing',
      });
    });
    if (!endedHandler) throw new Error('Expected WebAudio completion handler');
    (endedHandler as () => void)();
    await playback;
  });

  it('registers a stopper and resolves when playback finishes', async () => {
    (globalThis as any).AudioContext = undefined;
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    stubBlobUrlHelpers({ createObjectURL, revokeObjectURL });

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

  it('pauses retained HTML audio for a speech candidate and resumes it after a false alarm', async () => {
    (globalThis as any).AudioContext = undefined;
    stubBlobUrlHelpers({
      createObjectURL: vi.fn(() => 'blob:candidate'),
      revokeObjectURL: vi.fn(),
    });
    const endedHandler = { current: null as (() => void) | null };
    const pause = vi.fn();
    const play = vi.fn(async () => {});
    (globalThis as any).Audio = function AudioMock() {
      return {
        pause,
        play,
        set onended(cb: (() => void) | null) { endedHandler.current = cb; },
        get onended() { return endedHandler.current; },
        onerror: null,
      };
    } as any;

    const target = {
      current: null as import('@/voice/runtime/playback/VoicePlaybackController').VoicePlaybackTarget | null,
    };
    const registerPlaybackStopper = Object.assign(
      (_stopper: () => void) => () => {},
      {
        registerTarget(next: import('@/voice/runtime/playback/VoicePlaybackController').VoicePlaybackTarget) {
          target.current = next;
          return () => {};
        },
      },
    );
    const playback = playAudioBytesWithStopper({
      bytes: new ArrayBuffer(4),
      format: 'wav',
      registerPlaybackStopper,
    });
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    const activeTarget = target.current;
    if (!activeTarget?.beginCandidate || !activeTarget.resolveCandidate) {
      throw new Error('Expected candidate-aware playback target');
    }
    expect(activeTarget.beginCandidate()).toBe('retained');
    expect(pause).toHaveBeenCalledTimes(1);
    activeTarget.resolveCandidate('false_alarm');
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));

    if (!endedHandler.current) throw new Error('Expected audio ended handler');
    endedHandler.current();
    await playback;
  });

  it('retains a WebAudio candidate that arrives while decoding and starts only after a false alarm', async () => {
    let resolveDecode!: (buffer: AudioBuffer) => void;
    let endedHandler: (() => void) | null = null;
    const start = vi.fn();
    class DeferredDecodeAudioContext {
      destination = {};
      currentTime = 0;
      async resume() {}
      decodeAudioData() {
        return new Promise<AudioBuffer>((resolve) => { resolveDecode = resolve; });
      }
      createBufferSource() {
        return {
          buffer: null,
          connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), start,
          set onended(value: (() => void) | null) { endedHandler = value; },
          get onended() { return endedHandler; },
        } as unknown as AudioBufferSourceNode;
      }
    }
    (globalThis as any).AudioContext = DeferredDecodeAudioContext;
    const target = {
      current: null as import('@/voice/runtime/playback/VoicePlaybackController').VoicePlaybackTarget | null,
    };
    const registerPlaybackStopper = Object.assign(
      (_stopper: () => void) => () => {},
      {
        registerTarget(next: import('@/voice/runtime/playback/VoicePlaybackController').VoicePlaybackTarget) {
          target.current = next;
          return () => {};
        },
      },
    );
    const playback = playAudioBytesWithStopper({
      bytes: new ArrayBuffer(4),
      format: 'wav',
      registerPlaybackStopper,
    });
    await vi.waitFor(() => expect(target.current).not.toBeNull());
    const activeTarget = target.current;
    if (!activeTarget?.beginCandidate || !activeTarget.resolveCandidate) {
      throw new Error('Expected candidate-aware WebAudio target');
    }

    expect(activeTarget.beginCandidate()).toBe('retained');
    resolveDecode({ duration: 1 } as AudioBuffer);
    await Promise.resolve();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();

    activeTarget.resolveCandidate('false_alarm');
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    if (!endedHandler) throw new Error('Expected WebAudio completion handler');
    (endedHandler as () => void)();
    await playback;
  });

  it('calls onPlaybackStarted after Audio.play() resolves', async () => {
    (globalThis as any).AudioContext = undefined;
    stubBlobUrlHelpers({
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });

    let endedHandler: (() => void) | null = null;
    let resolvePlay!: () => void;
    const play = vi.fn(() => new Promise<void>((resolve) => {
      resolvePlay = resolve;
    }));
    const onPlaybackStarted = vi.fn();

    (globalThis as any).Audio = function AudioMock(_url: string) {
      return {
        pause: vi.fn(),
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

    const promise = playAudioBytesWithStopper({
      bytes: new ArrayBuffer(4),
      format: 'wav',
      registerPlaybackStopper: () => () => {},
      onPlaybackStarted,
    });

    expect(onPlaybackStarted).not.toHaveBeenCalled();
    resolvePlay();
    await vi.waitFor(() => {
      expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
    });
    const notifyEnded = endedHandler as (() => void) | null;
    if (!notifyEnded) {
      throw new Error('Expected audio ended handler to be registered');
    }
    notifyEnded();
    await promise;
  });

  it('does not report HTML playback started when stop wins before Audio.play() resolves', async () => {
    (globalThis as unknown as { AudioContext?: unknown }).AudioContext = undefined;
    stubBlobUrlHelpers({
      createObjectURL: vi.fn(() => 'blob:stopped-before-play'),
      revokeObjectURL: vi.fn(),
    });
    let resolvePlay!: () => void;
    const play = vi.fn(() => new Promise<void>((resolve) => {
      resolvePlay = resolve;
    }));
    const onPlaybackStarted = vi.fn();
    (globalThis as unknown as { Audio?: unknown }).Audio = function AudioMock() {
      return {
        pause: vi.fn(),
        play,
        onended: null,
        onerror: null,
      };
    };
    let registeredStopper: (() => void) | null = null;
    const playback = playAudioBytesWithStopper({
      bytes: new ArrayBuffer(4),
      format: 'wav',
      registerPlaybackStopper: (stopper) => {
        registeredStopper = stopper;
        return () => {};
      },
      onPlaybackStarted,
    });
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    const stopPlayback = registeredStopper as (() => void) | null;
    if (!stopPlayback) throw new Error('Expected playback stopper to be registered');
    stopPlayback();
    await playback;
    resolvePlay();
    await Promise.resolve();

    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });

  it('rejects when Audio.play() returns a rejected promise (autoplay blocked)', async () => {
    (globalThis as any).AudioContext = undefined;
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    stubBlobUrlHelpers({ createObjectURL, revokeObjectURL });

    const pause = vi.fn();
    const play = vi.fn(() => Promise.reject(new Error('NotAllowedError')));

    (globalThis as any).Audio = function AudioMock(_url: string) {
      return { pause, play, onended: null, onerror: null };
    } as any;

    const onPlaybackStarted = vi.fn();

    await expect(
      playAudioBytesWithStopper({
        bytes: new ArrayBuffer(4),
        format: 'wav',
        registerPlaybackStopper: () => () => {},
        onPlaybackStarted,
      }),
    ).rejects.toThrow(/NotAllowedError/);

    expect(onPlaybackStarted).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });
});

describe('playAudioBytesWithStopper (native)', () => {
  it('uses expo-audio playback on native platforms', async () => {
    platformOsMock.value = 'ios';
    vi.spyOn(Date, 'now').mockReturnValue(1234);

    const createAudioPlayer = vi.fn((source: string) => {
      let listener: ((status: any) => void) | null = null;
      return {
        source,
        addListener: (_event: string, cb: (status: any) => void) => {
          listener = cb;
          return { remove: vi.fn() };
        },
        play: vi.fn(),
        remove: vi.fn(),
        __emit: (status: any) => listener?.(status),
      };
    });
    const fileDelete = vi.fn(async () => {});
    const fileWrite = vi.fn(async () => {});

    vi.doMock('expo-audio', () => ({
      createAudioPlayer,
    }));
    vi.doMock('expo-file-system', () => ({
      Paths: { cache: 'file:///tmp/' },
      File: class {
        uri: string;
        constructor(...uris: any[]) {
          const [base, name] = uris;
          this.uri = `${String(base)}${String(name ?? '')}`;
        }
        write = fileWrite;
        delete = fileDelete;
      },
      deleteAsync: () => {
        throw new Error('deprecated_deleteAsync_called');
      },
    }));

    let registeredStopper: (() => void) | null = null;
    const registerPlaybackStopper = (stopper: () => void) => {
      registeredStopper = stopper;
      return () => {};
    };

    try {
      const promise = playAudioBytesWithStopper({
        bytes: new Uint8Array([1, 2, 3]).buffer,
        format: 'wav',
        registerPlaybackStopper,
      });

      await vi.waitFor(() => {
        expect(createAudioPlayer).toHaveBeenCalledTimes(1);
      });
      expect(typeof registeredStopper).toBe('function');
      expect(createAudioPlayer).toHaveBeenCalledWith('file:///tmp/happier-voice-1234.wav');

      (createAudioPlayer.mock.results[0]?.value as { __emit?: (status: any) => void } | undefined)?.__emit?.({
        didJustFinish: true,
      });

      await promise;

      expect(fileDelete).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
