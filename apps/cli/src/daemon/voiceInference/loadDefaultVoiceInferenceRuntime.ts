import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createInferenceRuntimeLoader } from '@/daemon/inference/inferenceRuntimeLoader';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

import type {
  VoiceInferenceRuntime,
  VoiceInferenceRuntimeEngine,
  VoiceInferenceRuntimeTranscribeInput,
} from './voiceInferenceRuntimeTypes';
import {
  createRuntimeUnavailableError,
  createVoiceInferenceError,
  isVoiceInferenceWavMimeType,
} from './voiceInferenceWorker.shared';
import {
  readVoiceInferenceRuntimeModuleOverride,
} from './voiceInferenceWorkerConfig';
import { validateDaemonVoiceInferenceAudioInput } from './validateDaemonVoiceInferenceAudioInput';

function isRuntimeShape(value: unknown): value is VoiceInferenceRuntime {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof (value as VoiceInferenceRuntime).synthesizeTts === 'function'
      && typeof (value as VoiceInferenceRuntime).transcribeAudio === 'function',
  );
}

function resolveImportSpecifier(specifier: string): string {
  const trimmed = specifier.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith('file://')) {
    return trimmed;
  }
  if (trimmed.startsWith('.') || isAbsolute(trimmed)) {
    return pathToFileURL(isAbsolute(trimmed) ? trimmed : resolvePath(trimmed)).href;
  }
  return trimmed;
}

function isModuleResolutionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('Cannot find module')
    || message.includes('Cannot find package')
    || message.includes('ERR_MODULE_NOT_FOUND')
  );
}

function resolvePackagedVoiceInferenceImportSpecifiers(): string[] {
  const bootstrapRuntimePath = resolveCliRuntimeAssetPath('scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');
  if (existsSync(bootstrapRuntimePath)) {
    // If the bootstrap script exists, it is the canonical deferred-runtime gate. Do not bypass it
    // by importing the packaged runtime module directly.
    return [pathToFileURL(bootstrapRuntimePath).href];
  }

  const directRuntimePath = resolveCliRuntimeAssetPath(
    'package-dist',
    'daemon',
    'voiceInference',
    'runtime',
    'packagedVoiceInferenceRuntime.mjs',
  );
  if (existsSync(directRuntimePath)) {
    return [pathToFileURL(directRuntimePath).href];
  }

  return [];
}

async function importPackagedVoiceInferenceModule(): Promise<unknown | null> {
  const loader = createInferenceRuntimeLoader<unknown | null>({
    resolveCandidates: () =>
      resolvePackagedVoiceInferenceImportSpecifiers().map(
        (specifier) => async () => await import(specifier),
      ),
    isRecoverableLoadError: () => true,
    onNoCandidates: async () => null,
    onRecoverableExhaustion: async ({ lastError }) => {
      throw createRuntimeUnavailableError(lastError);
    },
  });
  return await loader.load('voice-inference-packaged-runtime');
}

