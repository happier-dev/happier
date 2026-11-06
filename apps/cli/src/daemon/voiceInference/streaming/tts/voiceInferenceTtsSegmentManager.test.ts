import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonVoiceInferenceTtsStreamNextResponseSchema, ModelPackManifestSchema } from '@happier-dev/protocol';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resolveVoiceInferencePaths } from '../../voiceInferencePaths';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from '../../voiceInferenceWorker';
import type { VoiceInferenceRuntime } from '../../voiceInferenceRuntimeTypes';

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
  const managers: ReturnType<typeof createVoiceInferenceTtsSegmentManager>[] = [];
  let worker: VoiceInferenceWorkerHandle;
  let nativeRuntime: VoiceInferenceRuntime;
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

  beforeEach(async () => {
    process.env.HAPPIER_HOME_DIR = await createTempDir();
    reloadConfiguration();
    const bytes = Buffer.from('native synthesis model boundary fixture');
    for (const packId of ['kokoro-82m-v1.0-onnx-q8-wasm']) {
      const packDir = join(resolveVoiceInferencePaths().packsRootDir, packId);
      await mkdir(packDir, { recursive: true });
      const manifest = ModelPackManifestSchema.parse({
        packId, kind: 'tts_sherpa', model: 'kokoro', version: 'fixture-v1',
        files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx',
          sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength }],
      });
      await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest));
      await writeFile(join(packDir, 'model.onnx'), bytes);
    }
    nativeRuntime = {
      synthesizeTts: async (input) => ({ bytes: Buffer.from('audio'), output: input.output, name: 'segment.wav' }),
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
    };
    // The native inference API is the boundary; admission, concurrency,
    // cancellation and staged output files belong to the actual worker.
    worker = await startVoiceInferenceWorker({ runtimeLoader: async () => nativeRuntime, perModelConcurrency: 2 });
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
    await worker.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    reloadConfiguration();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-tts-segments-'));
    tempDirs.push(dir);
    return dir;
  }

  it('emits the first ready segment before later text is synthesized and keeps prefetch bounded', async () => {
    const root = await createTempDir();
    const synths: Array<Deferred<Uint8Array> & Readonly<{ text: string; requestId: string }>> = [];
    let active = 0;
    let maxActive = 0;
    const synthesizeTts = vi.fn<VoiceInferenceRuntime['synthesizeTts']>((input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const d = deferred<Uint8Array>();
      input.signal?.addEventListener('abort', () => d.reject(Object.assign(new Error('native synthesis cancelled'), { code: 'cancelled' })), { once: true });
      synths.push(Object.assign(d, { text: input.text, requestId: input.requestId }));
      return d.promise.then(async (result) => {
        active -= 1;
        return {
          output: input.output,
          bytes: result,
          name: `${input.requestId}.wav`,
        };
      });
    });
    nativeRuntime = { ...nativeRuntime, synthesizeTts };
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: worker,
      streamRoot: root,
      prefetchDepth: 2,
    });
    managers.push(manager);

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
    // Parallel worker admission reads the model before reaching the native boundary,
    // so native arrival order does not identify a segment's text position.
    await vi.waitFor(() => expect(synths.map((synth) => synth.text).sort()).toEqual(['First sentence.', 'Second sentence.']));
    const firstSynthesis = synths.find((synth) => synth.text === 'First sentence.')!;

    const firstNext = manager.next({ streamId: started.streamId, generation: started.generation });
    firstSynthesis.resolve(Buffer.from('first-audio'));

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
    DaemonVoiceInferenceTtsStreamNextResponseSchema.parse(await firstNext);
    await vi.waitFor(() => expect(synthesizeTts).toHaveBeenCalledTimes(3));
    expect(maxActive).toBeLessThanOrEqual(2);

    await expect(manager.ack({
      streamId: started.streamId,
      generation: started.generation,
      segmentId: `${started.streamId}:0`,
      segmentIndex: 0,
    })).resolves.toMatchObject({ ok: true, ackedSegmentIndex: 0, complete: false });
    expect(synths.map((synth) => synth.text).sort()).toEqual([
      'First sentence.',
      'Second sentence.',
      'Third sentence.',
    ]);
  });

  it('cleans up active and ready segments on cancel and rejects stale completions', async () => {
    const root = await createTempDir();
    const pending = deferred<Uint8Array>();
    const cancelTts = vi.spyOn(worker, 'cancelTts');
    const workerSynthesize = vi.spyOn(worker, 'synthesizeTts');
    const nativeSynthesize = vi.fn<VoiceInferenceRuntime['synthesizeTts']>((input) => pending.promise.then((bytes) => ({
      output: input.output, bytes, name: 'segment.wav',
    })));
    nativeRuntime = { ...nativeRuntime, synthesizeTts: nativeSynthesize };
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: worker,
      streamRoot: root,
      prefetchDepth: 1,
    });
    managers.push(manager);

    const started = await manager.start({
      requestId: 'tts-stream-cancel',
      text: 'Cancel me. Do not play me.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (!started.ok) throw new Error('start failed');
    // Let the genuine native call start before exercising a late SDK completion.
    await vi.waitFor(() => expect(nativeSynthesize).toHaveBeenCalledOnce());
    const waiting = manager.next({ streamId: started.streamId, generation: started.generation });
    await expect(manager.cancel({
      streamId: started.streamId,
      generation: started.generation,
      reason: 'barge_in',
    })).resolves.toMatchObject({ ok: true });

    await expect(waiting).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(cancelTts).toHaveBeenCalledWith(expect.stringContaining('tts-stream-cancel'));
    pending.resolve(Buffer.from('stale'));
    await expect(workerSynthesize.mock.results[0]?.value).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(async () => expect(await readdir(resolveVoiceInferencePaths().tempDir)).toEqual([]));
    await expect(manager.next({ streamId: started.streamId, generation: started.generation })).resolves.toMatchObject({
      ok: false,
      errorCode: 'stream_not_found',
    });
  });

  it('times out delivered segments that are never playback-acked', async () => {
    vi.useFakeTimers();
    const root = await createTempDir();
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: worker,
      streamRoot: root,
      prefetchDepth: 1,
      ackTimeoutMs: 100,
    });
    managers.push(manager);

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
    await expect(manager.cancel({ streamId: started.streamId, generation: started.generation, reason: 'client_abort' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'stream_not_found',
    });
  });

  it('retires a stream whose client never asks for its prefetched segments', async () => {
    vi.useFakeTimers();
    const root = await createTempDir();
    const pending = deferred<void>();
    const cancelTts = vi.spyOn(worker, 'cancelTts');
    let synthesizedCount = 0;
    nativeRuntime = { ...nativeRuntime, synthesizeTts: async (input) => {
      synthesizedCount += 1;
      // The second native request remains active until cancellation/late completion.
      if (synthesizedCount > 1) await pending.promise;
      return { output: input.output, bytes: Buffer.from('audio'), name: 'segment.wav' };
    } };
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: worker,
      streamRoot: root,
      prefetchDepth: 2,
      ackTimeoutMs: 100,
    });
    managers.push(manager);

    const started = await manager.start({
      requestId: 'tts-stream-abandoned',
      text: 'First sentence. Second sentence. Third sentence.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (!started.ok) throw new Error('start failed');
    await vi.waitFor(() => expect(synthesizedCount).toBe(2));

    // The client disappears immediately after start: it never calls next, so no
    // per-segment ack deadline is ever created.
    await vi.advanceTimersByTimeAsync(150);

    await expect(manager.cancel({ streamId: started.streamId, generation: started.generation, reason: 'client_abort' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'stream_not_found',
    });
    expect(cancelTts).toHaveBeenCalledWith(expect.stringContaining('tts-stream-abandoned'));
    pending.resolve();
  });

  it('keeps pending client demand alive through native synthesis beyond the abandonment deadline', async () => {
    const root = await createTempDir();
    const pending = deferred<Uint8Array>();
    const cancelTts = vi.spyOn(worker, 'cancelTts');
    const nativeSynthesize = vi.fn<VoiceInferenceRuntime['synthesizeTts']>((input) => pending.promise.then(bytes => ({
      output: input.output, bytes, name: 'segment.wav',
    })));
    nativeRuntime = { ...nativeRuntime, synthesizeTts: nativeSynthesize };
    vi.useFakeTimers();
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: worker, streamRoot: root, prefetchDepth: 1, ackTimeoutMs: 100,
    });
    managers.push(manager);
    const started = await manager.start({
      requestId: 'tts-stream-waiting', text: 'A slow native reply.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: null, speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (!started.ok) throw new Error('start failed');
    const waiting = manager.next({ streamId: started.streamId, generation: started.generation });
    await vi.waitFor(() => expect(nativeSynthesize).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(300);
    pending.resolve(Buffer.from('slow-audio'));
    await expect(waiting).resolves.toMatchObject({ ok: true, event: { type: 'segment', segmentIndex: 0 } });
    expect(cancelTts).not.toHaveBeenCalled();
    await expect(manager.ack({
      streamId: started.streamId, generation: started.generation,
      segmentId: `${started.streamId}:0`, segmentIndex: 0,
    })).resolves.toMatchObject({ ok: true, complete: true });
  });

  it('keeps a client-driven stream alive well past the abandonment deadline', async () => {
    vi.useFakeTimers();
    const root = await createTempDir();
    const cancelTts = vi.spyOn(worker, 'cancelTts');
    const manager = createVoiceInferenceTtsSegmentManager({
      // The real worker stages a distinct file for every native result.
      voiceInferenceWorker: worker,
      streamRoot: root,
      prefetchDepth: 1,
      ackTimeoutMs: 100,
    });
    managers.push(manager);

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
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: worker,
      streamRoot: root,
      prefetchDepth: 1,
    });
    managers.push(manager);

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
    const manager = createVoiceInferenceTtsSegmentManager({
      voiceInferenceWorker: worker,
      streamRoot: root,
      prefetchDepth: 1,
    });
    managers.push(manager);

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
      voiceInferenceWorker: worker,
      streamRoot: root,
      prefetchDepth: 1,
    });
    managers.push(manager);

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
