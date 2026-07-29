/**
 * Daemon-side client for the FORKED voice-inference worker (Lane L7.T7).
 *
 * Presents the SAME `VoiceInferenceRuntime` engine interface as the in-process path, but
 * every call is proxied over IPC to a supervised child process that hosts the native
 * sherpa engine. A native crash/hang in the child therefore cannot take down the daemon:
 * the supervisor detects the exit, fails in-flight requests cleanly (reject, never hang),
 * and restarts the child with bounded backoff on the next use.
 *
 * The child is owned by the canonical subprocess supervision toolkit
 * (`createSupervisedProcess`), and is spawned through an injected channel factory so the
 * binary-safe `spawnHappyCLI` primitive is the only thing that ever touches a real
 * process (and tests can substitute an in-memory channel — a pure boundary mock).
 */

import type { DaemonVoiceInferenceModelRuntimeState } from '@happier-dev/protocol';

import {
  createSupervisedProcess,
  type SupervisedProcess,
} from '@/subprocess/supervision/supervisedProcess';
import type {
  ManagedProcessPolicy,
  TerminationEvent,
} from '@/subprocess/supervision/types';

import {
  resolveVoiceInferenceWorkerMaxFrameBytes,
  resolveVoiceInferenceWorkerMissedPingThreshold,
  resolveVoiceInferenceWorkerPingIntervalMs,
  resolveVoiceInferenceWorkerRequestTimeoutMs,
} from '../voiceInferenceWorkerConfig';
import type {
  VoiceInferenceRuntime,
  VoiceInferenceRuntimeCreateStreamingTranscriptionSessionInput,
  VoiceInferenceRuntimePrimeModelInput,
  VoiceInferenceRuntimeReleaseModelInput,
  VoiceInferenceRuntimeSynthesizeInput,
  VoiceInferenceRuntimeSynthesizeResult,
  VoiceInferenceStreamingTranscriptionSession,
  VoiceInferenceRuntimeTranscribeInput,
  VoiceInferenceRuntimeTranscribeResult,
  VoiceInferenceRuntimeWarmModelInput,
} from '../voiceInferenceRuntimeTypes';
import { createVoiceInferenceError } from '../voiceInferenceWorker.shared';
import {
  createVoiceInferenceWorkerFrameDecoder,
  encodeVoiceInferenceWorkerFrame,
  parseVoiceInferenceWorkerResponseFrame,
  type VoiceInferenceWorkerFrame,
  type VoiceInferenceWorkerPartialFrame,
  type VoiceInferenceWorkerRequestFrame,
  type VoiceInferenceWorkerResponseFrame,
} from './ipcProtocol';

/**
 * Abstract bidirectional byte channel to the worker. In production this wraps the child
 * process stdio; in tests it is an in-memory pipe. Keeping it abstract is what lets the
 * supervision + protocol logic be tested without spawning a real process.
 */
export type VoiceInferenceWorkerChannel = Readonly<{
  pid: number | null;
  /** Write one encoded frame to the child. */
  send: (frame: Buffer) => void;
  /** Register the consumer for raw bytes coming back from the child. */
  onData: (listener: (chunk: Buffer) => void) => void;
  /** Resolves exactly once when the child terminates for any reason. */
  waitForTermination: () => Promise<TerminationEvent>;
  /** Request termination (SIGTERM-style); best-effort. */
  terminate: () => void;
}>;

export type VoiceInferenceWorkerChannelFactory = () => Promise<VoiceInferenceWorkerChannel>;

export type ForkedVoiceInferenceRuntimeSnapshot = Readonly<{
  packId: string;
  runtimeState: DaemonVoiceInferenceModelRuntimeState;
  residentMemoryBytes: number | null;
}>;

export type ForkedVoiceInferenceRuntimeClient = Readonly<
  VoiceInferenceRuntime & {
    /** Tear down the child and reject any in-flight requests. No leaked processes. */
    stop: () => Promise<void>;
  }
>;

type PendingRequest = Readonly<{
  resolve: (frame: VoiceInferenceWorkerResponseFrame) => void;
  reject: (error: unknown) => void;
  onPartial?: (frame: VoiceInferenceWorkerPartialFrame) => void;
  /** Activity-based liveness: called on every inbound frame for this request to push the deadline. */
  resetDeadline?: () => void;
}>;

