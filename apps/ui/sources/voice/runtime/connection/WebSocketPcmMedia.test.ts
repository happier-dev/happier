import { describe, expect, it, vi } from 'vitest';

import {
  createWebSocketPcmMedia,
  decodePcm16LeBase64,
  encodePcm16LeBase64,
} from './WebSocketPcmMedia';

describe('WebSocketPcmMedia', () => {
  it('round-trips PCM16LE without a Buffer/browser-global dependency', () => {
    const source = new Int16Array([-32768, -1, 0, 1, 32767]);
    expect([...decodePcm16LeBase64(encodePcm16LeBase64(source))]).toEqual([...source]);
  });

  it('reuses the canonical mic stream/context and owns idempotent cleanup', async () => {
    const stream = {} as MediaStream;
    const context = { currentTime: 0 } as AudioContext;
    const stopCapture = vi.fn(async () => {});
    const stopPlayback = vi.fn();
    let candidateActive = false;
    const beginCandidate = vi.fn(() => { candidateActive = true; return 'ducked' as const; });
    const resolveCandidate = vi.fn(() => { candidateActive = false; });
    const onInputChunk = vi.fn();
    const onOutputLevel = vi.fn();
    const media = createWebSocketPcmMedia({
      mic: { ensureActive: vi.fn(async () => {}), isMuted: () => false, getStream: () => stream, getAudioContext: () => context },
      input: { sampleRate: 24_000, chunkMs: 100 },
      output: { sampleRate: 24_000, maxBufferedMs: 1_000 },
      onInputChunk,
      onOutputLevel,
      createCapture: vi.fn(({ mic, format, onChunk }) => {
        expect(mic.getStream()).toBe(stream);
        expect(mic.getAudioContext?.()).toBe(context);
        expect(format).toEqual({ sampleRate: 24_000, channels: 1, encoding: 'pcm16le' });
        let active = false;
        let level = 0;
        return {
          async start() {
            active = true;
            level = 0.25;
            await onChunk({ bytes: new Uint8Array(new Int16Array([1, 2, 3]).buffer), level });
          },
          async stop() { active = false; await stopCapture(); },
          async waitForDrain() {},
          isActive: () => active,
          level: () => level,
        };
      }),
      createOutputScheduler: vi.fn(() => ({
        enqueue: vi.fn(() => true), clear: vi.fn(), stop: stopPlayback,
        beginCandidate, resolveCandidate,
        waitForDrain: vi.fn(async () => undefined), playbackCursorMs: vi.fn(() => 12), outputLevel: vi.fn(() => candidateActive ? 0 : 0.5),
      })),
    });
    await media.pcm.start(new AbortController().signal);
    expect(onInputChunk).toHaveBeenCalledWith(encodePcm16LeBase64(new Int16Array([1, 2, 3])));
    expect(media.inputLevel()).toBe(0.25);
    expect(media.outputLevel()).toBe(0.5);
    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array([1, 2])))).toBe(true);
    expect(onOutputLevel).toHaveBeenLastCalledWith(0.5);
    expect(media.playbackCursorMs()).toBe(12);
    expect(media.beginOutputInterruptionCandidate()).toBe('ducked');
    expect(onOutputLevel).toHaveBeenLastCalledWith(0);
    media.resolveOutputInterruptionCandidate('false_alarm');
    expect(onOutputLevel).toHaveBeenLastCalledWith(0.5);
    expect(resolveCandidate).toHaveBeenCalledWith('false_alarm');
    await media.pcm.stop();
    await media.pcm.stop();
    expect(stopCapture).toHaveBeenCalledTimes(1);
    expect(stopPlayback).toHaveBeenCalledTimes(1);
    expect(onOutputLevel).toHaveBeenLastCalledWith(0);
  });

  it('bounds output queued before playback startup', () => {
    const media = createWebSocketPcmMedia({
      mic: { getStream: () => null, getAudioContext: () => null },
      input: { sampleRate: 24_000, chunkMs: 100 },
      output: { sampleRate: 24_000, maxBufferedMs: 10 },
      onInputChunk: vi.fn(),
    });
    const twentyMs = encodePcm16LeBase64(new Int16Array(480));
    expect(media.enqueueOutput(twentyMs)).toBe(false);
  });

  it('tears down both media halves when capture startup fails', async () => {
    const stopCapture = vi.fn(async () => {});
    const stopPlayback = vi.fn();
    const media = createWebSocketPcmMedia({
      mic: { getStream: () => ({} as MediaStream), getAudioContext: () => ({ currentTime: 0 } as AudioContext) },
      input: { sampleRate: 24_000, chunkMs: 20 },
      output: { sampleRate: 24_000, maxBufferedMs: 1_000 },
      onInputChunk: vi.fn(),
      createCapture: vi.fn(() => ({
        start: vi.fn(async () => { throw Object.assign(new Error('denied'), { code: 'mic_denied' }); }),
        stop: stopCapture,
        waitForDrain: vi.fn(async () => {}),
        isActive: () => false,
        level: () => 0,
      })),
      createOutputScheduler: vi.fn(() => ({
        enqueue: vi.fn(() => true), clear: vi.fn(), stop: stopPlayback,
        beginCandidate: vi.fn(() => 'ducked' as const), resolveCandidate: vi.fn(),
        waitForDrain: vi.fn(async () => {}), playbackCursorMs: () => 0, outputLevel: () => 0,
      })),
    });

    await expect(media.pcm.start(new AbortController().signal)).rejects.toMatchObject({ code: 'mic_denied' });
    expect(stopCapture).toHaveBeenCalledTimes(1);
    expect(stopPlayback).toHaveBeenCalledTimes(1);
    await media.pcm.stop();
    expect(stopCapture).toHaveBeenCalledTimes(1);
    expect(stopPlayback).toHaveBeenCalledTimes(1);
  });

  it('pauses PCM output on a candidate, retains only the bounded playable tail, and resumes it on a false alarm', async () => {
    type FakeSource = Readonly<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> & { buffer: AudioBuffer | null; onended: (() => void) | null };
    const sources: FakeSource[] = [];
    const context = {
      currentTime: 0,
      destination: {},
      createGain: () => ({
        gain: { value: 1, setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createBuffer: (_channels: number, length: number, sampleRate: number) => ({
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length),
      }),
      createBufferSource: () => {
        const source: FakeSource = {
          buffer: null,
          onended: null,
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
          connect: vi.fn(),
        } as unknown as FakeSource;
        sources.push(source);
        return source;
      },
    } as unknown as AudioContext;
    const media = createWebSocketPcmMedia({
      mic: { getStream: () => ({} as MediaStream), getAudioContext: () => context },
      input: { sampleRate: 24_000, chunkMs: 20 },
      output: { sampleRate: 24_000, maxBufferedMs: 5_000, retainedOutputMaxMs: 1_500 },
      onInputChunk: vi.fn(),
      createCapture: vi.fn(() => ({
        start: vi.fn(async () => {}), stop: vi.fn(async () => {}), waitForDrain: vi.fn(async () => {}),
        isActive: () => true, level: () => 0,
      })),
    });
    await media.pcm.start(new AbortController().signal);

    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array(24_000)))).toBe(true);
    (context as unknown as { currentTime: number }).currentTime = 0.25;
    expect(media.beginOutputInterruptionCandidate()).toBe('retained');
    expect(sources[0]!.stop).toHaveBeenCalledTimes(1);
    expect(media.playbackCursorMs()).toBe(250);
    expect(media.outputLevel()).toBe(0);

    // 750ms remains from the interrupted chunk. A second 750ms chunk reaches
    // the canonical 1.5s bound; any additional audio is rejected rather than
    // creating an unbounded hidden queue during a cough/noise candidate.
    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array(18_000)))).toBe(true);
    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array(2_400)))).toBe(false);

    media.resolveOutputInterruptionCandidate('false_alarm');
    expect(sources).toHaveLength(3);
    expect(sources[1]!.start).toHaveBeenCalledWith(0.25);
    expect(sources[2]!.start).toHaveBeenCalledWith(1);
    await media.pcm.stop();
  });

  it('discards retained PCM after confirmed interruption and never replays it on a late false alarm', async () => {
    const starts: Array<readonly unknown[]> = [];
    const context = {
      currentTime: 0,
      destination: {},
      createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
      createBuffer: (_channels: number, length: number, sampleRate: number) => ({
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length),
      }),
      createBufferSource: () => ({
        buffer: null,
        onended: null,
        connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(),
        start: (...args: unknown[]) => { starts.push(args); },
      }),
    } as unknown as AudioContext;
    const media = createWebSocketPcmMedia({
      mic: { getStream: () => ({} as MediaStream), getAudioContext: () => context },
      input: { sampleRate: 24_000, chunkMs: 20 },
      output: { sampleRate: 24_000, maxBufferedMs: 5_000, retainedOutputMaxMs: 1_500 },
      onInputChunk: vi.fn(),
      createCapture: vi.fn(() => ({
        start: vi.fn(async () => {}), stop: vi.fn(async () => {}), waitForDrain: vi.fn(async () => {}),
        isActive: () => true, level: () => 0,
      })),
    });
    await media.pcm.start(new AbortController().signal);
    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array(24_000)))).toBe(true);
    expect(media.beginOutputInterruptionCandidate()).toBe('retained');
    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array(12_000)))).toBe(true);

    media.resolveOutputInterruptionCandidate('confirmed');
    media.resolveOutputInterruptionCandidate('false_alarm');
    expect(starts).toHaveLength(1);
    await media.pcm.stop();
  });
});
