import type { ModelPackManifest } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import { createForkedVoiceInferenceRuntimeHandle } from './forkedRuntimeLoader';
import type { VoiceInferenceWorkerChannel } from './forkedRuntimeClient';
import type { VoiceInferenceWorkerTransport } from './workerRunner';
import { createVoiceInferenceWorkerRunner } from './workerRunner';
import type { VoiceInferenceRuntime } from '../voiceInferenceRuntimeTypes';
import type { TerminationEvent } from '@/subprocess/supervision/types';

// Intercept only the immutable native ESM access leaf; actual component
// selection, installation-path resolution and the filesystem stay real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  return { ...native, access: vi.fn(native.access) };
});

const manifest: ModelPackManifest = {
  packId: 'pack-1',
  kind: 'tts_sherpa',
  model: 'kokoro',
  version: '2026-04-17',
  files: [],
};

const homes: string[] = [];
const handles: ReturnType<typeof createForkedVoiceInferenceRuntimeHandle>[] = [];
let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE']);

beforeEach(async () => {
  const { access } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fsPromises.access).mockImplementation(access);
  const home = await fsPromises.mkdtemp(join(tmpdir(), 'happier-forked-loader-'));
  homes.push(home);
  envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE: undefined });
  reloadConfiguration();
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.dispose()));
  vi.restoreAllMocks();
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE']);
  reloadConfiguration();
  await Promise.all(homes.splice(0).map((home) => fsPromises.rm(home, { recursive: true, force: true })));
});

/**
 * Wire a real in-memory runner (the actual child-side dispatch loop, NOT a mock) to a
 * channel the client talks to. Only the OS process boundary is replaced — both ends run
 * the genuine protocol + runner logic, so this proves the forked path end-to-end.
 */
function createInMemoryWorkerChannel(runtime: VoiceInferenceRuntime): VoiceInferenceWorkerChannel {
  let clientDataListener: ((chunk: Buffer) => void) | null = null;
  let runnerDataListener: ((chunk: Buffer) => void) | null = null;
  let resolveTermination!: (event: TerminationEvent) => void;
  const termination = new Promise<TerminationEvent>((resolve) => {
    resolveTermination = resolve;
  });

  const runnerTransport: VoiceInferenceWorkerTransport = {
    onData: (listener) => {
      runnerDataListener = listener;
    },
    write: (frame) => clientDataListener?.(frame),
    onClose: () => {},
  };
  createVoiceInferenceWorkerRunner({ transport: runnerTransport, loadRuntime: async () => runtime });

  return {
    pid: 9999,
    send: (frame) => runnerDataListener?.(frame),
    onData: (listener) => {
      clientDataListener = listener;
    },
    waitForTermination: () => termination,
    terminate: () => resolveTermination({ type: 'signaled', signal: 'SIGTERM' }),
    forceTerminate: () => resolveTermination({ type: 'signaled', signal: 'SIGKILL' }),
  };
}