const DEFAULT_WORKER_POLICY: ManagedProcessPolicy = {
  kind: 'other',
  restart: {
    mode: 'on_unexpected_exit',
    maxRestarts: null,
    baseDelayMs: 250,
    maxDelayMs: 5_000,
    jitterMs: 100,
  },
  logging: { logTerminationEvents: false },
  artifacts: { captureStderr: false },
  terminateGraceMs: 2_000,
};

const MAX_TTS_PARTIAL_CHUNKS = 4_096;

let requestSequence = 0;
function nextRequestId(): string {
  requestSequence += 1;
  return `vw-${requestSequence}`;
}

export type CreateForkedVoiceInferenceRuntimeClientParams = Readonly<{
  channelFactory: VoiceInferenceWorkerChannelFactory;
  policy?: ManagedProcessPolicy;
  onSnapshot?: (snapshot: ForkedVoiceInferenceRuntimeSnapshot) => void;
  random?: () => number;
  loggerDebug?: (message: string, payload?: unknown) => void;
  /**
   * Per-request deadline. A wedged-but-alive child rejects the request with `runtime_timeout`
   * and the channel is terminated so the supervisor respawns. Streaming requests reset this on
   * each chunk (activity-based liveness). Defaults to the centralized config knob; `0` disables.
   */
  requestTimeoutMs?: number;
  /** Heartbeat cadence for the liveness watchdog. Defaults to the config knob; `0` disables. */
  pingIntervalMs?: number;
  /** Consecutive unanswered pings before the child is declared hung. Defaults to the config knob. */
  missedPingThreshold?: number;
  /** Per-IPC-frame byte ceiling. Defaults to the config knob (M2). */
  maxFrameBytes?: number;
}>;

