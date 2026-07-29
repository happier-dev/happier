import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VoiceInferenceWorkerStreamingTranscriptionSession } from '../voiceInferenceWorker.execution';
import { createVoiceInferenceSpeechStreamManager } from './voiceInferenceSpeechStreamManager';

const tempDirs: string[] = [];

type LoadedVoiceFixture = Readonly<{
  metadata: Readonly<{
    sourceText: string | null;
    language: string | null;
    expectedTranscriptSubstrings: readonly string[];
  }>;
  pcm16Bytes: Uint8Array;
}>;

type VoiceFixtureTestkit = Readonly<{
  readVoiceFixturePcm16: (id: string) => Promise<LoadedVoiceFixture>;
  matchesVoiceFixtureTranscript: (
    metadata: Pick<LoadedVoiceFixture['metadata'], 'expectedTranscriptSubstrings'>,
    transcript: string,
  ) => boolean;
}>;

let voiceFixtureTestkitPromise: Promise<VoiceFixtureTestkit> | null = null;

async function loadVoiceFixtureTestkit(): Promise<VoiceFixtureTestkit> {
  voiceFixtureTestkitPromise ??= (async () => {
    // Keep the canonical fixture reader in packages/tests without pulling its
    // TypeScript source into the CLI production rootDir during package builds.
    const modulePath = '../../../../../../packages/tests/src/testkit/voice/voiceFixture.ts';
    const candidate: unknown = await import(/* @vite-ignore */ modulePath);
    if (!candidate || typeof candidate !== 'object') throw new Error('voice_fixture_testkit_unavailable');
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.readVoiceFixturePcm16 !== 'function'
      || typeof record.matchesVoiceFixtureTranscript !== 'function'
    ) {
      throw new Error('voice_fixture_testkit_unavailable');
    }
    return {
      readVoiceFixturePcm16: record.readVoiceFixturePcm16 as VoiceFixtureTestkit['readVoiceFixturePcm16'],
      matchesVoiceFixtureTranscript: record.matchesVoiceFixtureTranscript as VoiceFixtureTestkit['matchesVoiceFixtureTranscript'],
    };
  })();
  return await voiceFixtureTestkitPromise;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStreamRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-voice-fixture-consumer-'));
  tempDirs.push(dir);
  return dir;
}

