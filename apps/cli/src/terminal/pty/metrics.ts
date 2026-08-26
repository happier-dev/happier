export type TerminalPtyMetricsSnapshot = Readonly<{
  activeTerminals: number;
  bytesWritten: number;
  bytesRead: number;
  chunksWritten: number;
  chunksDropped: number;
  readsWithGaps: number;
  legacyOnlyProviders: number;
  exits: number;
  acknowledgedByteOffsetHighWater: number;
  rendererAckLagBytesHighWater: number;
}>;

export type TerminalPtyMetrics = Readonly<{
  recordBytesWritten: (byteLength: number) => void;
  recordBytesRead: (byteLength: number) => void;
  recordChunksDropped: (count: number) => void;
  recordGapRead: () => void;
  recordLegacyOnlyProvider: () => void;
  recordExit: () => void;
  recordRendererAck: (input: Readonly<{ ackedByteOffset: number; availableByteOffset: number }>) => void;
  snapshot: (activeTerminals: number) => TerminalPtyMetricsSnapshot;
}>;

export function createTerminalPtyMetrics(): TerminalPtyMetrics {
  const counters = {
    bytesWritten: 0,
    bytesRead: 0,
    chunksWritten: 0,
    chunksDropped: 0,
    readsWithGaps: 0,
    legacyOnlyProviders: 0,
    exits: 0,
    acknowledgedByteOffsetHighWater: 0,
    rendererAckLagBytesHighWater: 0,
  };

  return {
    recordBytesWritten: (byteLength) => {
      counters.bytesWritten += Math.max(0, Math.trunc(byteLength));
      counters.chunksWritten += 1;
    },
    recordBytesRead: (byteLength) => {
      counters.bytesRead += Math.max(0, Math.trunc(byteLength));
    },
    recordChunksDropped: (count) => {
      counters.chunksDropped += Math.max(0, Math.trunc(count));
    },
    recordGapRead: () => {
      counters.readsWithGaps += 1;
    },
    recordLegacyOnlyProvider: () => {
      counters.legacyOnlyProviders += 1;
    },
    recordExit: () => {
      counters.exits += 1;
    },
    recordRendererAck: ({ ackedByteOffset, availableByteOffset }) => {
      const acked = Math.max(0, Math.trunc(ackedByteOffset));
      const available = Math.max(0, Math.trunc(availableByteOffset));
      counters.acknowledgedByteOffsetHighWater = Math.max(counters.acknowledgedByteOffsetHighWater, acked);
      counters.rendererAckLagBytesHighWater = Math.max(counters.rendererAckLagBytesHighWater, Math.max(0, available - acked));
    },
    snapshot: (activeTerminals) => ({ ...counters, activeTerminals }),
  };
}
