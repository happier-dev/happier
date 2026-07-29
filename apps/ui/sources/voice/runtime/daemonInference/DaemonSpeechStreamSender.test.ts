import { describe, expect, it, vi } from 'vitest';

import {
  DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
  type DaemonVoiceInferenceSttStreamStartResponse,
} from '@happier-dev/protocol';

import {
  createDaemonSpeechStreamSender,
  type DaemonSpeechStreamTransportChunkRequest,
} from './DaemonSpeechStreamSender';
import { createDaemonSpeechStreamCarrierAdapter } from './DaemonSpeechStreamCarrier';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settleWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed_out:${label}`)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startResponse(input: Readonly<{
  requestId?: string;
  streamId: string;
  generation: number;
  ackSeq?: number;
}>): DaemonVoiceInferenceSttStreamStartResponse {
  return {
    ok: true,
    requestId: input.requestId ?? 'request-1',
    streamId: input.streamId,
    generation: input.generation,
    ackSeq: input.ackSeq ?? -1,
    format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
  };
}

type ImpairmentProfile = Readonly<{
  label: 'direct' | 'rtt_50' | 'rtt_100' | 'rtt_150';
  rttMs: number;
  jitterMs: number;
  temporaryDelay: Readonly<{
    startsAtMs: number;
    durationMs: number;
    extraRttMs: number;
  }>;
}>;

type ImpairmentMetrics = Readonly<{
  profile: ImpairmentProfile['label'];
  audioDurationMs: number;
  frameCount: number;
  rttMs: number;
  jitterMs: number;
  temporaryDelayDurationMs: number;
  temporaryDelayExtraRttMs: number;
  captureToAppendP50Ms: number;
  captureToAppendP95Ms: number;
  captureToAckP50Ms: number;
  captureToAckP95Ms: number;
  partialLatencyP50Ms: number | null;
  partialLatencyP95Ms: number | null;
  effectiveSendCadenceMs: number;
  sendIntervalP95Ms: number;
  maxInFlightFrames: number;
  maxInFlightBytes: number;
  maxQueueDepth: number;
  peakRetainedPcmBytes: number;
  memoryGrowthBytes: number;
  droppedFrames: number;
  duplicateFrames: number;
  reorderedFrames: number;
}>;

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) throw new Error('cannot calculate a percentile without samples');
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]!;
}

async function runTenMinuteImpairmentProfile(profile: ImpairmentProfile): Promise<ImpairmentMetrics> {
  const frameDurationMs = 20;
  const frameBytes = 640;
  const audioDurationMs = 10 * 60_000;
  const frameCount = audioDurationMs / frameDurationMs;
  const captureTimesMs = new Array<number>(frameCount);
  const appendTimesMs = new Array<number>(frameCount);
  const ackTimesMs = new Array<number>(frameCount);
  const sendTimesMs: number[] = [];
  const sentSequences = new Set<number>();
  const pendingSettlements: Promise<void>[] = [];
  let capturedFrames = 0;
  let sentFrames = 0;
  let droppedFrames = 0;
  let duplicateFrames = 0;
  let reorderedFrames = 0;
  let activeFrames = 0;
  let activeBytes = 0;
  let maxInFlightFrames = 0;
  let maxInFlightBytes = 0;
  let maxQueueDepth = 0;
  let retainedPcmBytes = 0;
  let peakRetainedPcmBytes = 0;
  let lastSentSequence = -1;
  let lastAppendScheduledAtMs = -1;
  let lastAckScheduledAtMs = -1;
  let finishObservedInFlightFrames = -1;
  let finishObservedQueueDepth = -1;
  let virtualNowMs = 0;
  const appendEvents: Array<Readonly<{ atMs: number; run: () => void }>> = [];
  const ackEvents: Array<Readonly<{ atMs: number; run: () => void }>> = [];
  let nextAppendEvent = 0;
  let nextAckEvent = 0;

  const flushSenderMicrotasks = async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  };
  const advanceVirtualClockTo = async (targetMs: number) => {
    for (;;) {
      const appendEvent = appendEvents[nextAppendEvent];
      const ackEvent = ackEvents[nextAckEvent];
      const nextAtMs = Math.min(appendEvent?.atMs ?? Number.POSITIVE_INFINITY, ackEvent?.atMs ?? Number.POSITIVE_INFINITY);
      if (nextAtMs > targetMs) break;
      virtualNowMs = nextAtMs;
      if (appendEvent?.atMs === nextAtMs) {
        nextAppendEvent += 1;
        appendEvent.run();
      }
      if (ackEvent?.atMs === nextAtMs) {
        nextAckEvent += 1;
        ackEvent.run();
      }
      await flushSenderMicrotasks();
    }
    virtualNowMs = targetMs;
  };
  const drainVirtualClock = async () => {
    while (nextAppendEvent < appendEvents.length || nextAckEvent < ackEvents.length) {
      const nextAtMs = Math.min(
        appendEvents[nextAppendEvent]?.atMs ?? Number.POSITIVE_INFINITY,
        ackEvents[nextAckEvent]?.atMs ?? Number.POSITIVE_INFINITY,
      );
      await advanceVirtualClockTo(nextAtMs);
    }
  };

  const sender = createDaemonSpeechStreamSender({
    requestId: `request-${profile.label}`,
    maxBufferedChunks: 64,
    maxBufferedBytes: 64 * frameBytes,
    maxInFlightChunks: 8,
    maxInFlightBytes: 8 * frameBytes,
    transport: {
      start: async () => startResponse({ streamId: `stream-${profile.label}`, generation: 1 }),
      chunk: ({ seq }: DaemonSpeechStreamTransportChunkRequest) => {
        const sentAtMs = virtualNowMs;
        sendTimesMs.push(sentAtMs);
        sentFrames += 1;
        if (sentSequences.has(seq)) duplicateFrames += 1;
        sentSequences.add(seq);
        if (seq <= lastSentSequence) reorderedFrames += 1;
        lastSentSequence = Math.max(lastSentSequence, seq);
        activeFrames += 1;
        activeBytes += frameBytes;
        maxInFlightFrames = Math.max(maxInFlightFrames, activeFrames);
        maxInFlightBytes = Math.max(maxInFlightBytes, activeBytes);
        maxQueueDepth = Math.max(maxQueueDepth, capturedFrames - sentFrames);

        const captureAtMs = captureTimesMs[seq] ?? sentAtMs;
        const insideTemporaryDelay = captureAtMs >= profile.temporaryDelay.startsAtMs
          && captureAtMs < profile.temporaryDelay.startsAtMs + profile.temporaryDelay.durationMs;
        const jitterRange = (profile.jitterMs * 2) + 1;
        const deterministicJitterMs = profile.jitterMs === 0
          ? 0
          : ((seq * 17) % jitterRange) - profile.jitterMs;
        const totalRttMs = Math.max(
          0,
          profile.rttMs
            + deterministicJitterMs
            + (insideTemporaryDelay ? profile.temporaryDelay.extraRttMs : 0),
        );
        const uplinkMs = Math.floor(totalRttMs / 2);
        const downlinkMs = totalRttMs - uplinkMs;
        const appendScheduledAtMs = Math.max(sentAtMs + uplinkMs, lastAppendScheduledAtMs + 1);
        const ackScheduledAtMs = Math.max(appendScheduledAtMs + downlinkMs, lastAckScheduledAtMs + 1);
        lastAppendScheduledAtMs = appendScheduledAtMs;
        lastAckScheduledAtMs = ackScheduledAtMs;

        appendEvents.push({
          atMs: appendScheduledAtMs,
          run: () => {
            appendTimesMs[seq] = appendScheduledAtMs;
          },
        });

        return new Promise((resolve) => {
          ackEvents.push({
            atMs: ackScheduledAtMs,
            run: () => {
              ackTimesMs[seq] = ackScheduledAtMs;
              activeFrames -= 1;
              activeBytes -= frameBytes;
              resolve({
                ok: true as const,
                streamId: `stream-${profile.label}`,
                generation: 1,
                ackSeq: seq,
                // The existing append response carries transcript events. This impairment
                // profile does not manufacture partials, so partial latency is unavailable.
                events: [],
              });
            },
          });
        });
      },
      finish: async ({ finalSeq }) => {
        finishObservedInFlightFrames = activeFrames;
        finishObservedQueueDepth = capturedFrames - sentFrames;
        return {
          ok: true as const,
          streamId: `stream-${profile.label}`,
          generation: 1,
          ackSeq: finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        };
      },
      cancel: async () => ({ ok: true as const, streamId: `stream-${profile.label}`, generation: 1 }),
    },
  });

  await sender.start();
  for (let seq = 0; seq < frameCount; seq += 1) {
    await advanceVirtualClockTo(seq * frameDurationMs);
    captureTimesMs[seq] = virtualNowMs;
    capturedFrames += 1;
    retainedPcmBytes += frameBytes;
    peakRetainedPcmBytes = Math.max(peakRetainedPcmBytes, retainedPcmBytes);
    const settlement = sender.pushChunk(new Uint8Array(frameBytes)).then(
      () => {
        retainedPcmBytes -= frameBytes;
      },
      () => {
        retainedPcmBytes -= frameBytes;
        droppedFrames += 1;
      },
    );
    pendingSettlements.push(settlement);
    maxQueueDepth = Math.max(maxQueueDepth, capturedFrames - sentFrames - droppedFrames);
    await advanceVirtualClockTo(virtualNowMs);
  }

  await drainVirtualClock();
  await Promise.all(pendingSettlements);
  await sender.waitForDrain();
  const finishResponse = await sender.finish();

  expect(finishResponse).toMatchObject({ ok: true, ackSeq: frameCount - 1 });
  expect(finishObservedInFlightFrames).toBe(0);
  expect(finishObservedQueueDepth).toBe(0);
  expect(sentSequences.size).toBe(frameCount);

  const captureToAppendMs = appendTimesMs.map((appendAtMs, seq) => appendAtMs - captureTimesMs[seq]!);
  const captureToAckMs = ackTimesMs.map((ackAtMs, seq) => ackAtMs - captureTimesMs[seq]!);
  const sendIntervalsMs = sendTimesMs.slice(1).map((sentAtMs, index) => sentAtMs - sendTimesMs[index]!);
  const effectiveSendCadenceMs = (sendTimesMs.at(-1)! - sendTimesMs[0]!) / (sendTimesMs.length - 1);

  return {
    profile: profile.label,
    audioDurationMs,
    frameCount,
    rttMs: profile.rttMs,
    jitterMs: profile.jitterMs,
    temporaryDelayDurationMs: profile.temporaryDelay.durationMs,
    temporaryDelayExtraRttMs: profile.temporaryDelay.extraRttMs,
    captureToAppendP50Ms: percentile(captureToAppendMs, 50),
    captureToAppendP95Ms: percentile(captureToAppendMs, 95),
    captureToAckP50Ms: percentile(captureToAckMs, 50),
    captureToAckP95Ms: percentile(captureToAckMs, 95),
    partialLatencyP50Ms: null,
    partialLatencyP95Ms: null,
    effectiveSendCadenceMs: Number(effectiveSendCadenceMs.toFixed(3)),
    sendIntervalP95Ms: percentile(sendIntervalsMs, 95),
    maxInFlightFrames,
    maxInFlightBytes,
    maxQueueDepth,
    peakRetainedPcmBytes,
    memoryGrowthBytes: retainedPcmBytes,
    droppedFrames,
    duplicateFrames,
    reorderedFrames,
  };
}

describe('DaemonSpeechStreamSender', () => {
  it('sends multiple 20 ms chunks before the first application acknowledgement', async () => {
    const responses = [deferred<any>(), deferred<any>()];
    const chunk = vi.fn(({ seq }: DaemonSpeechStreamTransportChunkRequest) => responses[seq]!.promise);
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      maxBufferedChunks: 4,
      transport: {
        start: vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 1 })),
        chunk,
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    await sender.start();
    const first = sender.pushChunk(new Uint8Array(640));
    const second = sender.pushChunk(new Uint8Array(640));
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(2));

    responses[1]!.resolve({
      ok: true,
      streamId: 'stream-1',
      generation: 1,
      ackSeq: 1,
      events: [{ type: 'partial', seq: 1, text: 'hello', isEndpoint: false, confidence: null }],
    });
    responses[0]!.resolve({
      ok: true,
      streamId: 'stream-1',
      generation: 1,
      ackSeq: 0,
      events: [],
    });

    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toMatchObject([{ type: 'partial', seq: 1, text: 'hello' }]);
    await sender.waitForDrain();
  });

  it('bounds the in-flight frame and byte window and releases it with cumulative ACKs', async () => {
    const responses = [deferred<any>(), deferred<any>(), deferred<any>()];
    const chunk = vi.fn(({ seq }: DaemonSpeechStreamTransportChunkRequest) => responses[seq]!.promise);
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-window',
      maxBufferedChunks: 4,
      maxBufferedBytes: 2_560,
      maxInFlightChunks: 2,
      maxInFlightBytes: 1_280,
      transport: {
        start: vi.fn(async () => startResponse({ streamId: 'stream-window', generation: 1 })),
        chunk,
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });
    await sender.start();
    const chunks = [
      sender.pushChunk(new Uint8Array(640)),
      sender.pushChunk(new Uint8Array(640)),
      sender.pushChunk(new Uint8Array(640)),
    ];
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(2));
    expect(chunk.mock.calls.map(([input]) => input.seq)).toEqual([0, 1]);

    responses[1]!.resolve({ ok: true, streamId: 'stream-window', generation: 1, ackSeq: 1, events: [] });
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(3));
    responses[2]!.resolve({ ok: true, streamId: 'stream-window', generation: 1, ackSeq: 2, events: [] });
    responses[0]!.resolve({ ok: true, streamId: 'stream-window', generation: 1, ackSeq: 0, events: [] });
    await Promise.all(chunks);
    await sender.waitForDrain();
  });

  it('sustains ten minutes of 20 ms capture under deterministic transport impairment', async () => {
    const commonTemporaryDelay = {
      startsAtMs: 5 * 60_000,
      durationMs: 500,
      extraRttMs: 100,
    } as const;
    const profiles: readonly ImpairmentProfile[] = [
      { label: 'direct', rttMs: 0, jitterMs: 2, temporaryDelay: commonTemporaryDelay },
      { label: 'rtt_50', rttMs: 50, jitterMs: 6, temporaryDelay: commonTemporaryDelay },
      { label: 'rtt_100', rttMs: 100, jitterMs: 8, temporaryDelay: commonTemporaryDelay },
      { label: 'rtt_150', rttMs: 150, jitterMs: 10, temporaryDelay: commonTemporaryDelay },
    ];
    const measurements: ImpairmentMetrics[] = [];
    for (const profile of profiles) {
      measurements.push(await runTenMinuteImpairmentProfile(profile));
    }

    console.table(measurements);
    expect(measurements.map((measurement) => measurement.profile)).toEqual([
      'direct',
      'rtt_50',
      'rtt_100',
      'rtt_150',
    ]);
    for (const measurement of measurements) {
      expect(measurement.audioDurationMs).toBe(10 * 60_000);
      expect(measurement.frameCount).toBe(30_000);
      expect(measurement.effectiveSendCadenceMs).toBeLessThanOrEqual(20.01);
      expect(measurement.sendIntervalP95Ms).toBeLessThanOrEqual(20);
      expect(measurement.maxInFlightFrames).toBeLessThanOrEqual(8);
      expect(measurement.maxInFlightBytes).toBeLessThanOrEqual(8 * 640);
      expect(measurement.maxQueueDepth).toBeLessThanOrEqual(64);
      expect(measurement.peakRetainedPcmBytes).toBeLessThanOrEqual(64 * 640);
      expect(measurement.memoryGrowthBytes).toBe(0);
      expect(measurement.droppedFrames).toBe(0);
      expect(measurement.duplicateFrames).toBe(0);
      expect(measurement.reorderedFrames).toBe(0);
      expect(measurement.partialLatencyP50Ms).toBeNull();
      expect(measurement.partialLatencyP95Ms).toBeNull();
    }
    expect(measurements.find((measurement) => measurement.profile === 'rtt_150')?.maxInFlightFrames).toBeGreaterThan(1);
  }, 60_000);

  it('fails closed when a response acknowledges a frame that was never sent', async () => {
    const cancel = vi.fn(async () => ({ ok: true as const, streamId: 'stream-invalid-ack', generation: 1 }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-invalid-ack',
      transport: {
        start: vi.fn(async () => startResponse({ streamId: 'stream-invalid-ack', generation: 1 })),
        chunk: vi.fn(async () => ({
          ok: true as const,
          streamId: 'stream-invalid-ack',
          generation: 1,
          ackSeq: 9,
          events: [],
        })),
        finish: vi.fn(),
        cancel,
      },
    });
    await sender.start();
    await expect(sender.pushChunk(new Uint8Array([0, 0]))).rejects.toMatchObject({
      code: 'daemon_speech_stream_invalid_ack',
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await expect(sender.waitForDrain()).resolves.toBeUndefined();
  });

  it('starts live capture streams in runtime mode for compatibility transports', async () => {
    const start = vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 7 }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      diagnostics: { sessionId: 'private-session', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
      transport: {
        start,
        chunk: vi.fn(),
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    await sender.start();

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-1',
      streamingMode: 'runtime',
      diagnostics: { sessionId: 'private-session', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    }));
  });

  it('starts, sends chunks sequentially, drains acks, and finishes with the last sequence', async () => {
    const start = vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 7 }));
    const chunk = vi.fn(async ({ seq }: DaemonSpeechStreamTransportChunkRequest) => ({
      ok: true as const,
      streamId: 'stream-1',
      generation: 7,
      ackSeq: seq,
      events: [{ type: 'partial' as const, seq, text: `partial-${seq}`, isEndpoint: false, confidence: null }],
    }));
    const finish = vi.fn(async ({ finalSeq }: { finalSeq: number }) => ({
      ok: true as const,
      streamId: 'stream-1',
      generation: 7,
      ackSeq: finalSeq,
      finalText: 'done',
      language: null,
      modelPackId: null,
      events: [{ type: 'final' as const, seq: finalSeq, text: 'done', language: null, modelPackId: null }],
    }));
    const cancel = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 7 }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      transport: { start, chunk, finish, cancel },
    });

    await sender.start();
    await expect(sender.pushChunk(new Uint8Array([0, 0]))).resolves.toEqual([
      { type: 'partial', seq: 0, text: 'partial-0', isEndpoint: false, confidence: null },
    ]);
    await expect(sender.pushChunk(new Uint8Array([1, 1]))).resolves.toEqual([
      { type: 'partial', seq: 1, text: 'partial-1', isEndpoint: false, confidence: null },
    ]);
    await sender.waitForDrain();
    await expect(sender.finish()).resolves.toMatchObject({ finalText: 'done', ackSeq: 1 });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'request-1' }));
    expect(chunk.mock.calls.map(([input]) => input.seq)).toEqual([0, 1]);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'stream-1', generation: 7, finalSeq: 1 }));
    expect(cancel).not.toHaveBeenCalled();
  });

  it('buffers chunks before start and replays unacked chunks after restart', async () => {
    const streamIds = ['stream-1', 'stream-2'];
    const generations = [1, 2];
    const start = vi.fn(async () => startResponse({
      streamId: streamIds.shift()!,
      generation: generations.shift()!,
    }));
    const chunk = vi.fn(async ({ streamId, generation, seq }: DaemonSpeechStreamTransportChunkRequest) => ({
      ok: true as const,
      streamId,
      generation,
      ackSeq: streamId === 'stream-2' ? seq : seq === 0 ? 0 : -1,
      events: [],
    }));
    const finish = vi.fn();
    const cancel = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 1 }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      maxBufferedChunks: 4,
      transport: { start, chunk, finish, cancel },
    });

    const buffered = sender.pushChunk(new Uint8Array([0, 0]));
    await settleWithin(sender.start(), 'first_start');
    await settleWithin(buffered, 'first_buffered_chunk');
    const unacked = sender.pushChunk(new Uint8Array([1, 1]));
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(2));
    await settleWithin(sender.restart(), 'restart');
    await settleWithin(unacked, 'replayed_chunk');
    await settleWithin(sender.waitForDrain(), 'drain');

    expect(chunk.mock.calls.map(([input]) => [
      input.streamId,
      input.generation,
      input.seq,
      input.carrierFrame.kind,
      input.carrierFrame.kind === 'json_base64_v1_fallback'
        ? input.carrierFrame.jsonBase64Envelope.pcm16Base64
        : null,
    ])).toEqual([
      ['stream-1', 1, 0, 'json_base64_v1_fallback', 'AAA='],
      ['stream-1', 1, 1, 'json_base64_v1_fallback', 'AQE='],
      ['stream-2', 2, 1, 'json_base64_v1_fallback', 'AQE='],
    ]);
  });

  it('sends binary-capable direct voice PCM chunks as carrier bytes instead of base64 payloads', async () => {
    const chunk = vi.fn(async ({ seq }: DaemonSpeechStreamTransportChunkRequest) => ({
      ok: true as const,
      streamId: 'stream-1',
      generation: 7,
      ackSeq: seq,
      events: [],
    }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      carrierAdapter: createDaemonSpeechStreamCarrierAdapter({
        routeKind: 'loopback_direct',
        binaryCapable: true,
      }),
      transport: {
        start: vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 7 })),
        chunk,
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    const pcmBytes = new Uint8Array([7, 8, 9]);

    await sender.start();
    await sender.pushChunk(pcmBytes);

    const sent = chunk.mock.calls[0]?.[0];
    if (!sent || sent.carrierFrame.kind !== 'binary_tunnel_frame_v2') {
      throw new Error('expected binary carrier frame');
    }
    expect(sent.carrierFrame.profile.routeKind).toBe('loopback_direct');
    expect(sent.carrierFrame.payloadBytes).toBeInstanceOf(Uint8Array);
    expect([...sent.carrierFrame.payloadBytes]).toEqual([7, 8, 9]);
    expect('pcm16Base64' in sent.carrierFrame).toBe(false);
  });

  it('sends binary-capable relay voice PCM chunks through the same binary frame carrier', async () => {
    const chunk = vi.fn(async ({ seq }: DaemonSpeechStreamTransportChunkRequest) => ({
      ok: true as const,
      streamId: 'stream-1',
      generation: 7,
      ackSeq: seq,
      events: [],
    }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      carrierAdapter: createDaemonSpeechStreamCarrierAdapter({
        routeKind: 'server_relay',
        binaryCapable: true,
      }),
      transport: {
        start: vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 7 })),
        chunk,
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    await sender.start();
    await sender.pushChunk(new Uint8Array([10, 11]));

    const sent = chunk.mock.calls[0]?.[0];
    if (!sent || sent.carrierFrame.kind !== 'binary_tunnel_frame_v2') {
      throw new Error('expected binary carrier frame');
    }
    expect(sent.carrierFrame.profile.routeKind).toBe('server_relay');
    expect([...sent.carrierFrame.payloadBytes]).toEqual([10, 11]);
  });

  it('fails fast instead of buffering unbounded audio when the stream cannot drain', async () => {
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      maxBufferedChunks: 1,
      transport: {
        start: vi.fn(),
        chunk: vi.fn(),
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    const firstChunk = sender.pushChunk(new Uint8Array([0, 0])).catch((error) => error?.code ?? 'unknown_error');
    await expect(sender.pushChunk(new Uint8Array([1, 1]))).rejects.toMatchObject({
      code: 'daemon_speech_stream_backpressure',
    });
    await sender.cancel();
    await expect(firstChunk).resolves.toBe('daemon_speech_stream_closed');
  });

  it('rejects stale start completions after a newer restart wins ownership', async () => {
    const firstStart = deferred<any>();
    const secondStart = deferred<any>();
    const start = vi
      .fn()
      .mockReturnValueOnce(firstStart.promise)
      .mockReturnValueOnce(secondStart.promise);
    const chunk = vi.fn(async ({ streamId, generation, seq }: DaemonSpeechStreamTransportChunkRequest) => ({
      ok: true as const,
      streamId,
      generation,
      ackSeq: seq,
      events: [],
    }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      transport: {
        start,
        chunk,
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    const staleStart = sender.start();
    const winningStart = sender.restart();
    secondStart.resolve(startResponse({ streamId: 'stream-2', generation: 2 }));
    await winningStart;
    firstStart.resolve(startResponse({ streamId: 'stream-1', generation: 1 }));

    await expect(staleStart).rejects.toMatchObject({ code: 'daemon_speech_stream_stale_start' });
    await sender.pushChunk(new Uint8Array([0, 0]));
    expect(chunk).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'stream-2', generation: 2 }));
  });

  it('cancels the active stream and rejects later sends without leaking buffered chunks', async () => {
    const responses = Array.from({ length: 8 }, () => deferred<any>());
    const chunk = vi.fn(({ seq }: DaemonSpeechStreamTransportChunkRequest) => responses[seq]!.promise);
    const cancel = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 1 }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      transport: {
        start: vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 1 })),
        chunk,
        finish: vi.fn(),
        cancel,
      },
    });

    await sender.start();
    let settlementCallbacks = 0;
    const settlements = Array.from({ length: 10 }, (_, seq) => (
      sender.pushChunk(new Uint8Array([seq, 0])).then(
        () => {
          settlementCallbacks += 1;
          return 'resolved';
        },
        (error: unknown) => {
          settlementCallbacks += 1;
          return (error as { code?: unknown } | null)?.code ?? 'unknown_error';
        },
      )
    ));
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(8));
    await sender.cancel();

    expect(cancel).toHaveBeenCalledWith({ streamId: 'stream-1', generation: 1 });
    await expect(Promise.all(settlements)).resolves.toEqual(Array(10).fill('daemon_speech_stream_closed'));
    expect(settlementCallbacks).toBe(10);
    for (let seq = 0; seq < responses.length; seq += 1) {
      responses[seq]!.resolve({
        ok: true,
        streamId: 'stream-1',
        generation: 1,
        ackSeq: seq,
        events: [],
      });
    }
    await Promise.resolve();
    await expect(Promise.all(settlements)).resolves.toEqual(Array(10).fill('daemon_speech_stream_closed'));
    expect(settlementCallbacks).toBe(10);
    await expect(sender.waitForDrain()).resolves.toBeUndefined();
    await expect(sender.pushChunk(new Uint8Array([0, 0]))).rejects.toMatchObject({ code: 'daemon_speech_stream_closed' });
  });

  it('rejects finish when the outbound chunk drain hangs past the configured timeout', async () => {
    const chunkResult = deferred<any>();
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      finishTimeoutMs: 10,
      transport: {
        start: vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 1 })),
        chunk: vi.fn(() => chunkResult.promise),
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    await sender.start();
    const pendingChunk = sender.pushChunk(new Uint8Array([0, 0])).catch((error) => error?.code ?? 'unknown_error');

    const result = await Promise.race([
      sender.finish().then(
        () => 'finished',
        (error: any) => error?.code ?? 'unknown_error',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('test_timeout'), 50)),
    ]);

    expect(result).toBe('daemon_speech_stream_finish_timeout');
    await expect(pendingChunk).resolves.toBe('daemon_speech_stream_closed');
    await expect(Promise.race([
      sender.waitForDrain().then(() => 'drained'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still_pending'), 50)),
    ])).resolves.toBe('drained');
    chunkResult.resolve({
      ok: true,
      streamId: 'stream-1',
      generation: 1,
      ackSeq: 0,
      events: [],
    });
    await Promise.resolve();
    await Promise.resolve();
  });
});
