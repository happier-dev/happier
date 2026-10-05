// Hard ceiling so misconfiguration can't turn per-chunk allocations into an OOM vector.
export const TRANSFER_CHUNK_HARD_MAX_BYTES = 1024 * 1024; // 1 MiB

export function clampTransferChunkBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return TRANSFER_CHUNK_HARD_MAX_BYTES;
  }
  return Math.min(Math.floor(value), TRANSFER_CHUNK_HARD_MAX_BYTES);
}
