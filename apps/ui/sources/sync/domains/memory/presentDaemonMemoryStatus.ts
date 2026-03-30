import type { MemoryStatusV1 } from '@happier-dev/protocol';

export type DaemonMemoryStatusPresentation = Readonly<{
  state:
    | 'disabled'
    | 'ready_light'
    | 'ready_deep'
    | 'unavailable_light'
    | 'unavailable_deep';
  lightMb: number | null;
  deepMb: number | null;
}>;

function bytesToRoundedMb(bytes: number | null | undefined): number | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  return Math.max(0, Math.round(bytes / (1024 * 1024)));
}

export function presentDaemonMemoryStatus(
  status: MemoryStatusV1 | null | undefined,
): DaemonMemoryStatusPresentation | null {
  if (!status) return null;

  const state =
    status.enabled !== true
      ? 'disabled'
      : status.activeIndexReady === true
        ? (status.indexMode === 'deep' ? 'ready_deep' : 'ready_light')
        : (status.indexMode === 'deep' ? 'unavailable_deep' : 'unavailable_light');

  return {
    state,
    lightMb: bytesToRoundedMb(status.tier1DbBytes),
    deepMb: bytesToRoundedMb(status.deepDbBytes),
  };
}
