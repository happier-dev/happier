import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { MemoryEmbeddingsLocalTransformersConfig } from '@happier-dev/protocol';

import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';

import type { EmbeddingsProvider } from './embeddingsProviderTypes';
import { tensorToVectors } from './tensorToVectors';

type TransformersModule = {
  env?: unknown;
  pipeline?: unknown;
};

type ImportTransformersModuleDependencies = Readonly<{
  packageImport: () => Promise<TransformersModule>;
  runtimeImport: (moduleUrl: string) => Promise<TransformersModule>;
  runtimeAssetExists: (path: string) => boolean;
}>;

type CreateFeatureExtractionPipelineDependencies = Partial<ImportTransformersModuleDependencies>;

function isTransformersModuleResolutionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes("Cannot find module '@huggingface/transformers'")) {
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

async function importRuntimeTransformersModule(params: Readonly<{
  runtimeImport: (moduleUrl: string) => Promise<TransformersModule>;
  runtimeImportUrls: readonly string[];
  originalError: unknown;
}>): Promise<TransformersModule> {
  let lastError = params.originalError;
  for (const moduleUrl of params.runtimeImportUrls) {
    try {
      return await params.runtimeImport(moduleUrl);
    } catch (error) {
      lastError = error;
      if (!isRecoverableTransformersRuntimeFailure(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

export async function importTransformersModuleWithFallback(
  deps?: Partial<ImportTransformersModuleDependencies>,
): Promise<TransformersModule> {
  const packageImport = deps?.packageImport ?? (async () => await import('@huggingface/transformers'));
  const runtimeImport =
    deps?.runtimeImport ??
    (async (moduleUrl: string) => await new Function('moduleUrl', 'return import(moduleUrl)')(moduleUrl));
  const runtimeAssetExists = deps?.runtimeAssetExists ?? existsSync;
  const runtimeImportUrls = resolveRuntimeTransformersImportUrls(runtimeAssetExists);

  try {
    return await packageImport();
  } catch (error) {
    if (!isRecoverableTransformersRuntimeFailure(error)) throw error;
    return await importRuntimeTransformersModule({
      runtimeImport,
      runtimeImportUrls,
      originalError: error,
    });
  }
}

function applyCacheDir(env: unknown, cacheDir: string): void {
  if (!env || typeof env !== 'object' || !cacheDir.trim()) return;
  (env as { cacheDir?: string }).cacheDir = cacheDir;
}

async function readTransformersModuleFieldWithRecoverableRetry<T>(
  mod: TransformersModule,
  field: 'env' | 'pipeline',
): Promise<Readonly<{ value: T | null; error: unknown | null }>> {
  try {
    return { value: (mod as Record<string, T | null | undefined>)?.[field] ?? null, error: null };
  } catch (error) {
    if (!isRecoverableTransformersRuntimeFailure(error)) {
      throw error;
    }
    await Promise.resolve();
    try {
      return { value: (mod as Record<string, T | null | undefined>)?.[field] ?? null, error: null };
    } catch (retryError) {
      if (!isRecoverableTransformersRuntimeFailure(retryError)) {
        throw retryError;
      }
      return { value: null, error: retryError };
    }
  }
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

async function createFeatureExtractionPipelineFromRuntimeCandidates(params: Readonly<{
  runtimeImport: (moduleUrl: string) => Promise<TransformersModule>;
  runtimeImportUrls: readonly string[];
  modelId: string;
  cacheDir: string;
  originalError: unknown;
}>): Promise<any> {
  let lastError = params.originalError;
  for (const moduleUrl of params.runtimeImportUrls) {
    try {
      const runtimeModule = await params.runtimeImport(moduleUrl);
      return await createFeatureExtractionPipelineFromModule({
        mod: runtimeModule,
        modelId: params.modelId,
        cacheDir: params.cacheDir,
      });
    } catch (error) {
      lastError = error;
      if (!isRecoverableTransformersRuntimeFailure(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

export async function createFeatureExtractionPipelineWithFallback(params: Readonly<{
  modelId: string;
  cacheDir: string;
  packageImport?: () => Promise<TransformersModule>;
  runtimeImport?: (moduleUrl: string) => Promise<TransformersModule>;
  runtimeAssetExists?: (path: string) => boolean;
}>): Promise<any> {
  const runtimeImport =
    params.runtimeImport ??
    (async (moduleUrl: string) => await new Function('moduleUrl', 'return import(moduleUrl)')(moduleUrl));
  const runtimeAssetExists = params.runtimeAssetExists ?? existsSync;
  const runtimeImportUrls = resolveRuntimeTransformersImportUrls(runtimeAssetExists);

  try {
    const mod = await importTransformersModuleWithFallback({
      ...(params.packageImport ? { packageImport: params.packageImport } : {}),
      ...(params.runtimeImport ? { runtimeImport } : {}),
      ...(params.runtimeAssetExists ? { runtimeAssetExists } : {}),
    });
    return await createFeatureExtractionPipelineFromModule({
      mod,
      modelId: params.modelId,
      cacheDir: params.cacheDir,
    });
  } catch (error) {
    if (!isRecoverableTransformersRuntimeFailure(error) || runtimeImportUrls.length === 0) throw error;
    return await createFeatureExtractionPipelineFromRuntimeCandidates({
      runtimeImport,
      runtimeImportUrls,
      modelId: params.modelId,
      cacheDir: params.cacheDir,
      originalError: error,
    });
  }
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
    embedDocuments: async (texts) => {
      const clean = texts.map((text) => applyPrefix(text, params.config.documentPrefix));
      if (clean.length === 0) return [];
      const out = await extractor(clean, { pooling: 'mean', normalize: true });
      return await tensorToVectors(out as { tolist?: () => any; data?: unknown; dims?: unknown }, clean.length);
    },
    embedQuery: async (text) => {
      const out = await extractor(applyPrefix(text, params.config.queryPrefix), { pooling: 'mean', normalize: true });
      const rows = await tensorToVectors(out as { tolist?: () => any; data?: unknown; dims?: unknown }, 1);
      if (!rows[0]) throw new Error('No embedding produced');
      return rows[0];
    },
  };
}