function chunkPcm16(bytes: Uint8Array, chunkBytes = 16_384): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength)));
  }
  return chunks;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('voice inference stream canonical fixture consumer', () => {
  it('rejects and cleans a runtime session created after manager disposal starts', async () => {
    const runtimeSession = deferred<VoiceInferenceWorkerStreamingTranscriptionSession>();
    const resourceState: string[] = [];
    const manager = createVoiceInferenceSpeechStreamManager({
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('batch_path_must_not_run'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession: vi.fn(async () => await runtimeSession.promise),
      },
    });

    const starting = manager.start({
      requestId: 'fixture-dispose-during-start',
      packId: 'fixture-streaming-model',
      language: null,
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    await Promise.resolve();
    const disposing = manager.dispose();
    runtimeSession.resolve({
      modelPackId: 'fixture-streaming-model',
      appendPcm16: async () => ({ events: [] }),
      finish: async () => ({ text: '', language: null, events: [] }),
      cancel: async () => { resourceState.push('cancelled'); },
      close: async () => { resourceState.push('closed'); },
    });

    await expect(starting).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    await expect(disposing).resolves.toBeUndefined();
    expect(resourceState).toEqual(['cancelled', 'closed']);
  });

  it('streams every PCM chunk in order before one final result and preserves the selected model contract', async () => {
    const { matchesVoiceFixtureTranscript, readVoiceFixturePcm16 } = await loadVoiceFixtureTestkit();
    const fixture = await readVoiceFixturePcm16('long-utterance-16k');
    const chunks = chunkPcm16(fixture.pcm16Bytes);
    const observedChunks: Uint8Array[] = [];
    const observedSequences: number[] = [];
    const finish = vi.fn(async ({ finalSeq }: Readonly<{ finalSeq: number }>) => ({
      text: fixture.metadata.sourceText ?? '',
      language: fixture.metadata.language,
      events: [{
        type: 'final' as const,
        seq: finalSeq,
        text: fixture.metadata.sourceText ?? '',
        language: fixture.metadata.language,
        modelPackId: 'fixture-streaming-model',
      }],
    }));
    const createStreamingTranscriptionSession = vi.fn(async () => ({
      modelPackId: 'fixture-streaming-model',
      appendPcm16: async ({ seq, pcm16Bytes }: Readonly<{ seq: number; pcm16Bytes: Uint8Array }>) => {
        observedSequences.push(seq);
        observedChunks.push(new Uint8Array(pcm16Bytes));
        return {
          events: [{
            type: 'partial' as const,
            seq,
            text: `fixture-chunk-${seq}`,
            isEndpoint: false,
            confidence: null,
          }],
        };
      },
      finish,
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }));
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('batch_path_must_not_run'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession,
      },
    });

    const started = await manager.start({
      requestId: 'fixture-stream-order',
      packId: 'fixture-streaming-model',
      language: fixture.metadata.language,
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    if (!started.ok) throw new Error(`stream start failed: ${started.errorCode}`);

    const eventSequences: number[] = [];
    for (const [seq, pcm16Bytes] of chunks.entries()) {
      const response = await manager.appendPcm16Bytes({
        streamId: started.streamId,
        generation: started.generation,
        seq,
        pcm16Bytes,
      });
      if (!response.ok) throw new Error(`stream chunk failed: ${response.errorCode}`);
      eventSequences.push(...response.events.map((event) => event.seq));
    }
    const completed = await manager.finish({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: chunks.length - 1,
    });

    expect(observedSequences).toEqual(chunks.map((_chunk, seq) => seq));
    expect(eventSequences).toEqual(observedSequences);
    expect(Buffer.concat(observedChunks.map((chunk) => Buffer.from(chunk))).equals(Buffer.from(fixture.pcm16Bytes))).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ finalSeq: chunks.length - 1 }));
    expect(completed).toMatchObject({
      ok: true,
      ackSeq: chunks.length - 1,
      modelPackId: 'fixture-streaming-model',
    });
    if (!completed.ok) throw new Error(`stream finish failed: ${completed.errorCode}`);
    expect(matchesVoiceFixtureTranscript(fixture.metadata, completed.finalText)).toBe(true);
    expect(completed.events).toEqual([{
      type: 'final',
      seq: chunks.length - 1,
      text: fixture.metadata.sourceText,
      language: fixture.metadata.language,
      modelPackId: 'fixture-streaming-model',
    }]);
    expect(createStreamingTranscriptionSession).toHaveBeenCalledWith(expect.objectContaining({
      packId: 'fixture-streaming-model',
      language: fixture.metadata.language,
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    }));
  });

  it('makes cancellation terminal while a long fixture chunk is still in flight', async () => {
    const { readVoiceFixturePcm16 } = await loadVoiceFixtureTestkit();
    const fixture = await readVoiceFixturePcm16('long-utterance-16k');
    const chunks = chunkPcm16(fixture.pcm16Bytes);
    const pendingAppend = deferred<Readonly<{ events: readonly [] }>>();
    const finish = vi.fn(async () => ({ text: 'late final', language: 'en-US', events: [] }));
    const cancel = vi.fn(async () => {});
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('batch_path_must_not_run'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession: vi.fn(async () => ({
          modelPackId: 'fixture-streaming-model',
          appendPcm16: vi.fn(async () => await pendingAppend.promise),
          finish,
          cancel,
          close: vi.fn(async () => {}),
        })),
      },
    });
    const started = await manager.start({
      requestId: 'fixture-stream-cancel',
      packId: 'fixture-streaming-model',
      language: fixture.metadata.language,
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    if (!started.ok) throw new Error(`stream start failed: ${started.errorCode}`);

    const append = manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: chunks[0]!,
    });
    const cancellation = manager.cancel({
      streamId: started.streamId,
      generation: started.generation,
    });
    pendingAppend.resolve({ events: [] });

    await expect(append).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(cancellation).resolves.toMatchObject({ ok: true });
    await expect(manager.finish({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
  });

  it('settles an abort-rejecting append and tears its runtime resources down exactly once', async () => {
    const { readVoiceFixturePcm16 } = await loadVoiceFixtureTestkit();
    const fixture = await readVoiceFixturePcm16('long-utterance-16k');
    const runtimeCancel = vi.fn(async () => {});
    const runtimeClose = vi.fn(async () => {});
    const cancelStt = vi.fn(async () => {});
    const appendStarted = deferred<void>();
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('batch_path_must_not_run'); }),
        cancelStt,
        createStreamingTranscriptionSession: vi.fn(async () => ({
          modelPackId: 'fixture-streaming-model',
          appendPcm16: vi.fn(async ({ signal }) => {
            appendStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener('abort', () => {
                reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
              }, { once: true });
            });
            return { events: [] };
          }),
          finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
          cancel: runtimeCancel,
          close: runtimeClose,
        })),
      },
    });
    const started = await manager.start({
      requestId: 'fixture-stream-abort-rejection',
      packId: 'fixture-streaming-model',
      language: fixture.metadata.language,
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    if (!started.ok) throw new Error(`stream start failed: ${started.errorCode}`);

    const append = manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: fixture.pcm16Bytes.subarray(0, 16_384),
    });
    await appendStarted.promise;
    const cancellation = manager.cancel({
      streamId: started.streamId,
      generation: started.generation,
    });

    await expect(append).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    await expect(cancellation).resolves.toMatchObject({ ok: true });
    expect(runtimeCancel).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('propagates cancellation through the worker-session signal before waiting for an in-flight append', async () => {
    const { readVoiceFixturePcm16 } = await loadVoiceFixtureTestkit();
    const fixture = await readVoiceFixturePcm16('long-utterance-16k');
    const runtimeCancel = vi.fn(async () => {});
    const runtimeClose = vi.fn(async () => {});
    const cancelStt = vi.fn(async () => {});
    const appendStarted = deferred<void>();
    let workerSessionSignal: AbortSignal | null = null;
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('batch_path_must_not_run'); }),
        cancelStt,
        createStreamingTranscriptionSession: vi.fn(async ({ signal }) => {
          workerSessionSignal = signal ?? null;
          return {
            modelPackId: 'fixture-streaming-model',
            appendPcm16: vi.fn(async () => {
              appendStarted.resolve();
              await new Promise<void>((_resolve, reject) => {
                workerSessionSignal?.addEventListener('abort', () => {
                  reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
                }, { once: true });
              });
              return { events: [] };
            }),
            finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
            cancel: runtimeCancel,
            close: runtimeClose,
          };
        }),
      },
    });
    const started = await manager.start({
      requestId: 'fixture-stream-worker-session-signal',
      packId: 'fixture-streaming-model',
      language: fixture.metadata.language,
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    if (!started.ok) throw new Error(`stream start failed: ${started.errorCode}`);
    if (!workerSessionSignal) await manager.dispose();
    expect(workerSessionSignal).toBeInstanceOf(AbortSignal);

    const append = manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: fixture.pcm16Bytes.subarray(0, 16_384),
    });
    await appendStarted.promise;
    const cancellation = manager.cancel({
      streamId: started.streamId,
      generation: started.generation,
    });

    await expect(append).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    await expect(cancellation).resolves.toMatchObject({ ok: true });
    expect(runtimeCancel).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('does not publish a late successful final result after cancellation closes the stream', async () => {
    const { readVoiceFixturePcm16 } = await loadVoiceFixtureTestkit();
    const fixture = await readVoiceFixturePcm16('long-utterance-16k');
    const lateFinish = deferred<Readonly<{ text: string; language: string; events: readonly [] }>>();
    const finishStarted = deferred<void>();
    const runtimeCancel = vi.fn(async () => {});
    const runtimeClose = vi.fn(async () => {});
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('batch_path_must_not_run'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession: vi.fn(async () => ({
          modelPackId: 'fixture-streaming-model',
          appendPcm16: vi.fn(async () => ({ events: [] })),
          finish: vi.fn(async () => {
            finishStarted.resolve();
            return await lateFinish.promise;
          }),
          cancel: runtimeCancel,
          close: runtimeClose,
        })),
      },
    });
    const started = await manager.start({
      requestId: 'fixture-stream-late-finish',
      packId: 'fixture-streaming-model',
      language: fixture.metadata.language,
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    if (!started.ok) throw new Error(`stream start failed: ${started.errorCode}`);
    await manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: fixture.pcm16Bytes.subarray(0, 16_384),
    });

    const finish = manager.finish({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    });
    await finishStarted.promise;
    await expect(manager.cancel({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: true });
    lateFinish.resolve({ text: 'late success', language: 'en-US', events: [] });

    await expect(finish).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    expect(runtimeCancel).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
  });
});
