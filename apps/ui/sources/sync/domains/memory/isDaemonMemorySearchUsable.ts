import type { MemoryStatusV1 } from '@happier-dev/protocol';
import { readMemoryStatusTelemetry } from './memoryStatusTelemetry';

export function isDaemonMemorySearchUsable(status: MemoryStatusV1 | null | undefined): boolean {
  if (!status || status.enabled !== true) return false;
  const telemetry = readMemoryStatusTelemetry(status);
  return telemetry.activeIndexSearchable === true;
}
