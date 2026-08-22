import type { ModelPackManifest } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createForkedVoiceInferenceRuntimeHandle } from './forkedRuntimeLoader';
import type { VoiceInferenceWorkerChannel } from './forkedRuntimeClient';
import type { VoiceInferenceWorkerTransport } from './workerRunner';
import { createVoiceInferenceWorkerRunner } from './workerRunner';
import type { VoiceInferenceRuntime } from '../voiceInferenceRuntimeTypes';
import type { TerminationEvent } from '@/subprocess/supervision/types';

const manifest: ModelPackManifest = {
  packId: 'pack-1',
  kind: 'tts_sherpa',
  model: 'kokoro',
  version: '2026-04-17',
  files: [],
};

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
    const a = await handle.runtimeLoader();
    const b = await handle.runtimeLoader();
    expect(a).toBe(b);
    await handle.dispose();
    // Dispose is idempotent.
    await handle.dispose();
  });
});
