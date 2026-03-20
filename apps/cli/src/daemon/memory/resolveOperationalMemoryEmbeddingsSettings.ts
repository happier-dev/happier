import {
  resolveMemoryEmbeddingsConfig,
  type MemoryEmbeddingsCustomConfig,
  type MemoryEmbeddingsMode,
  type MemoryEmbeddingsPresetId,
  type MemorySettingsV1,
} from '@happier-dev/protocol';

export type OperationalMemoryEmbeddingsDiagnostics = Readonly<{
  mode: MemoryEmbeddingsMode;
  presetId: MemoryEmbeddingsPresetId | null;
  providerKind: MemoryEmbeddingsCustomConfig['kind'] | null;
  modelId: string | null;
  runtimeState: 'ready' | 'downloading' | 'unavailable' | 'error';
  usingFallback: boolean;
}>;

export type OperationalMemoryEmbeddingsSettings = Readonly<{
  enabled: boolean;
  mode: MemoryEmbeddingsMode;
  presetId: MemoryEmbeddingsPresetId | null;
  providerKind: MemoryEmbeddingsCustomConfig['kind'] | null;
  modelId: string | null;
  blend: Readonly<{
    ftsWeight: number;
    embeddingWeight: number;
  }>;
  providerConfig: MemoryEmbeddingsCustomConfig | null;
}>;

export type OperationalDeepIndexEmbeddingsSettings = Readonly<{
  enabled: true;
  provider: MemoryEmbeddingsCustomConfig['kind'];
  modelId: string;
  wFts: number;
  wEmb: number;
}>;

export function resolveOperationalMemoryEmbeddingsSettings(
  embeddings: MemorySettingsV1['embeddings'],
): OperationalMemoryEmbeddingsSettings | null {
  const resolved = resolveMemoryEmbeddingsConfig(embeddings);
  if (!resolved.enabled || !resolved.provider) {
    return null;
  }

  const provider = resolved.provider;
  const modelId = provider.kind === 'local_transformers' ? provider.modelId : provider.model;

  return {
    enabled: true,
    mode: resolved.mode,
    presetId: resolved.profile?.id ?? null,
    providerKind: provider.kind,
    modelId,
    blend: resolved.blend,
    providerConfig: provider,
  };
}

export function resolveOperationalDeepIndexEmbeddingsSettings(
  embeddings: MemorySettingsV1['embeddings'],
): OperationalDeepIndexEmbeddingsSettings | null {
  const operational = resolveOperationalMemoryEmbeddingsSettings(embeddings);
  if (!operational?.enabled || !operational.providerKind || !operational.modelId) {
    return null;
  }

  return {
    enabled: true,
    provider: operational.providerKind,
    modelId: operational.modelId,
    wFts: operational.blend.ftsWeight,
    wEmb: operational.blend.embeddingWeight,
  };
}

export function buildUnavailableMemoryEmbeddingsDiagnostics(
  embeddings: MemorySettingsV1['embeddings'],
): OperationalMemoryEmbeddingsDiagnostics {
  const operational = resolveOperationalMemoryEmbeddingsSettings(embeddings);
  return {
    mode: embeddings.mode,
    presetId: embeddings.mode === 'preset' ? embeddings.presetId : null,
    providerKind: operational?.providerKind ?? null,
    modelId: operational?.modelId ?? null,
    runtimeState: operational ? 'unavailable' : 'unavailable',
    usingFallback: false,
  };
}
