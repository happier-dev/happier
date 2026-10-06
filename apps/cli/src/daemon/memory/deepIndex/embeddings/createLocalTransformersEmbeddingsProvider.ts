import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/codexAcp';
import type { MemoryEmbeddingsLocalTransformersConfig } from '@happier-dev/protocol';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import {
  createInferenceRuntimeLoader,
  readInferenceRuntimeModuleFieldWithRecoverableRetry,
  type InferenceRuntimeLoader,
  type InferenceRuntimeModule,
} from '@/daemon/inference/inferenceRuntimeLoader';

import type { EmbeddingsProvider } from './embeddingsProviderTypes';
import { tensorToVectors } from './tensorToVectors';

type TransformersModule = InferenceRuntimeModule & {
  env?: unknown;
  pipeline?: unknown;
};

type ImportTransformersModuleDependencies = Readonly<{
  packageImport: () => Promise<TransformersModule>;
  runtimeImport: (moduleUrl: string) => Promise<TransformersModule>;
  runtimeAssetExists: (path: string) => boolean;
}>;

function isTransformersModuleResolutionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes("Cannot find module '@huggingface/transformers'") || message.includes("Cannot find package '@huggingface/transformers'")) {
    return true;
  }

  return (
    message.includes('Cannot find package') &&
    message.includes('/@huggingface/transformers/dist/transformers.node.mjs')
  );
}

