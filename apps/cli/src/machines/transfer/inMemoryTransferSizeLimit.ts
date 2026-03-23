const DEFAULT_IN_MEMORY_TRANSFER_MAX_BYTES = 2_500_000;

// Hard ceiling so misconfiguration can't turn "small-only" whole-buffer paths into an OOM vector.
export const IN_MEMORY_TRANSFER_HARD_MAX_BYTES = 10_000_000;

// This is intentionally tied to the same env var used by the daemon file read handler
// (`HAPPIER_FILES_READ_MAX_BYTES`): whole-buffer transfer APIs are small-only and must
// not be able to OOM the process.
export const IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR = 'Transfer exceeds the in-memory transfer size limit';

export function resolveInMemoryTransferMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.HAPPIER_FILES_READ_MAX_BYTES ?? '').trim();
  if (!raw) return Math.min(DEFAULT_IN_MEMORY_TRANSFER_MAX_BYTES, IN_MEMORY_TRANSFER_HARD_MAX_BYTES);
  const parsed = Number.parseInt(raw, 10);
  const requested = Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_IN_MEMORY_TRANSFER_MAX_BYTES;
  return Math.min(requested, IN_MEMORY_TRANSFER_HARD_MAX_BYTES);
}
