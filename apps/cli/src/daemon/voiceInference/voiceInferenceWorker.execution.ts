import { randomUUID } from 'node:crypto';
import { lstat, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import {
  DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH,
} from '@happier-dev/protocol';
import type {
  DaemonVoiceInferenceAudioOutput,
  DaemonVoiceInferenceNormalizationDecision,
  DaemonVoiceInferenceSttStreamPcmFormat,
} from '@happier-dev/protocol';

import { createInferenceDiagnostics, createUnavailableInferenceDiagnostics } from '@/daemon/inference/inferenceDiagnostics';

import { validateDaemonVoiceInferenceAudioInput } from './validateDaemonVoiceInferenceAudioInput';
import {
  createVoiceInferenceError,
  normalizePackId,
  readVoiceInferenceErrorCode,
  shouldPreserveHealthyDiagnostics,
} from './voiceInferenceWorker.shared';
import type { VoiceInferenceWorkerLifecycleContext } from './voiceInferenceWorker.lifecycle';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';
import type { VoiceInferenceStreamingTranscriptionSession } from './voiceInferenceRuntimeTypes';

export type VoiceInferenceWorkerStreamingTranscriptionSession = VoiceInferenceStreamingTranscriptionSession & Readonly<{
  modelPackId: string;
}>;

export type VoiceInferenceWorkerExecutionHandle = Readonly<{
  synthesizeTts: (input: Readonly<{
    requestId: string;
    text: string;
    packId: string | null;
    voiceId: string | null;
    speed: number | null;
    output: DaemonVoiceInferenceAudioOutput;
    signal?: AbortSignal | null;
  }>) => Promise<Readonly<{
    requestId: string;
    output: DaemonVoiceInferenceAudioOutput;
    filePath: string;
    sizeBytes: number;
    name: string;
  }>>;
  cancelTts: (requestId: string) => Promise<void>;
  transcribeAudio: (input: Readonly<{
    requestId: string;
    uploadId: string;
    filePath: string;
    inputMimeType: string;
    packId: string | null;
    language: string | null;
    normalization: DaemonVoiceInferenceNormalizationDecision;
    signal?: AbortSignal | null;
  }>) => Promise<Readonly<{
    requestId: string;
    text: string;
    language: string | null;
    modelPackId: string | null;
  }>>;
  createStreamingTranscriptionSession: (input: Readonly<{
    requestId: string;
    packId: string | null;
    language: string | null;
    format: DaemonVoiceInferenceSttStreamPcmFormat;
    signal?: AbortSignal | null;
  }>) => Promise<VoiceInferenceWorkerStreamingTranscriptionSession>;
  cancelStt: (requestId: string) => Promise<void>;
}>;

type VoiceInferenceExecutionDeps = Readonly<{
  lifecycle: VoiceInferenceWorkerLifecycleContext;
}>;

const MAX_PRE_CANCELLED_REQUEST_IDS = 2_048;

type RequestCancellationState = {
  abortControllerByRequestId: Map<string, AbortController>;
  preCancelledRequestIds: Map<string, number>;
  cancelSequence: number;
};

export function createVoiceInferenceWorkerExecution(params: VoiceInferenceExecutionDeps): Readonly<VoiceInferenceWorkerExecutionHandle & Readonly<{ abortAllRequests: () => Promise<void> }>> {
  const paths = resolveVoiceInferencePaths();
  const ttsCancellationState = createRequestCancellationState();
  const sttCancellationState = createRequestCancellationState();

  function createRequestCancellationState(): RequestCancellationState {
    return {
      abortControllerByRequestId: new Map<string, AbortController>(),
      preCancelledRequestIds: new Map<string, number>(),
      cancelSequence: 0,
    };
  }

  function sanitizeOutputFileName(candidate: string, fallback: string): string {
    // Ensure model/runtime-controlled names cannot escape the temp directory via `..` or separators.
    const trimmed = candidate.trim();
    if (!trimmed) return fallback;
    const lastPart = trimmed.split(/[\\/]/).pop() ?? '';
    const normalized = lastPart.trim();
    if (!normalized || normalized === '.' || normalized === '..') return fallback;
    return normalized;
  }

  function sanitizeOpaqueIdForFileName(candidate: string, fallback: string): string {
    // Ensure RPC-controlled ids cannot escape via `/`, `\\`, or absolute path patterns.
    const trimmed = candidate.trim();
    if (!trimmed) return fallback;
    const lastPart = trimmed.split(/[\\/]/).pop() ?? '';
    const normalized = lastPart.trim();
    if (!normalized || normalized === '.' || normalized === '..') return fallback;
    const safe = normalized.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64);
    return safe.length > 0 ? safe : fallback;
  }

  function isValidRequestId(requestId: string): boolean {
    return requestId.trim().length > 0
      && requestId.length <= DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH;
  }

  function assertValidRequestId(requestId: string): void {
    if (!isValidRequestId(requestId)) {
      throw createVoiceInferenceError('internal_error', 'voice_inference_invalid_request_id');
    }
  }

  function registerRequestAbortController(
    state: RequestCancellationState,
    requestId: string,
    abortController: AbortController,
  ): () => void {
    if (state.abortControllerByRequestId.has(requestId)) {
      throw createVoiceInferenceError('internal_error', 'voice_inference_duplicate_request_id');
    }
    if (state.preCancelledRequestIds.has(requestId)) {
      abortController.abort();
    }
    state.abortControllerByRequestId.set(requestId, abortController);
    return () => {
      if (state.abortControllerByRequestId.get(requestId) === abortController) {
        state.abortControllerByRequestId.delete(requestId);
      }
      state.preCancelledRequestIds.delete(requestId);
    };
  }

  function linkAbortSignal(signal: AbortSignal | null | undefined, abortController: AbortController): () => void {
    if (!signal) {
      return () => {};
    }
    if (signal.aborted) {
      abortController.abort();
      return () => {};
    }
    const abortListener = () => abortController.abort();
    signal.addEventListener('abort', abortListener, { once: true });
    return () => signal.removeEventListener('abort', abortListener);
  }

  function rememberCancelledRequest(state: RequestCancellationState, requestId: string): void {
    if (!isValidRequestId(requestId)) {
      return;
    }
    const abortController = state.abortControllerByRequestId.get(requestId);
    if (abortController) {
      abortController.abort();
      return;
    }
    state.cancelSequence += 1;
    state.preCancelledRequestIds.set(requestId, state.cancelSequence);
    while (state.preCancelledRequestIds.size > MAX_PRE_CANCELLED_REQUEST_IDS) {
      const oldestRequestId = state.preCancelledRequestIds.keys().next().value;
      if (typeof oldestRequestId !== 'string') {
        break;
      }
      state.preCancelledRequestIds.delete(oldestRequestId);
    }
  }

  function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (error: unknown) => void;
  }> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  async function assertTempUploadPath(filePath: string): Promise<void> {
    const resolvedTempDir = await realpath(paths.tempDir);
    const fileStats = await lstat(filePath).catch(() => {
      throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_invalid_upload_path');
    });
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_invalid_upload_path');
    }
    const resolvedFilePath = await realpath(filePath).catch(() => {
      throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_invalid_upload_path');
    });
    const rel = relative(resolvedTempDir, resolvedFilePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_invalid_upload_path');
    }
  }

  async function abortAllRequests(): Promise<void> {
    for (const controller of ttsCancellationState.abortControllerByRequestId.values()) {
      controller.abort();
    }
    for (const controller of sttCancellationState.abortControllerByRequestId.values()) {
      controller.abort();
    }
  }

  async function runWithRuntimeErrorHandling<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (readVoiceInferenceErrorCode(error) === 'runtime_unavailable') {
        params.lifecycle.setDiagnostics(createUnavailableInferenceDiagnostics());
        throw error;
      }
      if (!shouldPreserveHealthyDiagnostics(error)) {
        params.lifecycle.setDiagnostics(createInferenceDiagnostics({
          runtimeState: 'degraded',
          lastError: error instanceof Error ? error.message : String(error ?? ''),
        }));
      }
      throw error;
    }
  }

  return {
    abortAllRequests,
    synthesizeTts: async ({ requestId, text, packId, voiceId, speed, output, signal }) => {
      if (params.lifecycle.isStopped()) {
        throw createVoiceInferenceError('internal_error', 'voice_inference_worker_stopped');
      }
      assertValidRequestId(requestId);
      const normalizedPackId = normalizePackId(packId);
      if (!normalizedPackId) {
        throw createVoiceInferenceError('model_not_installed');
      }
      const abortController = new AbortController();
      const unlinkAbortSignal = linkAbortSignal(signal, abortController);
      const unregisterRequest = registerRequestAbortController(ttsCancellationState, requestId, abortController);
      let stagedOutputFilePath: string | null = null;
      try {
        if (abortController.signal.aborted) {
          throw createVoiceInferenceError('cancelled');
        }
        return await params.lifecycle.runExclusive(normalizedPackId, async () => {
          if (abortController.signal.aborted) {
            throw createVoiceInferenceError('cancelled');
          }
          return await runWithRuntimeErrorHandling(async () => {
            const { runtime, packDir, manifest, runtimeDescriptor, supportArtifacts } = await params.lifecycle.warmRuntimeForPack(normalizedPackId, abortController.signal);
            if (abortController.signal.aborted) {
              throw createVoiceInferenceError('cancelled');
            }
            const synthesized = await runtime.synthesizeTts({
              requestId,
              text,
              packId: normalizedPackId,
              packDir,
              manifest,
              runtimeDescriptor,
              supportArtifacts,
              voiceId,
              speed,
              output,
              signal: abortController.signal,
            });
            if (abortController.signal.aborted) {
              throw createVoiceInferenceError('cancelled');
            }
            if (
              synthesized.output.codec !== output.codec
              || synthesized.output.mimeType !== output.mimeType
            ) {
              throw createVoiceInferenceError('unsupported_codec', 'voice_inference_output_codec_not_supported');
            }
            const fallbackFileName = `voice-inference-${requestId}.wav`;
            const fileName = sanitizeOutputFileName(
              typeof synthesized.name === 'string' ? synthesized.name : '',
              fallbackFileName,
            );
            const safeRequestId = sanitizeOpaqueIdForFileName(requestId, 'request');
            const filePath = join(paths.tempDir, `${safeRequestId}-${randomUUID()}-${fileName}`);
            const synthesizedBytes = synthesized.bytes;
            stagedOutputFilePath = filePath;
            await writeFile(filePath, synthesizedBytes);
            if (abortController.signal.aborted) {
              throw createVoiceInferenceError('cancelled');
            }
            const result = {
              requestId,
              output: synthesized.output,
              filePath,
              sizeBytes: synthesizedBytes.byteLength,
              name: fileName,
            };
            stagedOutputFilePath = null;
            return result;
          });
        }, { signal: abortController.signal });
      } catch (error) {
        if (stagedOutputFilePath) {
          await rm(stagedOutputFilePath, { force: true }).catch(() => undefined);
        }
        if (abortController.signal.aborted) {
          throw createVoiceInferenceError('cancelled');
        }
        throw error;
      } finally {
        unlinkAbortSignal();
        unregisterRequest();
      }
    },
    cancelTts: async (requestId) => {
      rememberCancelledRequest(ttsCancellationState, requestId);
    },
    transcribeAudio: async ({ requestId, filePath, inputMimeType, packId, language, normalization: normalizationDecision, signal }) => {
      if (params.lifecycle.isStopped()) {
        throw createVoiceInferenceError('internal_error', 'voice_inference_worker_stopped');
      }
      assertValidRequestId(requestId);
      const normalizedPackId = normalizePackId(packId);
      if (!normalizedPackId) {
        throw createVoiceInferenceError('model_not_installed');
      }
      const abortController = new AbortController();
      const unlinkAbortSignal = linkAbortSignal(signal, abortController);
      const unregisterRequest = registerRequestAbortController(sttCancellationState, requestId, abortController);
      let cleanupFilePath: string | null = null;
      try {
        if (abortController.signal.aborted) {
          throw createVoiceInferenceError('cancelled');
        }
        await assertTempUploadPath(filePath);
        cleanupFilePath = filePath;
        if (abortController.signal.aborted) {
          throw createVoiceInferenceError('cancelled');
        }
        return await params.lifecycle.runExclusive(normalizedPackId, async () => {
          if (abortController.signal.aborted) {
            throw createVoiceInferenceError('cancelled');
          }
          return await runWithRuntimeErrorHandling(async () => {
            const { runtime, packDir, manifest, runtimeDescriptor, supportArtifacts } = await params.lifecycle.warmRuntimeForPack(normalizedPackId, abortController.signal);
            if (abortController.signal.aborted) {
              throw createVoiceInferenceError('cancelled');
            }
            const validatedInput = await validateDaemonVoiceInferenceAudioInput({
              filePath,
              inputMimeType,
              normalization: normalizationDecision,
            });
            if (abortController.signal.aborted) {
              throw createVoiceInferenceError('cancelled');
            }
            const transcribed = await runtime.transcribeAudio({
              requestId,
              filePath: validatedInput.filePath,
              inputMimeType: validatedInput.inputMimeType,
              packId: normalizedPackId,
              packDir,
              manifest,
              runtimeDescriptor,
              supportArtifacts,
              language,
              normalization: validatedInput.normalization,
              signal: abortController.signal,
            });
            if (abortController.signal.aborted) {
              throw createVoiceInferenceError('cancelled');
            }
            return {
              requestId,
              text: transcribed.text,
              language: transcribed.language,
              modelPackId: normalizedPackId,
            };
          });
        }, { signal: abortController.signal });
      } catch (error) {
        if (abortController.signal.aborted) {
          throw createVoiceInferenceError('cancelled');
        }
        throw error;
      } finally {
        unlinkAbortSignal();
        unregisterRequest();
        if (cleanupFilePath) {
          await rm(cleanupFilePath, { force: true }).catch(() => undefined);
        }
      }
    },
    createStreamingTranscriptionSession: async ({ requestId, packId, language, format, signal }) => {
      if (params.lifecycle.isStopped()) {
        throw createVoiceInferenceError('internal_error', 'voice_inference_worker_stopped');
      }
      assertValidRequestId(requestId);
      const normalizedPackId = normalizePackId(packId);
      if (!normalizedPackId) {
        throw createVoiceInferenceError('model_not_installed');
      }

      const abortController = new AbortController();
      const unlinkAbortSignal = linkAbortSignal(signal, abortController);
      const unregisterRequest = registerRequestAbortController(sttCancellationState, requestId, abortController);
      const ready = deferred<VoiceInferenceWorkerStreamingTranscriptionSession>();
      const closed = deferred<void>();
      let runtimeSession: VoiceInferenceStreamingTranscriptionSession | null = null;
      let closePromise: Promise<void> | null = null;

      const closeRuntimeSession = async (options?: Readonly<{ cancel?: boolean }>): Promise<void> => {
        const session = runtimeSession;
        if (!session) {
          // Creation may still be in flight. Do not memoize an empty cleanup: a late session must
          // remain eligible for the post-creation cancellation check below.
          return;
        }
        if (closePromise) {
          return await closePromise;
        }
        closePromise = (async () => {
          if (options?.cancel === true) {
            await session.cancel().catch(() => undefined);
          }
          await session.close().catch(() => undefined);
          closed.resolve();
        })();
        return await closePromise;
      };

      const abortListener = () => {
        void closeRuntimeSession({ cancel: true });
      };
      abortController.signal.addEventListener('abort', abortListener, { once: true });

      const releaseRequestOwnership = () => {
        abortController.signal.removeEventListener('abort', abortListener);
        unlinkAbortSignal();
        unregisterRequest();
      };

      const lease = params.lifecycle.runExclusive(normalizedPackId, async () => {
        try {
          if (abortController.signal.aborted) {
            throw createVoiceInferenceError('cancelled');
          }
          await runWithRuntimeErrorHandling(async () => {
            const { runtime, packDir, manifest, runtimeDescriptor, supportArtifacts } = await params.lifecycle.warmRuntimeForPack(normalizedPackId, abortController.signal);
            if (abortController.signal.aborted) {
              throw createVoiceInferenceError('cancelled');
            }
            if (typeof runtime.createStreamingTranscriptionSession !== 'function') {
              throw createVoiceInferenceError('runtime_unavailable', 'voice_inference_streaming_stt_unavailable');
            }
            runtimeSession = await runtime.createStreamingTranscriptionSession({
              requestId,
              packId: normalizedPackId,
              packDir,
              manifest,
              runtimeDescriptor,
              supportArtifacts,
              language,
              format,
              signal: abortController.signal,
            });
            if (abortController.signal.aborted) {
              await closeRuntimeSession({ cancel: true });
              throw createVoiceInferenceError('cancelled');
            }
            ready.resolve({
              modelPackId: normalizedPackId,
              appendPcm16: async (appendInput) => {
                if (abortController.signal.aborted) {
                  throw createVoiceInferenceError('cancelled');
                }
                const session = runtimeSession;
                if (!session) {
                  throw createVoiceInferenceError('runtime_unavailable', 'voice_inference_streaming_stt_unavailable');
                }
                const appended = await runWithRuntimeErrorHandling(async () => await session.appendPcm16({
                  ...appendInput,
                  signal: abortController.signal,
                }));
                if (abortController.signal.aborted) {
                  throw createVoiceInferenceError('cancelled');
                }
                return appended;
              },
              finish: async (finishInput) => {
                if (abortController.signal.aborted) {
                  throw createVoiceInferenceError('cancelled');
                }
                const session = runtimeSession;
                if (!session) {
                  throw createVoiceInferenceError('runtime_unavailable', 'voice_inference_streaming_stt_unavailable');
                }
                try {
                  const finished = await runWithRuntimeErrorHandling(async () => await session.finish({
                    ...finishInput,
                    signal: abortController.signal,
                  }));
                  if (abortController.signal.aborted) {
                    throw createVoiceInferenceError('cancelled');
                  }
                  return finished;
                } finally {
                  await closeRuntimeSession();
                }
              },
              cancel: async () => {
                abortController.abort();
                await closeRuntimeSession({ cancel: true });
              },
              close: async () => {
                await closeRuntimeSession();
              },
            });
          });
          await closed.promise;
        } catch (error) {
          ready.reject(error);
          throw error;
        }
      }, { signal: abortController.signal });
      void lease.then(
        () => releaseRequestOwnership(),
        (error) => {
          // The concurrency owner can reject a pre-aborted or queued lease before invoking
          // `work`. Settle the public readiness promise and release the request registration
          // from this outer lease boundary rather than relying on the callback's `finally`.
          ready.reject(error);
          releaseRequestOwnership();
        },
      );

      try {
        return await ready.promise;
      } catch (error) {
        await closeRuntimeSession({ cancel: true });
        if (abortController.signal.aborted) {
          throw createVoiceInferenceError('cancelled');
        }
        throw error;
      }
    },
    cancelStt: async (requestId) => {
      rememberCancelledRequest(sttCancellationState, requestId);
    },
  };
}
