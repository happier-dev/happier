import type { MemoryStatusV1 } from '@happier-dev/protocol';

export function readMemoryStatusTelemetry(status: MemoryStatusV1): MemoryStatusV1 {
  return status;
}

export function hasKnownEmptyMemoryIndexContent(status: MemoryStatusV1): boolean {
  const telemetry = readMemoryStatusTelemetry(status);
  const indexContent = telemetry.indexContent;
  if (!indexContent) return false;
  return (
    indexContent.lightShardCount <= 0
    && indexContent.lightTermCount <= 0
    && indexContent.deepChunkCount <= 0
    && indexContent.searchableSessionCount <= 0
  );
}
