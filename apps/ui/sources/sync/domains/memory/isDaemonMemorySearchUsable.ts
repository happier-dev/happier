import type { MemoryStatusV1 } from '@happier-dev/protocol';

export function isDaemonMemorySearchUsable(status: MemoryStatusV1 | null | undefined): boolean {
  if (!status || status.enabled !== true) return false;
  return status.activeIndexReady === true;
}
