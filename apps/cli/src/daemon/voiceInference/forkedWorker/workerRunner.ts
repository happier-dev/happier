/**
 * Child-side runner for the FORKED voice-inference worker (Lane L7.T7).
 *
 * Runs INSIDE the forked child process. It hosts the real sherpa engine (loaded through
 * the same `loadDefaultVoiceInferenceRuntime` the in-process path uses) and answers
 * request frames from the daemon over a byte-stream transport (the child's stdio).
 *
 * The runner is deliberately thin: model residency / LRU / readiness bookkeeping stays in
 * the daemon-side manager. The child just executes engine calls and forwards results,
 * readiness snapshots, abort, and errors.
 *
 * The engine boundary is injected so the dispatch loop is testable without native models.
 */

import { randomUUID } from 'node:crypto';

import type { DaemonVoiceInferenceModelRuntimeState } from '@happier-dev/protocol';

import { resolveVoiceInferenceWorkerMaxFrameBytes } from '../voiceInferenceWorkerConfig';
import type { VoiceInferenceRuntime, VoiceInferenceStreamingTranscriptionSession } from '../voiceInferenceRuntimeTypes';
import {
  readVoiceInferenceErrorCode,
} from '../voiceInferenceWorker.shared';
import {
  createVoiceInferenceWorkerFrameDecoder,
  encodeVoiceInferenceWorkerFrame,
  parseVoiceInferenceWorkerRequestFrame,
  type VoiceInferenceWorkerRequestFrame,
  type VoiceInferenceWorkerResponseFrame,
} from './ipcProtocol';

export type VoiceInferenceWorkerTransport = Readonly<{
  /** Subscribe to raw inbound bytes (request frames from the daemon). */
  onData: (listener: (chunk: Buffer) => void) => void;
  /** Write one encoded response frame back to the daemon. */
  write: (frame: Buffer) => void;
  /** Resolve when the daemon end closes (the child should then exit). */
  onClose: (listener: () => void) => void;
}>;

export type VoiceInferenceWorkerRunner = Readonly<{
  /** Number of requests currently executing in the child (diagnostics/tests). */
  inFlightCount: () => number;
  /** Stop accepting work and abort everything in flight. */
  dispose: () => void;
}>;

export type CreateVoiceInferenceWorkerRunnerParams = Readonly<{
  transport: VoiceInferenceWorkerTransport;
  /**
   * Loads the engine that runs in the child. Defaults to the canonical loader so the child
   * uses exactly the same runtime selection as the in-process path.
   */
  loadRuntime: () => Promise<VoiceInferenceRuntime | null>;
  onError?: (message: string, payload?: unknown) => void;
  /** Per-IPC-frame byte ceiling (M2). Defaults to the centralized config knob. */
  maxFrameBytes?: number;
}>;

type ManagedStreamingSession = {
  session: VoiceInferenceStreamingTranscriptionSession;
  cleanupPromise: Promise<void> | null;
};

function toErrorCodeAndMessage(error: unknown): Readonly<{ code: string; message: string }> {
  const code = readVoiceInferenceErrorCode(error);
  const message = error instanceof Error ? error.message : String(error ?? '');
  return {
    code: code.length > 0 ? code : 'internal_error',
    message: message.length > 0 ? message : 'voice_inference_worker_failed',
  };
}

