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

describe('DaemonSpeechStreamSender', () => {
  it('starts live capture streams in runtime mode for compatibility transports', async () => {
    const start = vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 7 }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
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
      ackSeq: seq === 0 ? 0 : -1,
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
    await sender.start();
    await buffered;
    await sender.pushChunk(new Uint8Array([1, 1]));
    await sender.restart();
    await sender.waitForDrain();

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
    const cancel = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 1 }));
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-1',
      transport: {
        start: vi.fn(async () => startResponse({ streamId: 'stream-1', generation: 1 })),
        chunk: vi.fn(),
        finish: vi.fn(),
        cancel,
      },
    });

    await sender.start();
    await sender.cancel();

    expect(cancel).toHaveBeenCalledWith({ streamId: 'stream-1', generation: 1 });
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