function isRecoverableTransformersRuntimeFailure(error: unknown): boolean {
  if (isTransformersModuleResolutionFailure(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes("Cannot access 'env' before initialization") ||
    message.includes("Cannot access 'pipeline' before initialization")
  );
}

function resolveRuntimeTransformersLoaderPath(): string {
  return resolveCliRuntimeAssetPath('scripts', 'runtime', 'loadTransformersFromRuntime.mjs');
}

function resolveRuntimeTransformersModulePath(): string {
  return resolveCliRuntimeAssetPath(
    'node_modules',
    '@huggingface',
    'transformers',
    'dist',
    'transformers.node.mjs',
  );
}

function resolveRuntimeTransformersImportUrls(runtimeAssetExists: (path: string) => boolean): string[] {
  const candidates = [resolveRuntimeTransformersLoaderPath(), resolveRuntimeTransformersModulePath()];
  return candidates
    .filter((candidate, index, all) => runtimeAssetExists(candidate) && all.indexOf(candidate) === index)
    .map((candidate) => pathToFileURL(candidate).href);
}

function createTransformersModuleLoader<T>(
  consumeModule: (mod: TransformersModule) => Promise<T>,
  deps?: Partial<ImportTransformersModuleDependencies>,
): InferenceRuntimeLoader<T> {
  const packageImport = deps?.packageImport ?? (async () => await import('@huggingface/transformers'));
  const runtimeImport =
    deps?.runtimeImport ??
    (async (moduleUrl: string) => await new Function('moduleUrl', 'return import(moduleUrl)')(moduleUrl));
  const runtimeAssetExists = deps?.runtimeAssetExists ?? existsSync;
  const runtimeImportUrls = resolveRuntimeTransformersImportUrls(runtimeAssetExists);

  return createInferenceRuntimeLoader<T>({
    resolveCandidates: () => [
      async () => await consumeModule(await packageImport()),
      ...runtimeImportUrls.map((moduleUrl) => async () =>
        await consumeModule(await runtimeImport(moduleUrl))),
    ],
    isRecoverableLoadError: isRecoverableTransformersRuntimeFailure,
    onRecoverableExhaustion: async () => {
      const { ensureOptionalRuntime } = await import('@/packagedRuntime/installables/optionalRuntimes');
      const managedModule = await ensureOptionalRuntime(INSTALLABLE_KEYS.LOCAL_EMBEDDINGS);
      return await consumeModule(await runtimeImport(pathToFileURL(managedModule).href));
    },
  });
}

export async function importTransformersModuleWithFallback(
  deps?: Partial<ImportTransformersModuleDependencies>,
): Promise<TransformersModule> {
  return await createTransformersModuleLoader(async (mod) => mod, deps).load('huggingface-transformers');
}

function applyCacheDir(env: unknown, cacheDir: string): void {
  if (!env || typeof env !== 'object' || !cacheDir.trim()) return;
  (env as { cacheDir?: string }).cacheDir = cacheDir;
}

async function readTransformersModuleFieldWithRecoverableRetry<T>(
  mod: TransformersModule,
  field: 'env' | 'pipeline',
): Promise<Readonly<{ value: T | null; error: unknown | null }>> {
  return await readInferenceRuntimeModuleFieldWithRecoverableRetry<T>({
    mod,
    field,
    isRecoverableRuntimeError: isRecoverableTransformersRuntimeFailure,
  });
}

async function createFeatureExtractionPipelineFromModule(params: Readonly<{
  mod: TransformersModule;
  modelId: string;
  cacheDir: string;
}>): Promise<any> {
  const { value: env, error: envAccessError } = await readTransformersModuleFieldWithRecoverableRetry<unknown>(params.mod, 'env');
  applyCacheDir(env, params.cacheDir);
  const { value: pipeline, error: pipelineAccessError } = await readTransformersModuleFieldWithRecoverableRetry<any>(params.mod, 'pipeline');
  if (typeof pipeline !== 'function') {
    if (pipelineAccessError) {
      throw pipelineAccessError;
    }
    throw new Error('transformers pipeline is unavailable');
  }
  try {
    return await pipeline('feature-extraction', params.modelId);
  } catch (error) {
    if (pipelineAccessError && isRecoverableTransformersRuntimeFailure(pipelineAccessError)) {
      throw pipelineAccessError;
    }
    if (envAccessError && isRecoverableTransformersRuntimeFailure(envAccessError)) {
      throw envAccessError;
    }
    throw error;
  }
}

export async function createFeatureExtractionPipelineWithFallback(params: Readonly<{
  modelId: string;
  cacheDir: string;
  packageImport?: () => Promise<TransformersModule>;
  runtimeImport?: (moduleUrl: string) => Promise<TransformersModule>;
  runtimeAssetExists?: (path: string) => boolean;
}>): Promise<any> {
  return await createTransformersModuleLoader(
    async (mod) => await createFeatureExtractionPipelineFromModule({
      mod,
      modelId: params.modelId,
      cacheDir: params.cacheDir,
    }),
    params,
  ).load('huggingface-transformers');
}

function applyPrefix(text: string, prefix: string | null | undefined): string {
  const trimmed = String(text ?? '').trim();
  const normalizedPrefix = typeof prefix === 'string' ? prefix.trim() : '';
  if (!normalizedPrefix) return trimmed;
  return `${normalizedPrefix}${trimmed}`;
}

export async function createLocalTransformersEmbeddingsProvider(params: Readonly<{
  config: MemoryEmbeddingsLocalTransformersConfig;
  cacheDir: string;
}>): Promise<EmbeddingsProvider> {
  const extractor = await createFeatureExtractionPipelineWithFallback({
    modelId: params.config.modelId,
    cacheDir: params.cacheDir,
  });

  return {
    providerKind: 'local_transformers',
    modelId: params.config.modelId,
    embedDocuments: async (texts, signal) => {
      signal?.throwIfAborted();
      const clean = texts.map((text) => applyPrefix(text, params.config.documentPrefix));
      if (clean.length === 0) return [];
      const out = await extractor(clean, { pooling: 'mean', normalize: true });
      signal?.throwIfAborted();
      return await tensorToVectors(out as { tolist?: () => any; data?: unknown; dims?: unknown }, clean.length);
    },
    embedQuery: async (text, signal) => {
      signal?.throwIfAborted();
      const out = await extractor(applyPrefix(text, params.config.queryPrefix), { pooling: 'mean', normalize: true });
      signal?.throwIfAborted();
      const rows = await tensorToVectors(out as { tolist?: () => any; data?: unknown; dims?: unknown }, 1);
      if (!rows[0]) throw new Error('No embedding produced');
      return rows[0];
    },
  };
}
