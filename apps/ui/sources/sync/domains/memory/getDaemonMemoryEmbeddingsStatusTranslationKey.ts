import type { DaemonMemoryEmbeddingsStatusPresentation } from '@/sync/domains/memory/presentDaemonMemoryEmbeddingsStatus';

export type DaemonMemoryEmbeddingsStatusTranslationKey =
  | 'common.unavailable'
  | 'memorySearchSettings.status.embeddingsDisabled'
  | 'memorySearchSettings.status.embeddingsReady'
  | 'memorySearchSettings.status.embeddingsDownloading'
  | 'memorySearchSettings.status.embeddingsFallback'
  | 'memorySearchSettings.status.embeddingsUnavailable'
  | 'memorySearchSettings.status.embeddingsError';

export function getDaemonMemoryEmbeddingsStatusTranslationKey(
  presentation: DaemonMemoryEmbeddingsStatusPresentation | null | undefined,
): DaemonMemoryEmbeddingsStatusTranslationKey {
  if (!presentation) return 'common.unavailable';

  switch (presentation.state) {
    case 'disabled':
      return 'memorySearchSettings.status.embeddingsDisabled';
    case 'ready':
      return 'memorySearchSettings.status.embeddingsReady';
    case 'downloading':
      return 'memorySearchSettings.status.embeddingsDownloading';
    case 'fallback':
      return 'memorySearchSettings.status.embeddingsFallback';
    case 'error':
      return 'memorySearchSettings.status.embeddingsError';
    case 'unavailable':
    default:
      return 'memorySearchSettings.status.embeddingsUnavailable';
  }
}
