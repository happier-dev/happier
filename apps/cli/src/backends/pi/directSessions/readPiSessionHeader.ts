import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/**
 * The parsed Pi session header (the first parsed JSONL entry, `type: 'session'`). The header is metadata
 * only and is not part of the entry tree.
 */
export type PiSessionHeader = Readonly<{
  id: string;
  cwd: string;
  timestamp: string;
  version?: number;
  parentSession?: string;
}>;

// Pi 1.5.2's discovery budget, including any blank or malformed prefix lines.
const MAX_HEADER_SCAN_BYTES = 1024 * 1024;

function parseHeaderCandidate(line: string): PiSessionHeader | null | undefined {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed) return undefined;
  if (parsed.type !== 'session' || typeof parsed.id !== 'string') return null;
  return {
    id: parsed.id,
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
    timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
    ...(typeof parsed.version === 'number' ? { version: parsed.version } : {}),
    ...(typeof parsed.parentSession === 'string' && parsed.parentSession.trim()
      ? { parentSession: parsed.parentSession }
      : {}),
  };
}

/** Read the first parsed entry within Pi's discovery budget and require a session header. */
export async function readPiSessionHeader(filePath: string): Promise<PiSessionHeader | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(4096);
    const decoder = new StringDecoder('utf8');
    let scanned = 0;
    let pending = '';
    while (scanned < MAX_HEADER_SCAN_BYTES) {
      const { bytesRead } = await fh.read(buffer, 0, Math.min(buffer.length, MAX_HEADER_SCAN_BYTES - scanned), null);
      if (bytesRead === 0) return parseHeaderCandidate(pending + decoder.end()) ?? null;
      scanned += bytesRead;
      const lines = decoder.write(buffer.subarray(0, bytesRead)).split('\n');
      if (lines.length === 1) {
        pending += lines[0];
        continue;
      }
      lines[0] = pending + lines[0];
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const header = parseHeaderCandidate(line);
        if (header !== undefined) return header;
      }
    }
    // A final unterminated header exactly at the limit is valid only at EOF.
    const { bytesRead } = await fh.read(buffer, 0, 1, null);
    return bytesRead === 0 ? parseHeaderCandidate(pending + decoder.end()) ?? null : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
