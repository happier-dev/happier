import { open } from 'node:fs/promises';

/**
 * The parsed pi session header (the first JSONL line, `type: 'session'`). The header is metadata
 * only and is not part of the entry tree.
 */
export type PiSessionHeader = Readonly<{
  id: string;
  cwd: string;
  timestamp: string;
  version?: number;
  parentSession?: string;
}>;

const HEADER_READ_BUFFER_BYTES = 64 * 1024;

/**
 * Read and parse the first JSONL line of a pi session file. Returns null on any read/parse failure
 * or when the first line is not a `session` header.
 */
export async function readPiSessionHeader(filePath: string): Promise<PiSessionHeader | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, 'r');
    const buffer = Buffer.alloc(HEADER_READ_BUFFER_BYTES);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.subarray(0, bytesRead).toString('utf8');
    const newlineIdx = chunk.indexOf('\n');
    const firstLine = newlineIdx >= 0 ? chunk.slice(0, newlineIdx) : chunk;
    const trimmed = firstLine.trim();
    if (!trimmed) return null;

    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || parsed.type !== 'session') return null;

    const id = typeof parsed.id === 'string' ? parsed.id : '';
    const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : '';
    const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : '';
    if (!id) return null;

    return {
      id,
      cwd,
      timestamp,
      ...(typeof parsed.version === 'number' ? { version: parsed.version } : {}),
      ...(typeof parsed.parentSession === 'string' && parsed.parentSession.trim()
        ? { parentSession: parsed.parentSession }
        : {}),
    };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
