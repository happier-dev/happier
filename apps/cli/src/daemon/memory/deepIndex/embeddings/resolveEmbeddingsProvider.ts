import type { OperationalMemoryEmbeddingsSettings } from '@/daemon/memory/resolveOperationalMemoryEmbeddingsSettings';
import { logger } from '@/ui/logger';
import { createHash } from 'node:crypto';

import {
  createFeatureExtractionPipelineWithFallback,
  createLocalTransformersEmbeddingsProvider,
  importTransformersModuleWithFallback,
} from './createLocalTransformersEmbeddingsProvider';
import { createOpenAiCompatibleEmbeddingsProvider } from './createOpenAiCompatibleEmbeddingsProvider';
import type { EmbeddingsProviderResolution } from './embeddingsProviderTypes';

const providerCache = new Map<string, Promise<EmbeddingsProviderResolution>>();

function buildCacheKey(params: Readonly<{
  cacheDir: string;
  providerConfig: NonNullable<OperationalMemoryEmbeddingsSettings['providerConfig']> | null;
}>): string {
  const providerConfig = params.providerConfig;
  const providerConfigKey = (() => {
    if (!providerConfig) return null;
    if (providerConfig.kind === 'local_transformers') {
      return {
        kind: providerConfig.kind,
        modelId: providerConfig.modelId,
        queryPrefix: providerConfig.queryPrefix ?? null,
        documentPrefix: providerConfig.documentPrefix ?? null,
      };
    }

    const apiKeyMaterial =
      providerConfig.apiKey?.encryptedValue?.c ??
      providerConfig.apiKey?.value ??
      '';
    return {
      kind: providerConfig.kind,
      baseUrl: providerConfig.baseUrl ?? null,
      model: providerConfig.model,
      dimensions: providerConfig.dimensions ?? null,
      apiKeyHash: createHash('sha256').update(apiKeyMaterial).digest('hex'),
    };
  })();

  return JSON.stringify({
    cacheDir: params.cacheDir,
    providerConfig: providerConfigKey,
  });
}

function hasRequiredProviderConfig(
  providerConfig: NonNullable<OperationalMemoryEmbeddingsSettings['providerConfig']>,
): boolean {
  if (providerConfig.kind === 'local_transformers') {
    return String(providerConfig.modelId ?? '').trim().length > 0;
  }

  return (
    String(providerConfig.baseUrl ?? '').trim().length > 0 &&
    String(providerConfig.model ?? '').trim().length > 0 &&
    (
      String(providerConfig.apiKey?.value ?? '').trim().length > 0 ||
      String(providerConfig.apiKey?.encryptedValue?.c ?? '').trim().length > 0
    )
  );
}

export async function resolveEmbeddingsProvider(params: Readonly<{
  settings: OperationalMemoryEmbeddingsSettings | null;
  cacheDir: string;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
}>): Promise<EmbeddingsProviderResolution> {
  const settings = params.settings;
  if (!settings?.enabled || !settings.providerConfig || !settings.providerKind || !settings.modelId) {
    return {
      provider: null,
      mode: settings?.mode ?? 'disabled',
      presetId: settings?.presetId ?? null,
      providerKind: settings?.providerKind ?? null,
      modelId: settings?.modelId ?? null,
      runtimeState: 'unavailable',
      usingFallback: false,
    };
  }
  const providerConfig = settings.providerConfig!;
  const providerKind = settings.providerKind!;
  const modelId = settings.modelId!;
  if (!hasRequiredProviderConfig(providerConfig)) {
    return {
      provider: null,
      mode: settings.mode,
      presetId: settings.presetId,
      providerKind,
      modelId,
      runtimeState: 'unavailable',
      usingFallback: false,
    };
  }

  const cacheKey = buildCacheKey({
    cacheDir: params.cacheDir,
    providerConfig,
  });
  const cached = providerCache.get(cacheKey);
  if (cached) return await cached;

  const promise = (async (): Promise<EmbeddingsProviderResolution> => {
    try {
      const provider =
        providerConfig.kind === 'local_transformers'
          ? await createLocalTransformersEmbeddingsProvider({
            config: providerConfig,
            cacheDir: params.cacheDir,
          })
          : await createOpenAiCompatibleEmbeddingsProvider({
            config: providerConfig,
            settingsSecretsReadKeys: params.settingsSecretsReadKeys ?? [],
          });

      return {
        provider,
        mode: settings.mode,
        presetId: settings.presetId,
        providerKind: provider.providerKind,
        modelId: provider.modelId,
        runtimeState: 'ready',
        usingFallback: false,
      };
    } catch (error) {
      logger.debug('[memoryWorker] Embeddings provider init failed (best-effort)', {
        providerKind,
        modelId,
        message: error instanceof Error ? error.message : String(error),
      });
      providerCache.delete(cacheKey);
      return {
        provider: null,
        mode: settings.mode,
        presetId: settings.presetId,
        providerKind,
        modelId,
        runtimeState: 'error',
        usingFallback: true,
      };
    }
  })();

  providerCache.set(cacheKey, promise);
  return await promise;
}

export { importTransformersModuleWithFallback };
export { createFeatureExtractionPipelineWithFallback };

export function resetEmbeddingsProviderCacheForTests(): void {
  providerCache.clear();
}