export function createForkedVoiceInferenceRuntimeClient(
  params: CreateForkedVoiceInferenceRuntimeClientParams,
): ForkedVoiceInferenceRuntimeClient {
  const policy = params.policy ?? DEFAULT_WORKER_POLICY;
  const requestTimeoutMs = params.requestTimeoutMs ?? resolveVoiceInferenceWorkerRequestTimeoutMs();
  const pingIntervalMs = params.pingIntervalMs ?? resolveVoiceInferenceWorkerPingIntervalMs();
  const missedPingThreshold = params.missedPingThreshold ?? resolveVoiceInferenceWorkerMissedPingThreshold();
  const maxFrameBytes = params.maxFrameBytes ?? resolveVoiceInferenceWorkerMaxFrameBytes();

  let stopped = false;
  let activeChannel: VoiceInferenceWorkerChannel | null = null;
  let channelReady: Promise<VoiceInferenceWorkerChannel> | null = null;
  let resolveChannelReady: ((channel: VoiceInferenceWorkerChannel) => void) | null = null;
  let rejectChannelReady: ((error: unknown) => void) | null = null;
  const pendingById = new Map<string, PendingRequest>();

  // Liveness watchdog state for the currently-attached channel. `outstandingPings` counts
  // pings sent since the last `ready`; it resets to 0 whenever ANY frame arrives from the
  // child (a `ready` pong, or genuine request progress), and trips at `missedPingThreshold`.
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let outstandingPings = 0;

  function disarmPingWatchdog(): void {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    outstandingPings = 0;
  }

  function noteChannelActivity(): void {
    // Only a SUCCESSFULLY-DECODED, schema-valid frame proves the child is responsive (M2). This is
    // intentionally NOT reset on raw inbound bytes: a chatty-but-broken child dribbling undecodable
    // noise must not be able to keep the liveness watchdog alive.
    outstandingPings = 0;
  }

  function terminateCorruptChannel(channel: VoiceInferenceWorkerChannel, error: unknown): void {
    // A framing/oversize error (decoder throw) or a schema-invalid frame means the wire is corrupt
    // and can never resync — the length-prefixed decoder cannot advance past a bad prefix. Do NOT
    // swallow it (that wedges the channel). Terminate so the EXISTING supervisor fails in-flight
    // requests and respawns a clean child + decoder (M2 / L4); never build a parallel restart path.
    params.loggerDebug?.('[forkedVoiceInferenceClient] corrupt inbound frame — terminating channel', error);
    try {
      channel.terminate();
    } catch {
      // best-effort; if the channel is already gone, onTermination has already fired.
    }
  }

  function declareHungAndKill(channel: VoiceInferenceWorkerChannel): void {
    disarmPingWatchdog();
    params.loggerDebug?.('[forkedVoiceInferenceClient] worker unresponsive — force-killing', {
      missedPingThreshold,
    });
    // Force-kill the wedged-but-alive child. Its termination flows through the EXISTING
    // supervised restart path (waitForTermination → onTermination → failAllPending + respawn);
    // we do NOT build a parallel restart mechanism here.
    try {
      channel.terminate();
    } catch {
      // best-effort; if the channel is already gone, onTermination already fired.
    }
  }

  function armPingWatchdog(channel: VoiceInferenceWorkerChannel): void {
    disarmPingWatchdog();
    if (pingIntervalMs <= 0 || missedPingThreshold <= 0) {
      return;
    }
    pingTimer = setInterval(() => {
      if (stopped || activeChannel !== channel) {
        disarmPingWatchdog();
        return;
      }
      if (pendingById.size > 0) {
        // Native model construction/inference can synchronously occupy the child event loop, so
        // it cannot answer heartbeat pings while legitimate work is in flight. That interval is
        // already owned by each request's deadline; the heartbeat only supervises an idle channel.
        outstandingPings = 0;
        return;
      }
      if (outstandingPings >= missedPingThreshold) {
        declareHungAndKill(channel);
        return;
      }
      outstandingPings += 1;
      try {
        channel.send(encodeVoiceInferenceWorkerFrame({ kind: 'ping', id: nextRequestId() }, maxFrameBytes));
      } catch {
        // A failed send means the pipe is broken; let the supervisor's termination path handle it.
      }
    }, pingIntervalMs);
    pingTimer.unref?.();
  }

  function failAllPending(error: unknown): void {
    const pending = [...pendingById.values()];
    pendingById.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }

  function attachChannel(channel: VoiceInferenceWorkerChannel): void {
    const decoder = createVoiceInferenceWorkerFrameDecoder(maxFrameBytes);
    channel.onData((chunk) => {
      let rawFrames: VoiceInferenceWorkerFrame[];
      try {
        rawFrames = decoder.push(chunk);
      } catch (error) {
        // M2(a): a framing/oversize/JSON error means the wire is corrupt — terminate instead of
        // swallowing. Raw bytes did NOT touch the watchdog, so undecodable noise cannot starve it.
        terminateCorruptChannel(channel, error);
        return;
      }
      for (const rawFrame of rawFrames) {
        let frame: VoiceInferenceWorkerResponseFrame;
        try {
          // L4: validate each decoded frame against the response contract before trusting it. One
          // chokepoint with M2 — a malformed frame is handled exactly like a framing error.
          frame = parseVoiceInferenceWorkerResponseFrame(rawFrame);
        } catch (error) {
          terminateCorruptChannel(channel, error);
          return;
        }
        // M2(b): the missed-ping counter resets ONLY here — after a frame is fully decoded AND
        // schema-validated — never on raw or undecodable inbound bytes.
        noteChannelActivity();
        handleResponseFrame(frame, channel);
      }
    });
  }

  function handleResponseFrame(frame: VoiceInferenceWorkerResponseFrame, channel: VoiceInferenceWorkerChannel): void {
    if (frame.kind === 'snapshot') {
      params.onSnapshot?.({
        packId: frame.packId,
        runtimeState: frame.runtimeState,
        residentMemoryBytes: frame.residentMemoryBytes,
      });
      return;
    }
    const pending = pendingById.get(frame.id);
    if (!pending) {
      return;
    }
    if (frame.kind === 'partial') {
      // Streaming chunk = progress: push the per-request deadline so a long legit synthesis
      // (STT partials / chunked TTS) is never falsely timed out while it is making progress.
      pending.resetDeadline?.();
      try {
        pending.onPartial?.(frame);
      } catch (error) {
        pendingById.delete(frame.id);
        pending.reject(error);
        terminateCorruptChannel(channel, error);
      }
      return;
    }
    if (frame.kind === 'ready') {
      // `ready` is only a terminal frame for a `ping`.
      pendingById.delete(frame.id);
      pending.resolve(frame);
      return;
    }
    // `result` and `error` are terminal.
    pendingById.delete(frame.id);
    pending.resolve(frame);
  }

  const supervisor: SupervisedProcess = createSupervisedProcess({
    id: 'voice-inference-forked-worker',
    policy,
    random: params.random,
    loggerDebug: params.loggerDebug,
    spawn: async () => {
      const channel = await params.channelFactory();
      activeChannel = channel;
      attachChannel(channel);
      // Begin policing idle-channel liveness. A wedged-but-alive idle child that misses
      // `missedPingThreshold` pongs is force-killed, routing through this same supervisor;
      // in-flight work remains owned by the per-request deadline above.
      armPingWatchdog(channel);
      // Resolve the readiness gate for any caller waiting on a fresh channel.
      resolveChannelReady?.(channel);
      resolveChannelReady = null;
      rejectChannelReady = null;
      return {
        pid: channel.pid,
        waitForTermination: channel.waitForTermination,
      };
    },
    onTermination: (event) => {
      const unavailableError = createVoiceInferenceError(
        'runtime_unavailable',
        event.type === 'spawn_error'
          ? 'voice_inference_worker_spawn_failed'
          : 'voice_inference_worker_terminated',
      );
      activeChannel = null;
      // A spawn failure happens before there is an active channel or a pending request. Reject
      // the shared readiness gate itself; merely clearing it strands every caller currently
      // awaiting `ensureChannel()` forever and also prevents a supervised restart from settling
      // those original promises.
      rejectChannelReady?.(unavailableError);
      channelReady = null;
      resolveChannelReady = null;
      rejectChannelReady = null;
      disarmPingWatchdog();
      // In-flight requests can never complete on a dead child — reject cleanly so callers
      // surface `runtime_unavailable` instead of hanging forever.
      failAllPending(unavailableError);
      params.loggerDebug?.('[forkedVoiceInferenceClient] worker terminated', event);
    },
  });

  async function ensureChannel(): Promise<VoiceInferenceWorkerChannel> {
    if (stopped) {
      throw createVoiceInferenceError('runtime_unavailable', 'voice_inference_worker_stopped');
    }
    if (activeChannel) {
      return activeChannel;
    }
    if (!channelReady) {
      channelReady = new Promise<VoiceInferenceWorkerChannel>((resolve, reject) => {
        resolveChannelReady = resolve;
        rejectChannelReady = reject;
      });
      supervisor.start();
    }
    return channelReady;
  }

  async function request<TResult>(
    build: (id: string) => VoiceInferenceWorkerRequestFrame,
    interpret: (frame: VoiceInferenceWorkerResponseFrame) => TResult,
    options?: Readonly<{
      signal?: AbortSignal | null;
      onPartial?: (frame: VoiceInferenceWorkerPartialFrame) => void;
    }>,
  ): Promise<TResult> {
    if (options?.signal?.aborted) {
      throw createVoiceInferenceError('cancelled');
    }
    const channel = await ensureChannel();
    if (options?.signal?.aborted) {
      throw createVoiceInferenceError('cancelled');
    }
    const id = nextRequestId();
    const frame = build(id);

    return await new Promise<TResult>((resolve, reject) => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

      const clearDeadline = () => {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
      };

      const onDeadline = () => {
        if (settled) return;
        // A wedged-but-alive child blew the per-request deadline. Reject THIS request with a
        // typed timeout, then mark the worker unhealthy by terminating the channel — its
        // termination routes through the existing supervisor (failAllPending + respawn), so we
        // never build a parallel restart path.
        pendingById.delete(id);
        finish(() => reject(createVoiceInferenceError('runtime_timeout', 'voice_inference_worker_request_timeout')));
        try {
          channel.terminate();
        } catch {
          // best-effort; if the channel is already gone, onTermination has already fired.
        }
      };

      const armDeadline = () => {
        clearDeadline();
        if (requestTimeoutMs <= 0) {
          return;
        }
        deadlineTimer = setTimeout(onDeadline, requestTimeoutMs);
        deadlineTimer.unref?.();
      };

      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        run();
      };

      const onAbort = () => {
        // Tell the child to cancel; the terminal `error: cancelled` will settle the promise.
        try {
          channel.send(encodeVoiceInferenceWorkerFrame({ kind: 'abort', id: nextRequestId(), targetId: id }, maxFrameBytes));
        } catch {
          // If the channel is already gone, the pending request will be rejected by onTermination.
        }
      };

      const cleanup = () => {
        clearDeadline();
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      pendingById.set(id, {
        resolve: (responseFrame) => {
          if (responseFrame.kind === 'error') {
            finish(() => reject(createVoiceInferenceError(responseFrame.code, responseFrame.message)));
            return;
          }
          finish(() => {
            try {
              resolve(interpret(responseFrame));
            } catch (error) {
              reject(error);
            }
          });
        },
        reject: (error) => finish(() => reject(error)),
        onPartial: options?.onPartial,
        resetDeadline: armDeadline,
      });

      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      try {
        channel.send(encodeVoiceInferenceWorkerFrame(frame, maxFrameBytes));
        // Arm the deadline only after the request is actually on the wire.
        armDeadline();
      } catch (error) {
        pendingById.delete(id);
        finish(() => reject(createVoiceInferenceError('runtime_unavailable', error instanceof Error ? error.message : 'voice_inference_worker_send_failed')));
        // A send failure leaves the child-side state unknowable. Terminate this exact channel so
        // its runner disposes any streaming sessions and supervision can replace the broken pipe.
        try {
          channel.terminate();
        } catch {
          // best-effort; an already-dead channel will settle through onTermination.
        }
      }
    });
  }

  async function warmModel(input: VoiceInferenceRuntimeWarmModelInput): Promise<void> {
    await request(
      (id) => ({
        kind: 'warm',
        id,
        packId: input.packId,
        packDir: input.packDir,
        manifest: input.manifest,
        runtimeDescriptor: input.runtimeDescriptor,
        supportArtifacts: input.supportArtifacts,
      }),
      () => undefined,
      { signal: input.signal },
    );
  }

  async function primeModel(input: VoiceInferenceRuntimePrimeModelInput): Promise<void> {
    await request(
      (id) => ({
        kind: 'prime',
        id,
        packId: input.packId,
        packDir: input.packDir,
        manifest: input.manifest,
        runtimeDescriptor: input.runtimeDescriptor,
        supportArtifacts: input.supportArtifacts,
      }),
      () => undefined,
      { signal: input.signal },
    );
  }

  async function releaseModel(input: VoiceInferenceRuntimeReleaseModelInput): Promise<void> {
    await request(
      (id) => ({
        kind: 'release',
        id,
        packId: input.packId,
        packDir: input.packDir,
        manifest: input.manifest,
        runtimeDescriptor: input.runtimeDescriptor,
        supportArtifacts: input.supportArtifacts,
      }),
      () => undefined,
      { signal: input.signal },
    );
  }

  async function synthesizeTts(
    input: VoiceInferenceRuntimeSynthesizeInput,
  ): Promise<VoiceInferenceRuntimeSynthesizeResult> {
    const chunks: Buffer[] = [];
    let nextChunkIndex = 0;
    return await request(
      (id) => ({
        kind: 'synthesize',
        id,
        requestId: input.requestId,
        text: input.text,
        packId: input.packId,
        packDir: input.packDir,
        manifest: input.manifest,
        runtimeDescriptor: input.runtimeDescriptor,
        supportArtifacts: input.supportArtifacts,
        voiceId: input.voiceId,
        speed: input.speed,
        output: input.output,
      }),
      (frame) => {
        if (frame.kind !== 'result' || frame.result.kind !== 'synthesize') {
          throw createVoiceInferenceError('internal_error', 'voice_inference_worker_unexpected_result');
        }
        // Prefer the streamed chunks (chunked TTS); fall back to the inline result bytes.
        const inline = Buffer.from(frame.result.bytesBase64, 'base64');
        const streamed = chunks.length > 0 ? Buffer.concat(chunks) : inline;
        return {
          bytes: streamed,
          output: frame.result.output,
          name: frame.result.name,
        };
      },
      {
        signal: input.signal,
        onPartial: (partial) => {
          if (partial.partialKind === 'tts') {
            if (partial.index !== nextChunkIndex || partial.index >= MAX_TTS_PARTIAL_CHUNKS) {
              throw createVoiceInferenceError('internal_error', 'voice_inference_worker_invalid_tts_partial');
            }
            chunks.push(Buffer.from(partial.chunkBase64, 'base64'));
            nextChunkIndex += 1;
          }
        },
      },
    );
  }

  async function transcribeAudio(
    input: VoiceInferenceRuntimeTranscribeInput,
  ): Promise<VoiceInferenceRuntimeTranscribeResult> {
    return await request(
      (id) => ({
        kind: 'transcribe',
        id,
        requestId: input.requestId,
        filePath: input.filePath,
        inputMimeType: input.inputMimeType,
        packId: input.packId,
        packDir: input.packDir,
        manifest: input.manifest,
        runtimeDescriptor: input.runtimeDescriptor,
        supportArtifacts: input.supportArtifacts,
        language: input.language,
        normalization: input.normalization,
      }),
      (frame) => {
        if (frame.kind !== 'result' || frame.result.kind !== 'transcribe') {
          throw createVoiceInferenceError('internal_error', 'voice_inference_worker_unexpected_result');
        }
        return { text: frame.result.text, language: frame.result.language };
      },
      { signal: input.signal },
    );
  }

  async function createStreamingTranscriptionSession(
    input: VoiceInferenceRuntimeCreateStreamingTranscriptionSessionInput,
  ): Promise<VoiceInferenceStreamingTranscriptionSession> {
    const started = await request(
      (id) => ({
        kind: 'stt_stream_start',
        id,
        requestId: input.requestId,
        packId: input.packId,
        packDir: input.packDir,
        manifest: input.manifest,
        runtimeDescriptor: input.runtimeDescriptor,
        supportArtifacts: input.supportArtifacts,
        language: input.language,
        format: input.format,
      }),
      (frame) => {
        if (frame.kind !== 'result' || frame.result.kind !== 'stt_stream_start') {
          throw createVoiceInferenceError('internal_error', 'voice_inference_worker_unexpected_result');
        }
        return { sessionId: frame.result.sessionId };
      },
      { signal: input.signal },
    );

    let closed = false;
    let closePromise: Promise<void> | null = null;

    const closeWorkerSession = async (): Promise<void> => {
      if (closed) {
        return;
      }
      if (closePromise) {
        return await closePromise;
      }
      closePromise = request(
        (id) => ({ kind: 'stt_stream_cancel', id, sessionId: started.sessionId }),
        (frame) => {
          if (frame.kind !== 'result' || frame.result.kind !== 'stt_stream_cancel') {
            throw createVoiceInferenceError('internal_error', 'voice_inference_worker_unexpected_result');
          }
          return undefined;
        },
        // Cleanup must outlive the stream's caller-owned lifetime signal. The
        // request remains bounded by the forked-client request/watchdog policy.
      ).finally(() => {
        closed = true;
      });
      return await closePromise;
    };

    if (input.signal?.aborted) {
      try {
        await closeWorkerSession();
      } catch (error) {
        // Cleanup transport failure already terminates the owning channel in request(). Preserve
        // cancellation as the caller-visible terminal outcome while retaining a debug breadcrumb.
        params.loggerDebug?.('[forkedVoiceInferenceClient] late stream creation cleanup failed', error);
      }
      throw createVoiceInferenceError('cancelled');
    }

    return {
      appendPcm16: async (appendInput) => {
        if (closed) {
          throw createVoiceInferenceError('cancelled', 'voice_inference_stream_closed');
        }
        return await request(
          (id) => ({
            kind: 'stt_stream_append',
            id,
            sessionId: started.sessionId,
            seq: appendInput.seq,
            pcm16Base64: Buffer.from(appendInput.pcm16Bytes).toString('base64'),
          }),
          (frame) => {
            if (frame.kind !== 'result' || frame.result.kind !== 'stt_stream_append') {
              throw createVoiceInferenceError('internal_error', 'voice_inference_worker_unexpected_result');
            }
            return { events: frame.result.events };
          },
          { signal: appendInput.signal },
        );
      },
      finish: async (finishInput) => {
        if (closed) {
          throw createVoiceInferenceError('cancelled', 'voice_inference_stream_closed');
        }
        try {
          return await request(
            (id) => ({
              kind: 'stt_stream_finish',
              id,
              sessionId: started.sessionId,
              finalSeq: finishInput.finalSeq,
            }),
            (frame) => {
              if (frame.kind !== 'result' || frame.result.kind !== 'stt_stream_finish') {
                throw createVoiceInferenceError('internal_error', 'voice_inference_worker_unexpected_result');
              }
              return {
                text: frame.result.text,
                language: frame.result.language,
                events: frame.result.events,
              };
            },
            { signal: finishInput.signal },
          );
        } finally {
          closed = true;
        }
      },
      cancel: async () => {
        await closeWorkerSession();
      },
      close: async () => {
        await closeWorkerSession();
      },
    };
  }

  return {
    warmModel,
    primeModel,
    releaseModel,
    synthesizeTts,
    transcribeAudio,
    createStreamingTranscriptionSession,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      supervisor.markStopRequested({ reason: 'shutdown', requestedAtMs: Date.now() });
      disarmPingWatchdog();
      const channel = activeChannel;
      activeChannel = null;
      rejectChannelReady?.(createVoiceInferenceError('runtime_unavailable', 'voice_inference_worker_stopped'));
      channelReady = null;
      resolveChannelReady = null;
      rejectChannelReady = null;
      failAllPending(createVoiceInferenceError('runtime_unavailable', 'voice_inference_worker_stopped'));
      if (channel) {
        try {
          channel.terminate();
        } catch {
          // best-effort
        }
        await channel.waitForTermination().catch(() => undefined);
      }
      supervisor.dispose();
    },
  };
}
