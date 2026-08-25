import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVoiceInferenceTtsSegmentManager } from './voiceInferenceTtsSegmentManager';

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('createVoiceInferenceTtsSegmentManager', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-tts-segments-'));
    tempDirs.push(dir);
    return dir;
  }

  it('emits the first ready segment before later text is synthesized and keeps prefetch bounded', async () => {
    const root = await createTempDir();
    const synths: Array<Deferred<Readonly<{ filePath: string }>> & Readonly<{ text: string; requestId: string }>> = [];
    let active = 0;
    let maxActive = 0;
    const synthesizeTts = vi.fn((input: any) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const d = deferred<Readonly<{ filePath: string }>>();
      synths.push(Object.assign(d, { text: input.text, requestId: input.requestId }));
      return d.promise.then(async (result) => {
        active -= 1;
        return {
          requestId: input.requestId,
          output: input.output,
          filePath: result.filePath,
          sizeBytes: (await readFile(result.filePath)).byteLength,
          name: `${input.requestId}.wav`,
        };
      });
    });
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: { synthesizeTts, cancelTts: vi.fn(async () => {}) },
      streamRoot: root,
      prefetchDepth: 2,
    });

    const started = await manager.start({
      requestId: 'tts-stream-1',
      text: 'First sentence. Second sentence. Third sentence.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(started).toMatchObject({ ok: true, segmentCount: 3 });
    if (!started.ok) throw new Error('start failed');
    expect(synths.map((synth) => synth.text)).toEqual(['First sentence.', 'Second sentence.']);

    const firstNext = manager.next({ streamId: started.streamId, generation: started.generation });
    const firstPath = join(root, 'first.wav');
    await writeFile(firstPath, Buffer.from('first-audio'));
    synths[0]?.resolve({ filePath: firstPath });

    await expect(firstNext).resolves.toMatchObject({
      ok: true,
      event: {
        type: 'segment',
        segmentIndex: 0,
        text: 'First sentence.',
        audio: { contentBase64: Buffer.from('first-audio').toString('base64'), sizeBytes: 11 },
        isLastSegment: false,
      },
    });
    await vi.waitFor(() => expect(synthesizeTts).toHaveBeenCalledTimes(3));
    expect(maxActive).toBeLessThanOrEqual(2);

    await expect(manager.ack({
      streamId: started.streamId,
      generation: started.generation,
      segmentId: `${started.streamId}:0`,
      segmentIndex: 0,
    })).resolves.toMatchObject({ ok: true, ackedSegmentIndex: 0, complete: false });
    expect(synths.map((synth) => synth.text)).toEqual([
      'First sentence.',
      'Second sentence.',
      'Third sentence.',
    ]);
  });

  it('cleans up active and ready segments on cancel and rejects stale completions', async () => {
    const root = await createTempDir();
    const pending = deferred<Readonly<{ filePath: string }>>();
    const cancelTts = vi.fn(async () => {});
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: {
        synthesizeTts: vi.fn((input: any) => pending.promise.then(async (result) => ({
          requestId: input.requestId,
          output: input.output,
          filePath: result.filePath,
          sizeBytes: 5,
          name: 'segment.wav',
        }))),
        cancelTts,
      },
      streamRoot: root,
      prefetchDepth: 1,
    });

    const started = await manager.start({
      requestId: 'tts-stream-cancel',
      text: 'Cancel me. Do not play me.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (!started.ok) throw new Error('start failed');
    await expect(manager.cancel({
      streamId: started.streamId,
      generation: started.generation,
      reason: 'barge_in',
    })).resolves.toMatchObject({ ok: true });

    expect(cancelTts).toHaveBeenCalledWith(expect.stringContaining('tts-stream-cancel'));
    const stalePath = join(root, 'stale.wav');
    await writeFile(stalePath, Buffer.from('stale'));
    pending.resolve({ filePath: stalePath });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(manager.next({ streamId: started.streamId, generation: started.generation })).resolves.toMatchObject({
      ok: false,
      errorCode: 'stream_not_found',
    });
  });

  it('times out delivered segments that are never playback-acked', async () => {
    vi.useFakeTimers();
    const root = await createTempDir();
    const audioPath = join(root, 'segment.wav');
    await writeFile(audioPath, Buffer.from('audio'));
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: {
        synthesizeTts: vi.fn(async (input: any) => ({
          requestId: input.requestId,
          output: input.output,
          filePath: audioPath,
          sizeBytes: 5,
          name: 'segment.wav',
        })),
        cancelTts: vi.fn(async () => {}),
      },
      streamRoot: root,
      prefetchDepth: 1,
      ackTimeoutMs: 100,
    });

    const started = await manager.start({
      requestId: 'tts-stream-timeout',
      text: 'Timeout segment.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (!started.ok) throw new Error('start failed');
    await expect(manager.next({ streamId: started.streamId, generation: started.generation })).resolves.toMatchObject({
      ok: true,
      event: { type: 'segment', segmentIndex: 0 },
    });

    await vi.advanceTimersByTimeAsync(150);
    await expect(manager.status({ streamId: started.streamId, generation: started.generation })).resolves.toMatchObject({
      ok: false,
      errorCode: 'stream_not_found',
    });
  });

  it('retires a stream whose client never asks for its prefetched segments', async () => {
    vi.useFakeTimers();
    const root = await createTempDir();
    const audioPath = join(root, 'segment.wav');
    await writeFile(audioPath, Buffer.from('audio'));
    const pending = deferred<void>();
    const cancelTts = vi.fn(async () => {});
    let synthesizedCount = 0;
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: {
        synthesizeTts: vi.fn(async (input: any) => {
          synthesizedCount += 1;
          // The second prefetched segment never finishes: an abandoned start must
          // cancel it instead of leaving the worker running for the daemon lifetime.
          if (synthesizedCount > 1) await pending.promise;
          return {
            requestId: input.requestId,
            output: input.output,
            filePath: audioPath,
            sizeBytes: 5,
            name: 'segment.wav',
          };
        }),
        cancelTts,
      },
      streamRoot: root,
      prefetchDepth: 2,
      ackTimeoutMs: 100,
    });

    const started = await manager.start({
      requestId: 'tts-stream-abandoned',
      text: 'First sentence. Second sentence. Third sentence.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (!started.ok) throw new Error('start failed');

    // The client disappears immediately after start: it never calls next, so no
    // per-segment ack deadline is ever created.
    await vi.advanceTimersByTimeAsync(150);

    await expect(manager.status({ streamId: started.streamId, generation: started.generation })).resolves.toMatchObject({
      ok: false,
      errorCode: 'stream_not_found',
    });
    expect(cancelTts).toHaveBeenCalledWith(expect.stringContaining('tts-stream-abandoned'));
    pending.resolve();
  });

  it('keeps a client-driven stream alive well past the abandonment deadline', async () => {
    vi.useFakeTimers();
    const root = await createTempDir();
    const cancelTts = vi.fn(async () => {});
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: {
        // The manager consumes and deletes each synthesized file, so every
        // segment needs its own.
        synthesizeTts: vi.fn(async (input: any) => {
          const filePath = join(root, `${input.requestId}.wav`);
          await writeFile(filePath, Buffer.from('audio'));
          return {
            requestId: input.requestId,
            output: input.output,
            filePath,
            sizeBytes: 5,
            name: 'segment.wav',
          };
        }),
        cancelTts,
      },
      streamRoot: root,
      prefetchDepth: 1,
      ackTimeoutMs: 100,
    });

    const started = await manager.start({
      requestId: 'tts-stream-long-playback',
      text: 'First sentence. Second sentence. Third sentence.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (!started.ok) throw new Error('start failed');

    // Reading a long reply aloud outlasts the abandonment deadline several times
    // over. Every next and every ack is the client proving it is still driving
    // the stream, so the deadline must move forward instead of retiring audio the
    // user is still listening to. Each hop is shorter than the deadline; the
    // total elapsed time is more than three times it.
    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(60);
      await expect(manager.next({
        streamId: started.streamId,
        generation: started.generation,
      })).resolves.toMatchObject({ ok: true, event: { type: 'segment', segmentIndex: index } });
      await vi.advanceTimersByTimeAsync(60);
      await expect(manager.ack({
        streamId: started.streamId,
        generation: started.generation,
        segmentId: `${started.streamId}:${index}`,
        segmentIndex: index,
      })).resolves.toMatchObject({ ok: true, ackedSegmentIndex: index, complete: index === 2 });
    }
    expect(cancelTts).not.toHaveBeenCalled();
  });

  it('rejects an acknowledgement before the matching segment is delivered', async () => {
    const root = await createTempDir();
    const audioPath = join(root, 'segment.wav');
    await writeFile(audioPath, Buffer.from('audio'));
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: {
        synthesizeTts: vi.fn(async (input: any) => ({
          requestId: input.requestId,
          output: input.output,
          filePath: audioPath,
          sizeBytes: 5,
          name: 'segment.wav',
        })),
        cancelTts: vi.fn(async () => {}),
      },
      streamRoot: root,
      prefetchDepth: 1,
    });

    const started = await manager.start({
      requestId: 'tts-stream-ack-before-delivery',
      text: 'Deliver before acknowledging.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (!started.ok) throw new Error('start failed');

    await expect(manager.ack({
      streamId: started.streamId,
      generation: started.generation,
      segmentId: `${started.streamId}:0`,
      segmentIndex: 0,
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });

    await expect(manager.next({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({
      ok: true,
      event: { type: 'segment', segmentIndex: 0 },
    });
  });

  it('does not emit done before the delivered segment is playback-acked', async () => {
    const root = await createTempDir();
    const audioPath = join(root, 'segment.wav');
    await writeFile(audioPath, Buffer.from('audio'));
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: {
        synthesizeTts: vi.fn(async (input: any) => ({
          requestId: input.requestId,
          output: input.output,
          filePath: audioPath,
          sizeBytes: 5,
          name: 'segment.wav',
        })),
        cancelTts: vi.fn(async () => {}),
      },
      streamRoot: root,
      prefetchDepth: 1,
    });

    const started = await manager.start({
      requestId: 'tts-stream-ack-before-done',
      text: 'Ack before done.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (!started.ok) throw new Error('start failed');
    const first = await manager.next({ streamId: started.streamId, generation: started.generation });
    expect(first).toMatchObject({ ok: true, event: { type: 'segment', segmentIndex: 0 } });

    const secondNext = manager.next({ streamId: started.streamId, generation: started.generation });
    await expect(Promise.race([
      secondNext.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])).resolves.toBe('pending');

    await expect(manager.ack({
      streamId: started.streamId,
      generation: started.generation,
      segmentId: `${started.streamId}:0`,
      segmentIndex: 0,
    })).resolves.toMatchObject({ ok: true, complete: true });
    await expect(secondNext).resolves.toMatchObject({
      ok: false,
      errorCode: 'stream_not_found',
    });
  });

  it('uses the canonical public normalizer for runtime-family synthesis failures', async () => {
    const root = await createTempDir();
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: {
        synthesizeTts: vi.fn(async () => {
          throw Object.assign(new Error('private runtime detail'), { code: 'unsupported_runtime_family' });
        }),
        cancelTts: vi.fn(async () => {}),
      },
      streamRoot: root,
      prefetchDepth: 1,
    });

    const started = await manager.start({
      requestId: 'tts-stream-runtime-family',
      text: 'Unsupported family.',
      packId: 'unsupported-pack',
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (!started.ok) throw new Error('start failed');

    await expect(manager.next({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({
      ok: true,
      event: {
        type: 'error',
        errorCode: 'unsupported_runtime_family',
        error: 'voice_inference_unsupported_runtime_family',
      },
    });
  });
});
