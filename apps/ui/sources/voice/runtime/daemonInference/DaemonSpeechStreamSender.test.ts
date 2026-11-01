import { describe, expect, it, vi } from 'vitest';

import {
  DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
  type DaemonVoiceInferenceSttStreamFinishResponse,
  type DaemonVoiceInferenceSttStreamStartResponse,
} from '@happier-dev/protocol/daemon/voiceInference';

import {
  createDaemonSpeechStreamSender,
  type DaemonSpeechStreamTransportChunkRequest,
} from './DaemonSpeechStreamSender';
import { createDaemonSpeechStreamCarrierAdapter } from './DaemonSpeechStreamCarrier';
import { createDeferred as deferred } from '@/dev/testkit';
import {
  DEFAULT_MAX_PENDING_APPLICATION_DISPATCHES,
  DEFAULT_MAX_PENDING_APPLICATION_DISPATCH_BYTES,
} from '@happier-dev/peer-transport/duplexFrames';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

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
  it.each([0, 640])('retains queued audio and rejects every %i-byte capture callback on cancellation', async chunkBytes => {
    const response = deferred<import('@happier-dev/protocol/daemon/voiceInference').DaemonVoiceInferenceSttStreamChunkResponse>();
    const chunk = vi.fn(() => response.promise);
    const sender = createDaemonSpeechStreamSender({ requestId: 'coalesced-cancel', maxInFlightChunks: 1,
      transport: { maxPcm16ChunkBytes: 1280,
        start: async () => startResponse({ streamId: 'stream', generation: 0 }), chunk,
        finish: vi.fn(), cancel: async () => ({ ok: true, streamId: 'stream', generation: 0 }),
      },
    });
    await sender.start();
    const settled = Promise.allSettled(Array.from({ length: 5 }, () => sender.pushChunk(new Uint8Array(chunkBytes))));
    try {
      await Promise.resolve();
      expect(chunk).toHaveBeenCalledTimes(1);
    } finally {
      await sender.cancel();
      response.resolve({ ok: true, streamId: 'stream', generation: 0, ackSeq: 0, events: [] });
    }
    expect(await settled).toEqual(Array.from({ length: 5 }, () => ({ status: 'rejected', reason: expect.objectContaining({ code: 'daemon_speech_stream_closed' }) })));
    await sender.waitForDrain();
  });

  it('coalesces waiting PCM within the carrier budget while slow acknowledgements keep the window full', async () => {
    vi.useFakeTimers();
    const received: Uint8Array[] = [];
    const events: number[] = [];
    const errors: unknown[] = [];
    const settlements: Promise<void>[] = [];
    const sender = createDaemonSpeechStreamSender({
      requestId: 'slow-relay',
      transport: {
        maxPcm16ChunkBytes: 64 * 1024,
        start: async () => startResponse({ streamId: 'stream', generation: 0 }),
        chunk: async ({ seq, carrierFrame }) => {
          if (carrierFrame.kind !== 'binary_tunnel_frame_v2') throw new Error('expected binary PCM');
          received.push(carrierFrame.payloadBytes);
          await new Promise(resolve => setTimeout(resolve, 2500));
          return { ok: true, streamId: 'stream', generation: 0, ackSeq: seq,
            events: [{ type: 'partial', seq, text: String(seq), isEndpoint: false, confidence: null }] };
        },
        finish: async ({ finalSeq }) => ({ ok: true, streamId: 'stream', generation: 0,
          ackSeq: finalSeq, finalText: 'all PCM', language: 'en', modelPackId: null, events: [] }),
        cancel: async () => ({ ok: true, streamId: 'stream', generation: 0 }),
      },
      carrierAdapter: createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: true }),
    });
    try {
      await sender.start();
      const expected: number[] = [];
      for (let frame = 0; frame < 425; frame++) {
        const pcm = new Uint8Array(640).fill(frame % 256);
        expected.push(...pcm);
        settlements.push(sender.pushChunk(pcm).then(reply => { events.push(...reply.map(event => event.seq)); }, error => { errors.push(error); }));
        await vi.advanceTimersByTimeAsync(20);
      }
      const finishing = sender.finish().then(result => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }));
      await vi.runAllTimersAsync();
      await Promise.all(settlements);
      expect(errors).toEqual([]);
      await expect(finishing).resolves.toMatchObject({ ok: true, result: { ok: true, finalText: 'all PCM' } });
      expect([...Buffer.concat(received)]).toEqual(expected);
      expect(received.every(pcm => pcm.byteLength <= 64 * 1024)).toBe(true);
      expect(received.some(pcm => pcm.byteLength > 640)).toBe(true);
      expect(events).toEqual(received.map((_, seq) => seq));
    } finally {
      await sender.cancel();
      vi.useRealTimers();
    }
  });

  it('sends multiple 20 ms chunks before the first application acknowledgement', async () => {
    const responses = [deferred<any>(), deferred<any>()];
    const bothChunksEntered = deferred<void>();
    const chunk = vi.fn(({ seq }: DaemonSpeechStreamTransportChunkRequest) => {
      if (seq === 1) bothChunksEntered.resolve();
      return responses[seq]!.promise;
    });
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
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
    await bothChunksEntered.promise;
    expect(chunk).toHaveBeenCalledTimes(2);

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

  it('delivers recognizer events in input order when a later reply wins the network race', async () => {
    const responses = [deferred<import('@happier-dev/protocol/daemon/voiceInference').DaemonVoiceInferenceSttStreamChunkResponse>(),
      deferred<import('@happier-dev/protocol/daemon/voiceInference').DaemonVoiceInferenceSttStreamChunkResponse>()];
    const sender = createDaemonSpeechStreamSender({
      requestId: 'ordered-events',
      transport: {
        start: async () => startResponse({ streamId: 'stream', generation: 1 }),
        chunk: ({ seq }) => responses[seq]!.promise,
        finish: vi.fn(), cancel: async () => ({ ok: true, streamId: 'stream', generation: 1 }),
      },
    });
    await sender.start();
    const observed: number[] = [];
    const first = sender.pushChunk(new Uint8Array(640)).then(() => { observed.push(0); });
    const second = sender.pushChunk(new Uint8Array(640)).then(() => { observed.push(1); });
    responses[1]!.resolve({ ok: true, streamId: 'stream', generation: 1, ackSeq: 1, events: [] });
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    expect(observed).toEqual([]);
    responses[0]!.resolve({ ok: true, streamId: 'stream', generation: 1, ackSeq: 0, events: [] });
    await Promise.all([first, second]);
    expect(observed).toEqual([0, 1]);
  });

  it('bounds the in-flight frame and byte window and releases it with cumulative ACKs', async () => {
    const responses = [deferred<any>(), deferred<any>(), deferred<any>()];
    const initialWindowEntered = deferred<void>();
    const thirdChunkEntered = deferred<void>();
    const chunk = vi.fn(({ seq }: DaemonSpeechStreamTransportChunkRequest) => {
      if (seq === 1) initialWindowEntered.resolve();
      if (seq === 2) thirdChunkEntered.resolve();
      return responses[seq]!.promise;
    });
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-window',
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
    await initialWindowEntered.promise;
    expect(chunk).toHaveBeenCalledTimes(2);
    expect(chunk.mock.calls.map(([input]) => input.seq)).toEqual([0, 1]);

    responses[1]!.resolve({ ok: true, streamId: 'stream-window', generation: 1, ackSeq: 1, events: [] });
    await thirdChunkEntered.promise;
    expect(chunk).toHaveBeenCalledTimes(3);
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
    const cancelEntered = deferred<void>();
    const cancel = vi.fn(async () => {
      cancelEntered.resolve();
      return { ok: true as const, streamId: 'stream-invalid-ack', generation: 1 };
    });
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
    await cancelEntered.promise;
    expect(cancel).toHaveBeenCalledOnce();
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

  it.each(['binary_tunnel', 'json_rpc_compat'] as const)('recovers ordered audio after an 18-second ACK stall on %s', async transportKind => {
    vi.useFakeTimers();
    const resumed = deferred<void>();
    const frameBytes = 640; // Canonical 16 kHz mono PCM16, 20 ms capture.
    // The live capture had this retained prefix before its first failure. The
    // 18-second probe is additional blocked ACK time, not a claim that 18 s of
    // fresh 16 kHz audio alone occupies two MiB.
    const retainedFrames = transportKind === 'binary_tunnel' ? 2_096_640 / frameBytes : 0;
    const frameCount = retainedFrames + 18_000 / 20;
    const expected = new Uint8Array(frameCount * frameBytes);
    const received: Uint8Array[] = [];
    const sequences: number[] = [];
    const eventSequences: number[] = [];
    const failures: unknown[] = [];
    const settlements: Promise<void>[] = [];
    let inFlightChunks = 0;
    let inFlightBytes = 0;
    let peakInFlightChunks = 0;
    let peakInFlightBytes = 0;
    const finish = vi.fn(async ({ finalSeq }: { finalSeq: number }) => ({
      ok: true as const, streamId: 'stall-stream', generation: 1, ackSeq: finalSeq,
      finalText: 'All captured audio recognized.', language: 'en', modelPackId: null, events: [],
    }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'captured-stall',
      transportKind,
      carrierAdapter: createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: transportKind === 'binary_tunnel' }),
      transport: {
        ...(transportKind === 'binary_tunnel' ? { maxPcm16ChunkBytes: 64 * 1024 } : {}),
        start: async () => startResponse({ streamId: 'stall-stream', generation: 1 }),
        chunk: async ({ seq, carrierFrame }) => {
          const pcm = carrierFrame.kind === 'binary_tunnel_frame_v2'
            ? carrierFrame.payloadBytes
            : new Uint8Array(Buffer.from(carrierFrame.jsonBase64Envelope.pcm16Base64, 'base64'));
          received.push(pcm);
          sequences.push(seq);
          inFlightChunks += 1;
          inFlightBytes += pcm.byteLength;
          peakInFlightChunks = Math.max(peakInFlightChunks, inFlightChunks);
          peakInFlightBytes = Math.max(peakInFlightBytes, inFlightBytes);
          await resumed.promise;
          inFlightChunks -= 1;
          inFlightBytes -= pcm.byteLength;
          return { ok: true, streamId: 'stall-stream', generation: 1, ackSeq: seq,
            events: [{ type: 'partial', seq, text: String(seq), isEndpoint: false, confidence: null }] };
        },
        finish,
        cancel: async () => ({ ok: true, streamId: 'stall-stream', generation: 1 }),
      },
    });
    let finishing: ReturnType<typeof sender.finish> | null = null;
    try {
      await sender.start();
      for (let frame = 0; frame < frameCount; frame += 1) {
        const pcm = new Uint8Array(frameBytes).fill(frame % 256);
        expected.set(pcm, frame * frameBytes);
        settlements.push(sender.pushChunk(pcm).then(
          events => { eventSequences.push(...events.map(event => event.seq)); },
          error => { failures.push(error); },
        ));
      }
      finishing = sender.finish();
      await vi.advanceTimersByTimeAsync(18_000);
      expect(failures).toEqual([]);
      expect(finish).not.toHaveBeenCalled();
      expect(received.length).toBeLessThanOrEqual(DEFAULT_MAX_PENDING_APPLICATION_DISPATCHES);
      resumed.resolve();
      await Promise.all(settlements);
      await expect(finishing).resolves.toMatchObject({ ok: true, finalText: 'All captured audio recognized.' });
      expect(failures).toEqual([]);
      expect(Buffer.concat(received).equals(Buffer.from(expected))).toBe(true);
      expect(sequences).toEqual(received.map((_, sequence) => sequence));
      expect(eventSequences).toEqual(sequences);
      expect(peakInFlightChunks).toBeLessThanOrEqual(DEFAULT_MAX_PENDING_APPLICATION_DISPATCHES);
      expect(peakInFlightBytes).toBeLessThanOrEqual(DEFAULT_MAX_PENDING_APPLICATION_DISPATCH_BYTES);
      if (transportKind === 'binary_tunnel') expect(received.every(pcm => pcm.byteLength <= 64 * 1024)).toBe(true);
    } finally {
      resumed.resolve();
      await sender.cancel();
      await Promise.allSettled(settlements);
      await finishing?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('cancels the active stream and rejects later sends without leaking buffered chunks', async () => {
    const responses = Array.from({ length: 8 }, () => deferred<any>());
    const windowEntered = deferred<void>();
    const chunk = vi.fn(({ seq }: DaemonSpeechStreamTransportChunkRequest) => {
      if (seq === 7) windowEntered.resolve();
      return responses[seq]!.promise;
    });
    const cancel = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 1 }));
    const finish = vi.fn();
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      transport: {
        start: vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 1 })),
        chunk,
        finish,
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
    await windowEntered.promise;
    expect(chunk).toHaveBeenCalledTimes(8);
    const finishing = sender.finish().then(() => 'finished', () => 'cancelled');
    await sender.cancel();

    expect(cancel).toHaveBeenCalledWith({ streamId: 'stream-1', generation: 1 });
    await expect(finishing).resolves.toBe('cancelled');
    expect(finish).not.toHaveBeenCalled();
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

  it('waits for successive valid ACK windows before starting the finish RPC', async () => {
    vi.useFakeTimers();
    const failures: unknown[] = [];
    const finish = vi.fn(async ({ finalSeq }: { finalSeq: number }) => ({
      ok: true as const, streamId: 'drain-stream', generation: 1, ackSeq: finalSeq,
      finalText: 'Complete.', language: 'en', modelPackId: null, events: [],
    }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'queued-drain',
      transport: {
        start: async () => startResponse({ streamId: 'drain-stream', generation: 1 }),
        chunk: async ({ seq }) => {
          // Each request is inside the real RPC deadline. Several credit
          // windows may nevertheless take longer than one RPC to drain.
          await new Promise<void>(resolve => setTimeout(resolve, DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS / 2));
          return { ok: true, streamId: 'drain-stream', generation: 1, ackSeq: seq, events: [] };
        },
        finish,
        cancel: async () => ({ ok: true, streamId: 'drain-stream', generation: 1 }),
      },
    });
    const chunks: Promise<unknown>[] = [];
    let finishing: Promise<unknown> | null = null;
    try {
      await sender.start();
      for (let seq = 0; seq < DEFAULT_MAX_PENDING_APPLICATION_DISPATCHES * 2 + 1; seq += 1) {
        chunks.push(sender.pushChunk(new Uint8Array([seq, 0])).catch(error => { failures.push(error); }));
      }
      finishing = sender.finish().catch(error => { failures.push(error); });
      await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
      expect(failures.map(error => (error as { code?: unknown }).code)).toEqual([]);
      expect(finish).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      await Promise.all(chunks);
      await expect(finishing).resolves.toMatchObject({ ok: true, finalText: 'Complete.' });
    } finally {
      await sender.cancel();
      await Promise.allSettled(chunks);
      await finishing;
      vi.useRealTimers();
    }
  });

  it('cancels when the admitted finish RPC exceeds its configured deadline', async () => {
    vi.useFakeTimers();
    const finishResponse = deferred<DaemonVoiceInferenceSttStreamFinishResponse>();
    const cancel = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 1 }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      finishTimeoutMs: 10,
      transport: {
        start: vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 1 })),
        chunk: async ({ seq }) => ({ ok: true, streamId: 'stream-1', generation: 1, ackSeq: seq, events: [] }),
        finish: () => finishResponse.promise,
        cancel,
      },
    });

    let finishing: Promise<unknown> | null = null;
    try {
      await sender.start();
      await sender.pushChunk(new Uint8Array([0, 0]));
      finishing = sender.finish().catch((error: unknown) => (error as { code?: unknown }).code);
      await vi.advanceTimersByTimeAsync(10);
      await expect(finishing).resolves.toBe('daemon_speech_stream_finish_timeout');
      expect(cancel).toHaveBeenCalledWith({ streamId: 'stream-1', generation: 1 });
      await expect(sender.waitForDrain()).resolves.toBeUndefined();
    } finally {
      await sender.cancel();
      finishResponse.resolve({
        ok: true, streamId: 'stream-1', generation: 1, ackSeq: 0,
        finalText: '', language: 'en', modelPackId: null, events: [],
      });
      await finishing;
      vi.useRealTimers();
    }
  });
});
