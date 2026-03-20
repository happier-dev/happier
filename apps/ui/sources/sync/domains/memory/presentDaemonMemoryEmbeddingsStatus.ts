import type { MemoryStatusV1 } from '@happier-dev/protocol';

export type DaemonMemoryEmbeddingsStatusPresentation = Readonly<{
  state:
    | 'disabled'
    | 'ready'
    | 'downloading'
    | 'fallback'
    | 'unavailable'
    | 'error';
  providerKind: MemoryStatusV1['embeddingsProviderKind'];
  presetId: MemoryStatusV1['embeddingsPresetId'];
  modelId: MemoryStatusV1['embeddingsModelId'];
}>;

export function presentDaemonMemoryEmbeddingsStatus(
  status: MemoryStatusV1 | null | undefined,
): DaemonMemoryEmbeddingsStatusPresentation | null {
  if (!status) return null;

  if (status.embeddingsEnabled !== true || status.embeddingsMode === 'disabled') {
    return {
      state: 'disabled',
      providerKind: status.embeddingsProviderKind,
      presetId: status.embeddingsPresetId,
      modelId: status.embeddingsModelId,
    };
  }

  if (status.embeddingsUsingFallback === true) {
    return {
      state: 'fallback',
      providerKind: status.embeddingsProviderKind,
      presetId: status.embeddingsPresetId,
      modelId: status.embeddingsModelId,
    };
  }

  return {
    state: status.embeddingsRuntimeState,
    providerKind: status.embeddingsProviderKind,
    presetId: status.embeddingsPresetId,
    modelId: status.embeddingsModelId,
  };
}
