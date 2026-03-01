import { open } from 'node:fs/promises';

export type TextFileTail = Readonly<{
  tail: string;
  truncated: boolean;
  totalBytes: number;
}>;

const DEFAULT_MAX_BYTES = 32_000;
const MIN_MAX_BYTES = 1_024;
const MAX_MAX_BYTES = 1_000_000;

function normalizeMaxBytes(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_BYTES;
  const normalized = Math.floor(value);
  return Math.min(MAX_MAX_BYTES, Math.max(MIN_MAX_BYTES, normalized));
}

/**
 * Best-effort text tail reader. Intended for diagnostics display in UI errors.
 * Returns null when the file cannot be read (missing, permission issues, etc).
 */
export async function tryReadTextFileTail(
  filePath: string,
  opts?: Readonly<{
    maxBytes?: number;
    encoding?: BufferEncoding;
  }>,
): Promise<TextFileTail | null> {
  const encoding = opts?.encoding ?? 'utf8';
  const maxBytes = normalizeMaxBytes(opts?.maxBytes);

  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(filePath, 'r');
    const metadata = await file.stat();

    const start = Math.max(0, metadata.size - maxBytes);
    const size = Math.max(0, metadata.size - start);
    if (size === 0) {
      return { tail: '', truncated: false, totalBytes: metadata.size };
    }

    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, start);
    return {
      tail: buffer.subarray(0, bytesRead).toString(encoding),
      truncated: start > 0,
      totalBytes: metadata.size,
    };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}
