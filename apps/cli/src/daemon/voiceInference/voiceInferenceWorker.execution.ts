import { randomUUID } from 'node:crypto';
import { lstat, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import {
  DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH,
} from '@happier-dev/protocol';
import type {
  DaemonVoiceInferenceAudioOutput,
  DaemonVoiceInferenceNormalizationDecision,
} from '@happier-dev/protocol';

import { createInferenceDiagnostics, createUnavailableInferenceDiagnostics } from '@/daemon/inference/inferenceDiagnostics';

import { validateDaemonVoiceInferenceAudioInput } from './validateDaemonVoiceInferenceAudioInput';
import {
  createVoiceInferenceError,
  normalizePackId,
  readVoiceInferenceErrorCode,
  resolveVoiceInferenceOutputExtension,
  shouldPreserveHealthyDiagnostics,
} from './voiceInferenceWorker.shared';
import type { VoiceInferenceWorkerLifecycleContext } from './voiceInferenceWorker.lifecycle';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';

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
  cancelStt: (requestId: string) => Promise<void>;
}>;

type VoiceInferenceExecutionDeps = Readonly<{
  lifecycle: VoiceInferenceWorkerLifecycleContext;
}>;

export function createVoiceInferenceWorkerExecution(params: VoiceInferenceExecutionDeps): Readonly<VoiceInferenceWorkerExecutionHandle & Readonly<{ abortAllRequests: () => Promise<void> }>> {
  const paths = resolveVoiceInferencePaths();
  const ttsAbortControllerByRequestId = new Map<string, AbortController>();
  const sttAbortControllerByRequestId = new Map<string, AbortController>();

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

  function assertValidRequestId(requestId: string): void {
    if (
      requestId.trim().length === 0
      || requestId.length > DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH
    ) {
      throw createVoiceInferenceError('internal_error', 'voice_inference_invalid_request_id');
    }
  }

  function registerRequestAbortController(
    requestAbortControllerById: Map<string, AbortController>,
    requestId: string,
    abortController: AbortController,
  ): () => void {
    if (requestAbortControllerById.has(requestId)) {
      throw createVoiceInferenceError('internal_error', 'voice_inference_duplicate_request_id');
    }
    requestAbortControllerById.set(requestId, abortController);
    return () => {
      if (requestAbortControllerById.get(requestId) === abortController) {
        requestAbortControllerById.delete(requestId);
      }
    };
  }

  function linkAbortSignal(signal: AbortSignal | null | undefined, abortController: AbortController): () => void {
    if (!signal) {
      return () => {};
    }
    const abortListener = () => abortController.abort();
    signal.addEventListener('abort', abortListener, { once: true });
    return () => signal.removeEventListener('abort', abortListener);
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
    for (const controller of ttsAbortControllerByRequestId.values()) {
      controller.abort();
    }
    for (const controller of sttAbortControllerByRequestId.values()) {
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
      const unregisterRequest = registerRequestAbortController(ttsAbortControllerByRequestId, requestId, abortController);
      try {
        return await params.lifecycle.runExclusive(normalizedPackId, async () => {
          return await runWithRuntimeErrorHandling(async () => {
            const { runtime, packDir, manifest } = await params.lifecycle.warmRuntimeForPack(normalizedPackId, abortController.signal);
            const synthesized = await runtime.synthesizeTts({
              requestId,
              text,
              packId: normalizedPackId,
              packDir,
              manifest,
              voiceId,
              speed,
              output,
              signal: abortController.signal,
            });
            if (
              synthesized.output.codec !== output.codec
              || synthesized.output.mimeType !== output.mimeType
            ) {
              throw createVoiceInferenceError('unsupported_codec', 'voice_inference_output_codec_not_supported');
            }
            const fallbackFileName = `voice-inference-${requestId}.${resolveVoiceInferenceOutputExtension(synthesized.output)}`;
            const fileName = sanitizeOutputFileName(
              typeof synthesized.name === 'string' ? synthesized.name : '',
              fallbackFileName,
            );
            const safeRequestId = sanitizeOpaqueIdForFileName(requestId, 'request');
            const filePath = join(paths.tempDir, `${safeRequestId}-${randomUUID()}-${fileName}`);
            await writeFile(filePath, synthesized.bytes);
            return {
              requestId,
              output: synthesized.output,
              filePath,
              sizeBytes: synthesized.bytes.byteLength,
              name: fileName,
            };
          });
        });
      } catch (error) {
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
      ttsAbortControllerByRequestId.get(requestId)?.abort();
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
      const unregisterRequest = registerRequestAbortController(sttAbortControllerByRequestId, requestId, abortController);
      let cleanupFilePath: string | null = null;
      try {
        await assertTempUploadPath(filePath);
        cleanupFilePath = filePath;
        return await params.lifecycle.runExclusive(normalizedPackId, async () => {
          return await runWithRuntimeErrorHandling(async () => {
            const { runtime, packDir, manifest } = await params.lifecycle.warmRuntimeForPack(normalizedPackId, abortController.signal);
            const validatedInput = await validateDaemonVoiceInferenceAudioInput({
              filePath,
              inputMimeType,
              normalization: normalizationDecision,
            });
            const transcribed = await runtime.transcribeAudio({
              requestId,
              filePath: validatedInput.filePath,
              inputMimeType: validatedInput.inputMimeType,
              packId: normalizedPackId,
              packDir,
              manifest,
              language,
              normalization: validatedInput.normalization,
              signal: abortController.signal,
            });
            return {
              requestId,
              text: transcribed.text,
              language: transcribed.language,
              modelPackId: normalizedPackId,
            };
          });
        });
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
    cancelStt: async (requestId) => {
      sttAbortControllerByRequestId.get(requestId)?.abort();
    },
  };
}