function resolveDirectRuntime(moduleExports: unknown): VoiceInferenceRuntime | null {
  const candidates = [
    (moduleExports as { default?: unknown } | null)?.default,
    (moduleExports as { voiceInferenceRuntime?: unknown } | null)?.voiceInferenceRuntime,
    ((moduleExports as { default?: { voiceInferenceRuntime?: unknown } } | null)?.default)?.voiceInferenceRuntime,
    moduleExports,
  ];
  for (const candidate of candidates) {
    if (isRuntimeShape(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveRuntimeEngine(moduleExports: unknown): VoiceInferenceRuntimeEngine | null {
  const candidates = [
    (moduleExports as { voiceInferenceRuntimeEngine?: unknown } | null)?.voiceInferenceRuntimeEngine,
    ((moduleExports as { default?: { voiceInferenceRuntimeEngine?: unknown } } | null)?.default)?.voiceInferenceRuntimeEngine,
  ];
  for (const candidate of candidates) {
    if (isRuntimeShape(candidate)) {
      return candidate as VoiceInferenceRuntimeEngine;
    }
  }
  return null;
}

async function importConfiguredVoiceInferenceModule(): Promise<unknown | null> {
  const loader = createInferenceRuntimeLoader<unknown | null>({
    resolveCandidates: () => {
      const overrideSpecifier = readVoiceInferenceRuntimeModuleOverride();
      if (!overrideSpecifier) {
        return [];
      }
      return [async () => await import(resolveImportSpecifier(overrideSpecifier))];
    },
    isRecoverableLoadError: isModuleResolutionFailure,
    onNoCandidates: async () => null,
    onRecoverableExhaustion: async () => null,
  });
  return await loader.load('voice-inference-override-runtime');
}

async function normalizeRuntimeTranscribeInput(
  engine: VoiceInferenceRuntimeEngine,
  input: VoiceInferenceRuntimeTranscribeInput,
): Promise<Readonly<{ input: VoiceInferenceRuntimeTranscribeInput; cleanupFilePath: string | null }>> {
  const validatedInput = await validateDaemonVoiceInferenceAudioInput({
    filePath: input.filePath,
    inputMimeType: input.inputMimeType,
    normalization: input.normalization,
  });

  if (validatedInput.normalization.strategy !== 'daemon_decode' || isVoiceInferenceWavMimeType(validatedInput.inputMimeType)) {
    return {
      input: {
        ...input,
        filePath: validatedInput.filePath,
        inputMimeType: validatedInput.inputMimeType,
        normalization: validatedInput.normalization,
      },
      cleanupFilePath: null,
    };
  }

  if (typeof engine.decodeAudioInput !== 'function') {
    throw createVoiceInferenceError('unsupported_codec', 'voice_inference_daemon_decoder_unavailable');
  }

  const decodedInput = await engine.decodeAudioInput({
    ...input,
    filePath: validatedInput.filePath,
    inputMimeType: validatedInput.inputMimeType,
    normalization: validatedInput.normalization,
  });
  const cleanupFilePath = decodedInput.filePath !== input.filePath ? decodedInput.filePath : null;
  try {
    const validatedDecodedInput = await validateDaemonVoiceInferenceAudioInput({
      filePath: decodedInput.filePath,
      inputMimeType: decodedInput.inputMimeType,
      normalization: {
        inputTransport: input.normalization.inputTransport,
        strategy: 'ui_pretranscoded_pcm16_fallback',
        systemFfmpegAllowed: false,
      },
    });

    return {
      input: {
        ...input,
        filePath: validatedDecodedInput.filePath,
        inputMimeType: validatedDecodedInput.inputMimeType,
        normalization: validatedDecodedInput.normalization,
      },
      cleanupFilePath,
    };
  } catch (error) {
    if (cleanupFilePath) {
      await rm(cleanupFilePath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function createRuntimeFromEngine(engine: VoiceInferenceRuntimeEngine): VoiceInferenceRuntime {
  return {
    ...(engine.warmModel ? { warmModel: engine.warmModel } : {}),
    ...(engine.primeModel ? { primeModel: engine.primeModel } : {}),
    ...(engine.releaseModel ? { releaseModel: engine.releaseModel } : {}),
    ...(engine.createStreamingTranscriptionSession
      ? { createStreamingTranscriptionSession: engine.createStreamingTranscriptionSession }
      : {}),
    synthesizeTts: async (input) => await engine.synthesizeTts(input),
    transcribeAudio: async (input) => {
      const normalizedInput = await normalizeRuntimeTranscribeInput(engine, input);
      try {
        return await engine.transcribeAudio(normalizedInput.input);
      } finally {
        if (normalizedInput.cleanupFilePath) {
          await rm(normalizedInput.cleanupFilePath, { force: true }).catch(() => undefined);
        }
      }
    },
  };
}

export async function loadDefaultVoiceInferenceRuntime(): Promise<VoiceInferenceRuntime | null> {
  const configuredModuleExports = await importConfiguredVoiceInferenceModule();
  const packagedModuleExports = configuredModuleExports ? null : await importPackagedVoiceInferenceModule();
  const moduleExports = configuredModuleExports ?? packagedModuleExports;
  if (!moduleExports) {
    return null;
  }

  const directRuntime = resolveDirectRuntime(moduleExports);
  if (directRuntime) {
    return directRuntime;
  }

  const runtimeEngine = resolveRuntimeEngine(moduleExports);
  if (runtimeEngine) {
    return createRuntimeFromEngine(runtimeEngine);
  }

  if (packagedModuleExports) {
    throw createVoiceInferenceError('runtime_unavailable', 'voice_inference_runtime_unavailable');
  }
  throw createVoiceInferenceError('runtime_invalid', 'voice_inference_runtime_invalid');
}
