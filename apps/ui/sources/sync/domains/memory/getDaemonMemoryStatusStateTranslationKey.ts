import type { DaemonMemoryStatusPresentation } from '@/sync/domains/memory/presentDaemonMemoryStatus';

export type DaemonMemoryStatusStateTranslationKey =
  | 'common.unavailable'
  | 'memorySearchSettings.status.disabled'
  | 'memorySearchSettings.status.empty'
  | 'memorySearchSettings.status.error'
  | 'memorySearchSettings.status.indexing'
  | 'memorySearchSettings.status.readyDeep'
  | 'memorySearchSettings.status.readyLight'
  | 'memorySearchSettings.status.unavailableDeep'
  | 'memorySearchSettings.status.unavailableLight'
  | 'memorySearchSettings.status.waiting';

export function getDaemonMemoryStatusStateTranslationKey(
  presentation: DaemonMemoryStatusPresentation | null | undefined,
): DaemonMemoryStatusStateTranslationKey {
  if (!presentation) return 'common.unavailable';

  switch (presentation.state) {
    case 'disabled':
      return 'memorySearchSettings.status.disabled';
    case 'empty':
      return 'memorySearchSettings.status.empty';
    case 'error':
      return 'memorySearchSettings.status.error';
    case 'indexing':
      return 'memorySearchSettings.status.indexing';
    case 'waiting':
      return 'memorySearchSettings.status.waiting';
    case 'ready_deep':
      return 'memorySearchSettings.status.readyDeep';
    case 'ready_light':
      return 'memorySearchSettings.status.readyLight';
    case 'unavailable_deep':
      return 'memorySearchSettings.status.unavailableDeep';
    case 'unavailable_light':
    default:
      return 'memorySearchSettings.status.unavailableLight';
  }
}