describe('forked voice inference runtime loader', () => {
  it('keeps live recognition usable when cancelling synchronous synthesis retires its worker', async () => {
    let entered!: () => void;
    const synthesizing = new Promise<void>(resolve => { entered = resolve; });
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => { entered(); return await new Promise(() => {}); },
      transcribeAudio: async () => ({ text: '', language: null }),
      createStreamingTranscriptionSession: async () => ({
        appendPcm16: async () => ({ events: [] }),
        finish: async () => ({ text: 'brief me', language: 'en', events: [] }),
        cancel: async () => {}, close: async () => {},
      }),
    };
    const handle = createForkedVoiceInferenceRuntimeHandle({
      prepareRuntime: async () => {},
      channelFactory: async () => createInMemoryWorkerChannel(runtime),
    });
    handles.push(handle);
    const engine = await handle.runtimeLoader();
    if (!engine?.createStreamingTranscriptionSession) throw new Error('expected streaming engine');
    const recognition = await engine.createStreamingTranscriptionSession({
      requestId: 'listening', packId: 'stt', packDir: '/tmp/stt',
      manifest: { ...manifest, packId: 'stt', kind: 'stt_sherpa' }, language: 'en',
      format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
    });
    const abort = new AbortController();
    const speech = engine.synthesizeTts({ requestId: 'readout', text: 'question',
      packId: manifest.packId, packDir: '/tmp/tts', manifest, voiceId: null, speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' }, signal: abort.signal });
    const cancelled = expect(speech).rejects.toMatchObject({ code: 'cancelled' });
    await synthesizing;
    expect(handle.readProcessRoots()).toHaveLength(2);
    abort.abort();
    await cancelled;
    await expect(recognition.appendPcm16({ seq: 0, pcm16Bytes: new Uint8Array([1, 0]) })).resolves.toEqual({ events: [] });
    await expect(recognition.finish({ finalSeq: 0 })).resolves.toMatchObject({ text: 'brief me' });
    await handle.dispose();
    expect(handle.readProcessRoots()).toEqual([]);
  });

  it('serves a request arriving while the previous child is still exiting', async () => {
    let endExit!: () => void;
    const allowExit = new Promise<void>(resolve => { endExit = resolve; });
    let nextPid = 100;
    const handle = createForkedVoiceInferenceRuntimeHandle({
      prepareRuntime: async () => {},
      channelFactory: async () => {
        const pid = nextPid++;
        const channel = createInMemoryWorkerChannel({
          synthesizeTts: async () => ({
            bytes: Buffer.from('speech'),
            output: { codec: 'wav', mimeType: 'audio/wav' },
            name: `speech-${pid}.wav`,
          }),
          transcribeAudio: async () => ({ text: '', language: null }),
        });
        return {
          ...channel,
          pid,
          terminate: () => {
            if (pid === 100) void allowExit.then(channel.terminate);
            else channel.terminate();
          },
        };
      },
    });
    handles.push(handle);
    const runtime = await handle.runtimeLoader();
    if (!runtime) throw new Error('expected forked runtime');
    const request = {
      requestId: 'speech-before-exit', text: 'hello', packId: manifest.packId,
      packDir: '/tmp/tts', manifest, voiceId: null, speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    } as const;
    await expect(runtime.synthesizeTts(request)).resolves.toMatchObject({ name: 'speech-100.wav' });

    const retiring = handle.retire(manifest.kind);
    const successor = runtime.synthesizeTts({ ...request, requestId: 'speech-during-exit' });
    try {
      expect(await Promise.race([successor, new Promise(resolve => setImmediate(() => resolve('waiting')))])).toBe('waiting');
    } finally {
      endExit();
    }
    await retiring;
    await expect(successor).resolves.toMatchObject({ name: 'speech-101.wav' });
  });

  it('serves a replacement request and completes shutdown when children ignore graceful termination', async () => {
    const channels: VoiceInferenceWorkerChannel[] = [];
    const handle = createForkedVoiceInferenceRuntimeHandle({
      prepareRuntime: async () => {},
      channelFactory: async () => {
        const name = `speech-${channels.length}.wav`;
        const channel = createInMemoryWorkerChannel({
          synthesizeTts: async ({ output }) => ({ bytes: Buffer.from('speech'), output, name }),
          transcribeAudio: async () => ({ text: '', language: null }),
        });
        channels.push(channel);
        return { ...channel, terminate: () => {} };
      },
    });
    handles.push(handle);
    const runtime = await handle.runtimeLoader();
    if (!runtime) throw new Error('expected forked runtime');
    const request = {
      requestId: 'speech-before-retirement', text: 'hello', packId: manifest.packId,
      packDir: '/tmp/tts', manifest, voiceId: null, speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    } as const;
    await expect(runtime.synthesizeTts(request)).resolves.toMatchObject({ name: 'speech-0.wav' });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const retiring = handle.retire(manifest.kind);
      const successor = runtime.synthesizeTts({ ...request, requestId: 'speech-after-retirement' });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(await Promise.race([successor, 'still retiring'])).toBe('still retiring');
      await vi.advanceTimersByTimeAsync(1);
      expect(await Promise.race([successor, 'still retiring'])).toMatchObject({ name: 'speech-1.wav' });
      await retiring;

      const shutdown = handle.dispose().then(() => 'stopped');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await Promise.race([shutdown, 'still shutting down'])).toBe('stopped');
    } finally {
      // Release the simulated OS processes even when the old implementation fails the test.
      for (const channel of channels) channel.forceTerminate();
      vi.useRealTimers();
    }
  });

  it('prepares the source native runtime once before exposing or spawning the forked engine', async () => {
    const observations: string[] = [];
    const sourceRuntimeEntrypoint = createRequire(import.meta.url).resolve('sherpa-onnx-node/sherpa-onnx.js');
    const { access: nativeAccess } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fsPromises.access).mockImplementation(async (...args) => {
      if (String(args[0]) === sourceRuntimeEntrypoint) observations.push('prepared');
      await nativeAccess(...args);
    });
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => ({ bytes: Buffer.from('x'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'x.wav' }),
      transcribeAudio: async () => ({ text: '', language: null }),
    };
    const handle = createForkedVoiceInferenceRuntimeHandle({
      channelFactory: async () => {
        observations.push('spawned');
        return createInMemoryWorkerChannel(runtime);
      },
    });
    handles.push(handle);

    expect(handle.readProcessRoots()).toEqual([]);
    expect(observations).toEqual([]);
    const first = await handle.runtimeLoader();
    const second = await handle.runtimeLoader();
    expect(first).toBe(second);
    expect(observations).toEqual(['prepared']);
    await first?.synthesizeTts({
      requestId: 'prepare-once', text: 'hi', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(observations).toEqual(['prepared', 'spawned']);
    await handle.dispose();
  });

  it('force-terminates and awaits the exact spawned child when its observer throws', async () => {
    let forceTerminateCalls = 0;
    let waitForTerminationCalls = 0;
    let live = true;
    let settleTermination!: () => void;
    let markObserverEntered!: () => void;
    const termination = new Promise<TerminationEvent>((resolve) => {
      settleTermination = () => {
        live = false;
        resolve({ type: 'signaled', signal: 'SIGKILL' });
      };
    });
    const observerEntered = new Promise<void>((resolve) => {
      markObserverEntered = resolve;
    });
    const channel: VoiceInferenceWorkerChannel = {
      pid: 17_777,
      send: () => {},
      onData: () => {},
      waitForTermination: () => {
        waitForTerminationCalls += 1;
        return termination;
      },
      terminate: () => {},
      forceTerminate: () => {
        forceTerminateCalls += 1;
      },
    };
    const handle = createForkedVoiceInferenceRuntimeHandle({
      channelFactory: async () => channel,
      onWorkerProcess: () => {
        markObserverEntered();
        throw new Error('observer failed');
      },
    });
    handles.push(handle);

    const engine = await handle.runtimeLoader();
    if (!engine) throw new Error('expected runtime');
    const synthesis = engine.synthesizeTts({
      requestId: 'observer-throws', text: 'hi', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    // Attach a rejection handler while the assertion deliberately keeps termination pending.
    void synthesis.catch(() => {});
    await observerEntered;

    expect(forceTerminateCalls).toBe(1);
    expect(waitForTerminationCalls).toBe(1);
    expect(live).toBe(true);

    settleTermination();
    await expect(synthesis).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: 'voice_inference_worker_spawn_failed',
    });
    expect(live).toBe(false);
    await handle.dispose();
  });

  it('observes the exact canonical worker process without enumerating ambient processes', async () => {
    const observations: Array<Readonly<{
      pid: number | null;
      waitForTermination: VoiceInferenceWorkerChannel['waitForTermination'];
    }>> = [];
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => ({ bytes: Buffer.from('x'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'x.wav' }),
      transcribeAudio: async () => ({ text: '', language: null }),
    };
    const handle = createForkedVoiceInferenceRuntimeHandle({
      channelFactory: async () => createInMemoryWorkerChannel(runtime),
      onWorkerProcess: (observation) => observations.push(observation),
    });
    handles.push(handle);

    const engine = await handle.runtimeLoader();
    await engine?.synthesizeTts({
      requestId: 'observe-worker', text: 'hi', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.pid).toBe(9999);

    await handle.dispose();
    await expect(observations[0]?.waitForTermination()).resolves.toEqual({
      type: 'signaled',
      signal: 'SIGTERM',
    });
  });

  it('drives the engine through the forked client + runner over the IPC boundary', async () => {
    const snapshots: string[] = [];
    const runtime: VoiceInferenceRuntime = {
      warmModel: async () => {},
      synthesizeTts: async () => ({ bytes: Buffer.from('loader-audio'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'l.wav' }),
      transcribeAudio: async () => ({ text: 'loader-text', language: 'en' }),
    };

    const handle = createForkedVoiceInferenceRuntimeHandle({
      channelFactory: async () => createInMemoryWorkerChannel(runtime),
      onSnapshot: (snapshot) => snapshots.push(`${snapshot.packId}:${snapshot.runtimeState}`),
    });
    handles.push(handle);

    const engine = await handle.runtimeLoader();
    expect(engine).not.toBeNull();
    if (!engine) throw new Error('expected runtime');

    await engine.warmModel?.({ packId: 'pack-1', packDir: '/tmp/pack-1', manifest });
    const synth = await engine.synthesizeTts({
      requestId: 'tts-1', text: 'hi', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(Buffer.from(synth.bytes).toString('utf8')).toBe('loader-audio');

    const transcription = await engine.transcribeAudio({
      requestId: 'stt-1', filePath: '/tmp/upload.wav', inputMimeType: 'audio/wav', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, language: 'en', normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
    });
    expect(transcription).toEqual({ text: 'loader-text', language: 'en' });

    // Warm pushed readiness snapshots over the boundary.
    expect(snapshots).toContain('pack-1:warming');
    expect(snapshots).toContain('pack-1:ready');

    await handle.dispose();
  });

  it('returns the same supervised client across loads and disposes it cleanly', async () => {
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => ({ bytes: Buffer.from('x'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'x.wav' }),
      transcribeAudio: async () => ({ text: '', language: null }),
    };
    const handle = createForkedVoiceInferenceRuntimeHandle({
      channelFactory: async () => createInMemoryWorkerChannel(runtime),
    });
    handles.push(handle);
    const a = await handle.runtimeLoader();
    const b = await handle.runtimeLoader();
    expect(a).toBe(b);
    await handle.dispose();
    // Dispose is idempotent.
    await handle.dispose();
  });
});
