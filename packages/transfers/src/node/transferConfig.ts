/** Existing file-transfer chunk and inactivity settings, shared by destinations. */
export const FILES_TRANSFER_CHUNK_CONFIG_MAX_BYTES = 5_000_000;

export function readFiniteTransferConfig(env: Readonly<Record<string, string | undefined>>) {
  const read = (key: string, min: number, max: number, fallback: number): number => {
    const value = Number.parseInt(String(env[key] ?? '').trim(), 10);
    return Number.isFinite(value) && value >= min ? Math.min(value, max) : fallback;
  };
  return {
    chunkSizeBytes: read('HAPPIER_FILES_TRANSFER_CHUNK_BYTES', 1024, FILES_TRANSFER_CHUNK_CONFIG_MAX_BYTES, 256_000),
    ttlMs: read('HAPPIER_FILES_TRANSFER_SESSION_TTL_MS', 1000, 60 * 60_000, 10 * 60_000),
  };
}