export function createVoiceInferenceWorkerRunner(
  params: CreateVoiceInferenceWorkerRunnerParams,
): VoiceInferenceWorkerRunner {
  const maxFrameBytes = params.maxFrameBytes ?? resolveVoiceInferenceWorkerMaxFrameBytes();
  const decoder = createVoiceInferenceWorkerFrameDecoder(maxFrameBytes);
  const abortControllersById = new Map<string, AbortController>();
  const streamingSessionsById = new Map<string, ManagedStreamingSession>();
  let disposed = false;
  let cachedRuntime: VoiceInferenceRuntime | null = null;
  let cachedRuntimeLoad: Promise<VoiceInferenceRuntime> | null = null;

  function send(frame: VoiceInferenceWorkerResponseFrame): void {
    try {
      params.transport.write(encodeVoiceInferenceWorkerFrame(frame, maxFrameBytes));
    } catch (error) {
      params.onError?.('[voiceInferenceWorkerRunner] write failed', error);
    }
  }

  function sendSynthesizeResult(
    id: string,
    synthesized: Awaited<ReturnType<VoiceInferenceRuntime['synthesizeTts']>>,
  ): void {
    // The runtime is terminal-buffered today. Check the base64 payload length before allocating
    // it: there is no partial-result producer on this IPC wire, so an over-ceiling result must
    // settle as a typed error rather than be dropped and force the daemon into a timeout/restart.
    const resultWithoutAudio = {
      kind: 'result' as const,
      id,
      result: {
        kind: 'synthesize' as const,
        output: synthesized.output,
        bytesBase64: '',
        name: synthesized.name ?? null,
      },
    };
    const encodedAudioBytes = Math.ceil(synthesized.bytes.byteLength / 3) * 4;
    const resultBytes = Buffer.byteLength(JSON.stringify(resultWithoutAudio), 'utf8') + encodedAudioBytes;
    if (resultBytes > maxFrameBytes) {
      send({
        kind: 'error',
        id,
        code: 'output_too_large',
        message: 'voice_inference_tts_output_too_large',
      });
      return;
    }
    send({
      ...resultWithoutAudio,
      result: {
        ...resultWithoutAudio.result,
        bytesBase64: Buffer.from(synthesized.bytes).toString('base64'),
      },
    });
  }

  async function resolveRuntime(): Promise<VoiceInferenceRuntime> {
    if (cachedRuntime) {
      return cachedRuntime;
    }
    if (!cachedRuntimeLoad) {
      cachedRuntimeLoad = (async () => {
        const runtime = await params.loadRuntime();
        if (!runtime) {
          cachedRuntimeLoad = null;
          throw Object.assign(new Error('voice_inference_runtime_unavailable'), { code: 'runtime_unavailable' });
        }
        cachedRuntime = runtime;
        return runtime;
      })();
    }
    return cachedRuntimeLoad;
  }

  function emitSnapshot(
    packId: string,
    runtimeState: DaemonVoiceInferenceModelRuntimeState,
  ): void {
    send({ kind: 'snapshot', packId, runtimeState });
  }

  async function cleanupStreamingSession(
    managedSession: ManagedStreamingSession,
    options: Readonly<{ cancel: boolean }>,
  ): Promise<void> {
    if (managedSession.cleanupPromise) {
      return await managedSession.cleanupPromise;
    }
    const session = managedSession.session;
    const cleanup = (async () => {
      if (options.cancel) {
        await session.cancel().catch(() => undefined);
      }
      await session.close().catch(() => undefined);
    })();
    managedSession.cleanupPromise = cleanup;
    return await cleanup;
  }

  async function handleRequest(frame: VoiceInferenceWorkerRequestFrame): Promise<void> {
    if (frame.kind === 'abort') {
      abortControllersById.get(frame.targetId)?.abort();
      return;
    }

    const abortController = new AbortController();
    abortControllersById.set(frame.id, abortController);
    try {
      const runtime = await resolveRuntime();
      // If cancellation already landed while the engine was loading, settle immediately so a
      // pre-aborted signal never gets swallowed by an engine that only listens for the event.
      if (abortController.signal.aborted) {
        send({ kind: 'error', id: frame.id, code: 'cancelled', message: 'voice_inference_cancelled' });
        return;
      }
      switch (frame.kind) {
        case 'warm': {
          emitSnapshot(frame.packId, 'warming');
          await runtime.warmModel?.({
            packId: frame.packId,
            packDir: frame.packDir,
            manifest: frame.manifest,
            runtimeDescriptor: frame.runtimeDescriptor,
            supportArtifacts: frame.supportArtifacts,
            signal: abortController.signal,
          });
          emitSnapshot(frame.packId, 'ready');
          send({ kind: 'result', id: frame.id, result: { kind: 'warm' } });
          return;
        }
        case 'prime': {
          await runtime.primeModel?.({
            packId: frame.packId,
            packDir: frame.packDir,
            manifest: frame.manifest,
            runtimeDescriptor: frame.runtimeDescriptor,
            supportArtifacts: frame.supportArtifacts,
            signal: abortController.signal,
          });
          send({ kind: 'result', id: frame.id, result: { kind: 'prime' } });
          return;
        }
        case 'release': {
          await runtime.releaseModel?.({
            packId: frame.packId,
            packDir: frame.packDir,
            manifest: frame.manifest,
            runtimeDescriptor: frame.runtimeDescriptor,
            supportArtifacts: frame.supportArtifacts,
            signal: abortController.signal,
          });
          emitSnapshot(frame.packId, 'evicted');
          send({ kind: 'result', id: frame.id, result: { kind: 'release' } });
          return;
        }
        case 'synthesize': {
          const synthesized = await runtime.synthesizeTts({
            requestId: frame.requestId,
            text: frame.text,
            packId: frame.packId,
            packDir: frame.packDir,
            manifest: frame.manifest,
            runtimeDescriptor: frame.runtimeDescriptor,
            supportArtifacts: frame.supportArtifacts,
            voiceId: frame.voiceId,
            speed: frame.speed,
            output: frame.output,
            signal: abortController.signal,
          });
          sendSynthesizeResult(frame.id, synthesized);
          return;
        }
        case 'transcribe': {
          const transcribed = await runtime.transcribeAudio({
            requestId: frame.requestId,
            filePath: frame.filePath,
            inputMimeType: frame.inputMimeType,
            packId: frame.packId,
            packDir: frame.packDir,
            manifest: frame.manifest,
            runtimeDescriptor: frame.runtimeDescriptor,
            supportArtifacts: frame.supportArtifacts,
            language: frame.language,
            normalization: frame.normalization,
            signal: abortController.signal,
          });
          send({ kind: 'result', id: frame.id, result: { kind: 'transcribe', text: transcribed.text, language: transcribed.language } });
          return;
        }
        case 'stt_stream_start': {
          if (typeof runtime.createStreamingTranscriptionSession !== 'function') {
            throw Object.assign(new Error('voice_inference_streaming_stt_unavailable'), { code: 'runtime_unavailable' });
          }
          const session = await runtime.createStreamingTranscriptionSession({
            requestId: frame.requestId,
            packId: frame.packId,
            packDir: frame.packDir,
            manifest: frame.manifest,
            runtimeDescriptor: frame.runtimeDescriptor,
            supportArtifacts: frame.supportArtifacts,
            language: frame.language,
            format: frame.format,
            signal: abortController.signal,
          });
          const managedSession: ManagedStreamingSession = { session, cleanupPromise: null };
          if (disposed || abortController.signal.aborted) {
            // A runtime may ignore the abort while constructing a native session. Never admit
            // that late resource after transport disposal/cancellation has cleared ownership.
            await cleanupStreamingSession(managedSession, { cancel: true });
            throw Object.assign(new Error('voice_inference_cancelled'), { code: 'cancelled' });
          }
          const sessionId = `stt-stream-${randomUUID()}`;
          streamingSessionsById.set(sessionId, managedSession);
          send({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_start', sessionId } });
          return;
        }
        case 'stt_stream_append': {
          const managedSession = streamingSessionsById.get(frame.sessionId);
          if (!managedSession) {
            throw Object.assign(new Error('voice_inference_stream_not_found'), { code: 'stream_not_found' });
          }
          const appended = await managedSession.session.appendPcm16({
            seq: frame.seq,
            pcm16Bytes: Buffer.from(frame.pcm16Base64, 'base64'),
            signal: abortController.signal,
          });
          send({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_append', events: appended.events } });
          return;
        }
        case 'stt_stream_finish': {
          const managedSession = streamingSessionsById.get(frame.sessionId);
          if (!managedSession) {
            throw Object.assign(new Error('voice_inference_stream_not_found'), { code: 'stream_not_found' });
          }
          try {
            const finished = await managedSession.session.finish({
              finalSeq: frame.finalSeq,
              signal: abortController.signal,
            });
            send({
              kind: 'result',
              id: frame.id,
              result: {
                kind: 'stt_stream_finish',
                text: finished.text,
                language: finished.language,
                events: finished.events,
              },
            });
          } finally {
            streamingSessionsById.delete(frame.sessionId);
            await cleanupStreamingSession(managedSession, { cancel: false });
          }
          return;
        }
        case 'stt_stream_cancel': {
          const managedSession = streamingSessionsById.get(frame.sessionId);
          streamingSessionsById.delete(frame.sessionId);
          if (managedSession) {
            await cleanupStreamingSession(managedSession, { cancel: true });
          }
          send({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_cancel' } });
          return;
        }
        default: {
          const exhaustive: never = frame;
          void exhaustive;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        send({ kind: 'error', id: frame.id, code: 'cancelled', message: 'voice_inference_cancelled' });
        return;
      }
      const { code, message } = toErrorCodeAndMessage(error);
      send({ kind: 'error', id: frame.id, code, message });
    } finally {
      abortControllersById.delete(frame.id);
    }
  }

  params.transport.onData((chunk) => {
    if (disposed) {
      return;
    }
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      params.onError?.('[voiceInferenceWorkerRunner] decode failed', error);
      return;
    }
    for (const frame of frames) {
      // The daemon is the UNtrusted peer on this wire (symmetric to the client-side
      // response-frame validation): a well-framed, valid-JSON frame can still have the
      // wrong SHAPE. Validate every decoded frame against the request-frame contract
      // before dispatching it into the engine boundary; reject malformed frames instead
      // of casting them through.
      let request: VoiceInferenceWorkerRequestFrame;
      try {
        request = parseVoiceInferenceWorkerRequestFrame(frame);
      } catch (error) {
        params.onError?.('[voiceInferenceWorkerRunner] invalid request frame', error);
        continue;
      }
      void handleRequest(request);
    }
  });

  params.transport.onClose(() => {
    dispose();
  });

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const controller of abortControllersById.values()) {
      controller.abort();
    }
    abortControllersById.clear();
    for (const managedSession of streamingSessionsById.values()) {
      void cleanupStreamingSession(managedSession, { cancel: true });
    }
    streamingSessionsById.clear();
  }

  return {
    inFlightCount: () => abortControllersById.size,
    dispose,
  };
}
