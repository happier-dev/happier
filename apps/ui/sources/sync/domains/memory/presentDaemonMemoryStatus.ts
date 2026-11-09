import type { MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import {
  hasKnownEmptyMemoryIndexContent,
  readMemoryStatusTelemetry,
} from './memoryStatusTelemetry';

export type DaemonMemoryStatusPresentation = Readonly<{
  state:
    | 'disabled'
    | 'empty'
    | 'indexing'
    | 'waiting'
    | 'error'
    | 'ready_light'
    | 'ready_deep'
    | 'unavailable_light'
    | 'unavailable_deep';
  lightMb: number | null;
  deepMb: number | null;
  lightSize: string | null;
  deepSize: string | null;
}>;

function bytesToRoundedMb(bytes: number | null | undefined): number | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  return Math.max(0, Math.round(bytes / (1024 * 1024)));
}

export function presentDaemonMemoryStatus(
  status: MemoryStatusV1 | null | undefined,
): DaemonMemoryStatusPresentation | null {
  if (!status) return null;

  const telemetry = readMemoryStatusTelemetry(status);
  const workerState = telemetry.worker?.state;
  const activeIndexSearchable = telemetry.activeIndexSearchable === true;
  const state =
    status.enabled !== true
      ? 'disabled'
      : workerState === 'error'
        ? 'error'
        : workerState === 'indexing' || workerState === 'inventorying'
          ? 'indexing'
          : workerState === 'waiting' || workerState === 'backoff'
            ? 'waiting'
            : activeIndexSearchable
              ? (status.indexMode === 'deep' ? 'ready_deep' : 'ready_light')
              : hasKnownEmptyMemoryIndexContent(status)
                ? 'empty'
                : (status.indexMode === 'deep' ? 'unavailable_deep' : 'unavailable_light');

  return {
    state,
    lightMb: bytesToRoundedMb(status.tier1DbBytes),
    deepMb: bytesToRoundedMb(status.deepDbBytes),
    lightSize: typeof status.tier1DbBytes === 'number' ? formatHappierDataBytes(status.tier1DbBytes, { kind: 'storage' }) : null,
    deepSize: typeof status.deepDbBytes === 'number' ? formatHappierDataBytes(status.deepDbBytes, { kind: 'storage' }) : null,
  };
}
