import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebSocketPcmConnection } from './VoiceRealtimeConnection';
import { installVoiceWebRtcBrowserBoundary, TestVoiceAudioContext } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { createDeferred } from '@/dev/testkit';

import {
  createWebSocketPcmMedia,
  decodePcm16LeBase64,
  encodePcm16LeBase64,
} from './WebSocketPcmMedia';

describe('WebSocketPcmMedia', () => {
  it.each(['completed', 'clear', 'suspended'] as const)('captures the whole read-back playback before waiting: %s', async outcome => {
    const harness = await createBrowserPlaybackHarness();
    const { media } = harness;
    await media.pcm.start(new AbortController().signal);
    const playback = media.captureOutputPlayback();
    harness.enqueueSeconds(1, 1_000);
    if (outcome === 'clear') media.clearOutput();
    if (outcome === 'suspended') {
      media.pcm.setOutputFocusState?.('suspended');
      media.pcm.setOutputFocusState?.('active');
    }
    harness.context.currentTime = 1;
    harness.sources[0]?.onended?.();
    expect(await playback.waitForDrain(new AbortController().signal)).toBe(outcome === 'completed' ? 'completed' : 'cancelled');
    await media.pcm.stop();
  });
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function createBrowserPlaybackHarness() {
    const context = new TestVoiceAudioContext();
    const { sources, gain, disconnectGain, processor, captureSource } = context;
    const browser = installVoiceWebRtcBrowserBoundary({
      createAudioContext: () => context as unknown as AudioContext,
    });
    const { micSession: mic } = browser;
    await mic.ensureActive();
    const { micTrack: track, micStream: stream } = browser;
    const inputChunkReceived = createDeferred<void>();
    const onInputChunk = vi.fn((_chunk: string) => { inputChunkReceived.resolve(); });
    const onInputError = vi.fn();
    const onOutputLevel = vi.fn();
    const media = createWebSocketPcmMedia({
      mic,
      input: { sampleRate: 24_000, chunkMs: 100 },
      output: { sampleRate: 24_000, retainedOutputMaxMs: 1_500 },
      onInputChunk, onInputError, onOutputLevel,
    });
    cleanups.push(async () => { await media.pcm.stop(); await mic.teardown(); browser.restore(); });
    const enqueueSeconds = (seconds: number, marker: number) => media.enqueueOutput(
      encodePcm16LeBase64(new Int16Array(seconds * 24_000).fill(marker)),
    );
    const emitInput = (samples: Float32Array) => context.emitInput(samples);
    return { media, mic, context, sources, gain, disconnectGain, enqueueSeconds,
      processor, captureSource, track, stream, onInputChunk, onInputError, onOutputLevel, emitInput,
      inputChunkReceived: inputChunkReceived.promise };
  }

  it('accepts faster-than-realtime output beyond five seconds in order and drains only after the complete burst', async () => {
    const harness = await createBrowserPlaybackHarness();
    await harness.media.pcm.start(new AbortController().signal);
    expect(harness.enqueueSeconds(4, 1_000)).toBe(true);
    expect(harness.enqueueSeconds(4, 2_000)).toBe(true);
    expect(harness.enqueueSeconds(4, 3_000)).toBe(true);
    expect(harness.sources.map((source) => source.start.mock.calls[0]?.[0])).toEqual([0, 4, 8]);
    expect(harness.sources.map((source) => source.buffer?.samples[0])).toEqual([
      expect.closeTo(1_000 / 32_767), expect.closeTo(2_000 / 32_767), expect.closeTo(3_000 / 32_767),
    ]);
    let drained = false;
    const drain = harness.media.waitForOutputDrain(new AbortController().signal).then(result => { drained = true; return result; });
    harness.sources[0]!.onended?.();
    harness.sources[1]!.onended?.();
    await Promise.resolve();
    expect(drained).toBe(false);
    harness.context.currentTime = 12;
    harness.sources[2]!.onended?.();
    expect(await drain).toBe('completed');
    expect(harness.media.playbackCursorMs()).toBe(12_000);
    expect(harness.sources.every((source) => source.disconnect.mock.calls.length === 1)).toBe(true);
    await harness.media.pcm.stop();
    expect(harness.disconnectGain).toHaveBeenCalledOnce();
  });

  it('ducks a long accepted burst during a candidate and clears every source on confirmed interruption', async () => {
    const harness = await createBrowserPlaybackHarness();
    await harness.media.pcm.start(new AbortController().signal);
    expect(harness.enqueueSeconds(4, 1_000)).toBe(true);
    expect(harness.enqueueSeconds(4, 2_000)).toBe(true);
    expect(harness.media.beginOutputInterruptionCandidate()).toBe('ducked');
    expect(harness.sources.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
    expect(harness.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.18, 0, 0.015);
    expect(harness.enqueueSeconds(4, 3_000)).toBe(true);
    harness.media.resolveOutputInterruptionCandidate('false_alarm');
    expect(harness.sources).toHaveLength(3);
    expect(harness.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.015);
    expect(harness.media.beginOutputInterruptionCandidate()).toBe('ducked');
    const drain = harness.media.waitForOutputDrain(new AbortController().signal);
    harness.media.resolveOutputInterruptionCandidate('confirmed');
    expect(await drain).toBe('cancelled');
    expect(harness.sources.every((source) => source.stop.mock.calls.length === 1 && source.onended === null)).toBe(true);
    harness.media.resolveOutputInterruptionCandidate('false_alarm');
    expect(harness.sources).toHaveLength(3);
    await harness.media.pcm.stop();
    expect(harness.enqueueSeconds(1, 4_000)).toBe(false);
  });

  it('promotes retained candidate audio to ducked playback when a burst outgrows retention without losing its tail', async () => {
    const harness = await createBrowserPlaybackHarness();
    await harness.media.pcm.start(new AbortController().signal);
    expect(harness.enqueueSeconds(1, 1_000)).toBe(true);
    harness.context.currentTime = 0.25;
    expect(harness.media.beginOutputInterruptionCandidate()).toBe('retained');
    expect(harness.enqueueSeconds(4, 2_000)).toBe(true);
    expect(harness.sources).toHaveLength(3);
    expect(harness.sources[1]!.start).toHaveBeenCalledWith(0.25);
    expect(harness.sources[2]!.start).toHaveBeenCalledWith(1);
    expect(harness.sources[1]!.buffer?.samples.length).toBe(18_000);
    expect(harness.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.18, 0.25, 0.015);
    harness.media.resolveOutputInterruptionCandidate('false_alarm');
    expect(harness.sources).toHaveLength(3);
    await harness.media.pcm.stop();
  });

  it('exposes browser candidate interruption through the host PCM connection', async () => {
    const harness = await createBrowserPlaybackHarness();
    const connection = createWebSocketPcmConnection({
      driver: { open: async () => {}, sendControl: async () => {}, close: async () => {} },
      pcm: harness.media.pcm,
    });
    await connection.connect(new AbortController().signal);
    expect(harness.enqueueSeconds(1, 1_000)).toBe(true);
    expect(connection.beginOutputInterruptionCandidate()).toBe('retained');
    connection.resolveOutputInterruptionCandidate('false_alarm');
    expect(harness.sources).toHaveLength(2);
    await connection.close({ code: 'user_stop' });
    expect(harness.sources[1]!.stop).toHaveBeenCalledOnce();
  });

  it('settles aborted drain waits and releases the complete queued burst on stop', async () => {
    const harness = await createBrowserPlaybackHarness();
    await harness.media.pcm.start(new AbortController().signal);
    expect(harness.enqueueSeconds(4, 1_000)).toBe(true);
    expect(harness.enqueueSeconds(4, 2_000)).toBe(true);
    const preAborted = new AbortController();
    preAborted.abort();
    await harness.media.waitForOutputDrain(preAborted.signal);
    const controller = new AbortController();
    const abortedDrain = harness.media.waitForOutputDrain(controller.signal);
    controller.abort();
    await abortedDrain;
    expect(harness.sources.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
    const drain = harness.media.waitForOutputDrain(new AbortController().signal);
    await harness.media.pcm.stop();
    expect(await drain).toBe('cancelled');
    expect(harness.sources.every((source) => source.stop.mock.calls.length === 1 && source.onended === null)).toBe(true);
    expect(harness.media.outputLevel()).toBe(0);
  });

  it('round-trips PCM16LE without a Buffer/browser-global dependency', () => {
    const source = new Int16Array([-32768, -1, 0, 1, 32767]);
    expect([...decodePcm16LeBase64(encodePcm16LeBase64(source))]).toEqual([...source]);
  });

  it('reuses the canonical mic stream/context and owns idempotent cleanup', async () => {
    const harness = await createBrowserPlaybackHarness();
    const { media, context, stream, onInputChunk, onOutputLevel } = harness;
    await media.pcm.start(new AbortController().signal);
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(stream);
    harness.emitInput(new Float32Array(2_400).fill(0.25));
    await harness.inputChunkReceived;
    expect(onInputChunk).toHaveBeenCalledWith(encodePcm16LeBase64(new Int16Array(2_400).fill(8_192)));
    expect(media.inputLevel()).toBe(0.25);
    expect(harness.enqueueSeconds(4, 16_384)).toBe(true);
    expect(media.outputLevel()).toBeCloseTo(0.5);
    expect(onOutputLevel).toHaveBeenLastCalledWith(expect.closeTo(0.5));
    context.currentTime = 0.012;
    expect(media.playbackCursorMs()).toBe(12);
    expect(media.beginOutputInterruptionCandidate()).toBe('ducked');
    expect(harness.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.18, 0.012, 0.015);
    expect(media.outputLevel()).toBeCloseTo(0.5);
    media.resolveOutputInterruptionCandidate('false_alarm');
    expect(harness.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0.012, 0.015);
    await media.pcm.stop();
    await media.pcm.stop();
    expect(harness.processor.disconnect).toHaveBeenCalledOnce();
    expect(harness.captureSource.disconnect).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(onOutputLevel).toHaveBeenLastCalledWith(0);
  });

  it.each(['throws', 'returns an unsettled promise'] as const)('stops playback and clears the output meter when the browser capture node cleanup %s', async (outcome) => {
    const harness = await createBrowserPlaybackHarness();
    const { media, onOutputLevel } = harness;
    await media.pcm.start(new AbortController().signal);
    expect(harness.enqueueSeconds(4, 16_384)).toBe(true);
    harness.processor.disconnect.mockImplementationOnce(() => {
      if (outcome === 'throws') throw new Error('browser_capture_cleanup_failed');
      return new Promise<void>(() => {});
    });
    await expect(media.pcm.stop()).resolves.toBeUndefined();
    expect(harness.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(harness.processor.onaudioprocess).toBeNull();
    expect(onOutputLevel).toHaveBeenLastCalledWith(0);
  });

  it('publishes a terminal notification when browser capture fails mid-session', async () => {
    const harness = await createBrowserPlaybackHarness();
    const { media, onInputError } = harness;

    // The connection subscribes to the same terminal contract the native sibling
    // exposes; without it a dead capture leaves the session open, deaf and mute.
    expect(typeof media.pcm.subscribeTerminal).toBe('function');
    const terminal = vi.fn();
    media.pcm.subscribeTerminal?.(terminal);

    await media.pcm.start(new AbortController().signal);
    expect(harness.enqueueSeconds(4, 16_384)).toBe(true);
    harness.track.dispatchEvent(new Event('ended'));

    expect(onInputError).toHaveBeenCalledWith('pcm_capture_device_lost');
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]?.[0]).toMatchObject({ message: 'pcm_capture_device_lost' });

    // The failure is latched, so a subscriber attached after the fault still
    // learns the media is dead instead of waiting on a stream that never resumes.
    const late = vi.fn();
    media.pcm.subscribeTerminal?.(late);
    expect(late).toHaveBeenCalledTimes(1);

    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(harness.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(harness.processor.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects output before playback startup', () => {
    const media = createWebSocketPcmMedia({
      mic: { getStream: () => null, getAudioContext: () => null },
      input: { sampleRate: 24_000, chunkMs: 100 },
      output: { sampleRate: 24_000 },
      onInputChunk: vi.fn(),
    });
    const twentyMs = encodePcm16LeBase64(new Int16Array(480));
    expect(media.enqueueOutput(twentyMs)).toBe(false);
  });

  it('tears down both media halves when capture startup fails', async () => {
    const harness = await createBrowserPlaybackHarness();
    const { media } = harness;
    harness.context.createMediaStreamSource.mockImplementationOnce(() => { throw new Error('browser_source_failed'); });
    await expect(media.pcm.start(new AbortController().signal)).rejects.toMatchObject({ code: 'pcm_capture_media_source_failed' });
    expect(harness.disconnectGain).toHaveBeenCalledOnce();
    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array(480)))).toBe(false);
    await media.pcm.stop();
    expect(harness.disconnectGain).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'abort'])('fences pending browser capture after %s without retiring the retry', async (cancellation) => {
    const harness = await createBrowserPlaybackHarness();
    let finishResume!: () => void;
    const pendingResume = new Promise<void>((resolve) => { finishResume = resolve; });
    let suspended = true;
    const resumeEntered = createDeferred<void>();
    const resume = vi.fn(() => {
      if (resume.mock.calls.length === 1) {
        expect(resume).toHaveBeenCalledOnce();
        resumeEntered.resolve();
      }
      return pendingResume;
    });
    Object.defineProperties(harness.context, {
      state: { get: () => suspended ? 'suspended' : 'running' },
      resume: { value: resume },
    });
    const abortController = new AbortController();
    const starting = harness.media.pcm.start(abortController.signal).then(() => null, (error: unknown) => error);
    try {
      await resumeEntered.promise;
      if (cancellation === 'stop') await harness.media.pcm.stop();
      else abortController.abort();
      suspended = false;
      if (cancellation === 'stop') await harness.media.pcm.start(new AbortController().signal);
      finishResume();
      await expect(starting).resolves.toMatchObject({ name: 'AbortError' });
      if (cancellation === 'abort') await harness.media.pcm.start(new AbortController().signal);
      expect(harness.enqueueSeconds(1, 1_000)).toBe(true);
      harness.emitInput(new Float32Array(2_400).fill(0.25));
      await harness.inputChunkReceived;
      expect(harness.onInputChunk).toHaveBeenCalled();
      expect(harness.onInputError).not.toHaveBeenCalled();
    } finally {
      finishResume();
      await starting;
    }
  });

  it('pauses PCM output on a candidate, retains only the bounded playable tail, and resumes it on a false alarm', async () => {
    const harness = await createBrowserPlaybackHarness();
    const { media, context, sources } = harness;
    const setTargetAtTime = harness.gain.setTargetAtTime;
    await media.pcm.start(new AbortController().signal);

    expect(media.pcm.setOutputFocusState?.('suspended')).toBe('applied');
    expect(setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.015);
    expect(media.pcm.setOutputFocusState?.('ducked')).toBe('applied');
    expect(setTargetAtTime).toHaveBeenLastCalledWith(0.18, 0, 0.015);
    expect(media.pcm.setOutputFocusState?.('active')).toBe('applied');
    expect(setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.015);

    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array(24_000)))).toBe(true);
    context.currentTime = 0.25;
    expect(media.beginOutputInterruptionCandidate()).toBe('retained');
    expect(sources[0]!.stop).toHaveBeenCalledTimes(1);
    expect(media.playbackCursorMs()).toBe(250);
    expect(media.outputLevel()).toBe(0);

    // 750ms remains from the interrupted chunk. A second 750ms chunk reaches
    // the canonical retention boundary and still resumes without ducking.
    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array(18_000)))).toBe(true);

    media.resolveOutputInterruptionCandidate('false_alarm');
    expect(sources).toHaveLength(3);
    expect(sources[1]!.start).toHaveBeenCalledWith(0.25);
    expect(sources[2]!.start).toHaveBeenCalledWith(1);
    await media.pcm.stop();
  });

  it('discards retained PCM after confirmed interruption and never replays it on a late false alarm', async () => {
    const { media, sources } = await createBrowserPlaybackHarness();
    await media.pcm.start(new AbortController().signal);
    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array(24_000)))).toBe(true);
    expect(media.beginOutputInterruptionCandidate()).toBe('retained');
    expect(media.enqueueOutput(encodePcm16LeBase64(new Int16Array(12_000)))).toBe(true);

    media.resolveOutputInterruptionCandidate('confirmed');
    media.resolveOutputInterruptionCandidate('false_alarm');
    expect(sources).toHaveLength(1);
    await media.pcm.stop();
  });
});
