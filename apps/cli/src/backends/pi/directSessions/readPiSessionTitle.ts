import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';
import { readDirectSessionTitleCandidate } from '@/api/directSessions/title/readDirectSessionTitleCandidate';

const TITLE_SCAN_CHUNK_MAX_BYTES = 128 * 1024;
const TITLE_SCAN_CHUNK_MAX_ITEMS = 64;
const TITLE_SCAN_TOTAL_MAX_BYTES = 1024 * 1024;
const TITLE_SCAN_TOTAL_MAX_ITEMS = 512;

function coerceTextContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return readDirectSessionTitleCandidate(content);
  }
  if (!Array.isArray(content)) return null;

  const parts = content
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
      const text = (item as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    })
    .filter((part) => part.trim().length > 0);

  return parts.length > 0 ? readDirectSessionTitleCandidate(parts.join(' ')) : null;
}

/**
 * Read a pi session display title. Pi stores the user-defined name on the latest `session_info`
 * entry; when none is set, fall back to the first user message text. Both are cleaned through the
 * shared `readDirectSessionTitleCandidate` boilerplate filter.
 */
export async function readPiSessionTitle(filePath: string): Promise<string | null> {
  let sessionInfoName: string | null = null;
  let userFallback: string | null = null;
  let offsetBytes = 0;
  let scannedBytes = 0;
  let scannedItems = 0;

  while (scannedBytes < TITLE_SCAN_TOTAL_MAX_BYTES && scannedItems < TITLE_SCAN_TOTAL_MAX_ITEMS) {
    const page = await readJsonlFileForward({
      filePath,
      offsetBytes,
      maxBytes: Math.min(TITLE_SCAN_CHUNK_MAX_BYTES, TITLE_SCAN_TOTAL_MAX_BYTES - scannedBytes),
      maxItems: Math.min(TITLE_SCAN_CHUNK_MAX_ITEMS, TITLE_SCAN_TOTAL_MAX_ITEMS - scannedItems),
    });

    for (const line of page.items) {
      const value = line.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : '';

      if (type === 'session_info') {
        const name = coerceTextContent(record.name);
        // Latest session_info wins, matching pi's own `getSessionName` semantics.
        if (name) sessionInfoName = name;
        continue;
      }

      if (type === 'message' && userFallback === null) {
        const message = record.message;
        if (message && typeof message === 'object' && !Array.isArray(message)) {
          const msg = message as Record<string, unknown>;
          if (msg.role === 'user') {
            const title = coerceTextContent(msg.content);
            if (title) userFallback = title;
          }
        }
      }
    }

    if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
    scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
    scannedItems += page.items.length;
    offsetBytes = page.nextOffsetBytes;
  }

  return sessionInfoName ?? userFallback;
}
