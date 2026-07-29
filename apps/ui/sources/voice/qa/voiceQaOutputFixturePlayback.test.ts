import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

import {
  getVoiceQaOutputTapSnapshot,
  resetVoiceQaOutputTapForTests,
  setVoiceQaOutputTapEnabled,
} from './voiceQaOutputTap';
import { resetWebAudioContextForTests } from '@/voice/output/webAudioContext';
import { createVoiceQaOutputFixturePlayback } from './voiceQaOutputFixturePlayback';

describe('voiceQaOutputFixturePlayback', () => {
  const originalDebug = process.env.EXPO_PUBLIC_DEBUG;
  const originalAudioContext = (globalThis as typeof globalThis & { AudioContext?: unknown }).AudioContext;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_DEBUG = '1';
    resetWebAudioContextForTests();
    resetVoiceQaOutputTapForTests();
    setVoiceQaOutputTapEnabled(true);
  });

  afterEach(() => {
    process.env.EXPO_PUBLIC_DEBUG = originalDebug;
    (globalThis as typeof globalThis & { AudioContext?: unknown }).AudioContext = originalAudioContext;
    resetWebAudioContextForTests();
    resetVoiceQaOutputTapForTests();
    vi.restoreAllMocks();
  });

  it('plays a fetched WAV through the canonical sink and settles its output artifact', async () => {
    let ended: (() => void) | null = null;
    (globalThis as any).AudioContext = class {
      destination = {};
      async resume() {}
      async decodeAudioData() {
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
            ended = value;
          },
          get onended() {
            return ended;
          },
        } as unknown as AudioBufferSourceNode;
      }
    };
    const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 65, 86, 69]);
    const playback = createVoiceQaOutputFixturePlayback({
      fetch: vi.fn(async () => new Response(wav, {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      })),
    });

    let settled = false;
    const done = playback.play('https://fixtures.invalid/short.wav').finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('playing'));
    await Promise.resolve();
    expect(settled).toBe(false);
    if (!ended) throw new Error('Expected fixture playback completion handler');
    (ended as () => void)();
    await done;

    expect(getVoiceQaOutputTapSnapshot().artifact).toMatchObject({
      format: 'wav',
      originalByteLength: wav.byteLength,
      lifecycle: 'completed',
    });
  });

  it('rejects non-WAV payloads before they reach playback', async () => {
    const playback = createVoiceQaOutputFixturePlayback({
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })),
    });

    await expect(playback.play('https://fixtures.invalid/not-a-wav')).rejects.toThrow(
      'voice_qa_output_fixture_invalid_wav',
    );
    expect(getVoiceQaOutputTapSnapshot().artifact).toBeNull();
  });

  it('stops reading a chunked response as soon as the fixture byte limit is exceeded', async () => {
    const oversizedChunk = new Uint8Array((4 * 1024 * 1024) + 1);
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const arrayBuffer = vi.fn(async () => {
      throw new Error('unbounded_array_buffer_read');
    });
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: oversizedChunk })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const response = {
      ok: true,
      headers: new Headers({ 'content-type': 'audio/wav' }),
      body: {
        getReader: () => ({ read, cancel, releaseLock }),
      },
      arrayBuffer,
    } as unknown as Response;
    const playback = createVoiceQaOutputFixturePlayback({
      fetch: vi.fn(async () => response),
    });

    await expect(playback.play('https://fixtures.invalid/chunked-too-large.wav')).rejects.toThrow(
      'voice_qa_output_fixture_too_large',
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(getVoiceQaOutputTapSnapshot().artifact).toBeNull();
  });

  it('cancels only the active attempt and does not poison the next playback', async () => {
    const endedHandlers: Array<(() => void) | null> = [];
    (globalThis as any).AudioContext = class {
      destination = {};
      async resume() {}
      async decodeAudioData() {
        return { duration: 0.2 } as AudioBuffer;
      }
      createBufferSource() {
        const index = endedHandlers.length;
        endedHandlers.push(null);
        return {
          buffer: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(() => endedHandlers[index]?.()),
          set onended(value: (() => void) | null) {
            endedHandlers[index] = value;
          },
          get onended() {
            return endedHandlers[index];
          },
        } as unknown as AudioBufferSourceNode;
      }
    };
    const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 65, 86, 69]);
    const playback = createVoiceQaOutputFixturePlayback({
      fetch: vi.fn(async () => new Response(wav, { status: 200 })),
    });

    let firstSettled = false;
    const first = playback.play('https://fixtures.invalid/first.wav').finally(() => {
      firstSettled = true;
    });
    await vi.waitFor(() => expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('playing'));
    playback.stop();
    await vi.waitFor(() => expect(firstSettled).toBe(true));
    await first;
    expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('cancelled');

    let secondSettled = false;
    const second = playback.play('https://fixtures.invalid/second.wav').finally(() => {
      secondSettled = true;
    });
    await vi.waitFor(() => {
      expect(getVoiceQaOutputTapSnapshot().artifact).toMatchObject({ id: 2, lifecycle: 'playing' });
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(endedHandlers[1]).toBeTypeOf('function');
    endedHandlers[1]?.();
    await vi.waitFor(() => expect(secondSettled).toBe(true));
    await second;
    expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('completed');
  });
});
