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
      return typeof (item as Record<string, unknown>).text === 'string'
        ? String((item as Record<string, unknown>).text)
        : '';
    })
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);

  const text = parts.join(' ');

  return readDirectSessionTitleCandidate(text);
}

export async function readClaudeSessionTitle(filePath: string): Promise<string | null> {
  let summaryTitle: string | null = null;
  let assistantFallback: string | null = null;
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

      if (type === 'summary' && summaryTitle === null) {
        summaryTitle = readDirectSessionTitleCandidate(typeof record.summary === 'string' ? record.summary : '');
        if (summaryTitle) return summaryTitle;
        continue;
      }

      if (type === 'queue-operation') {
        const operation = typeof record.operation === 'string' ? record.operation : '';
        if (operation === 'enqueue') {
          const queuedTitle = coerceTextContent(record.content);
          if (queuedTitle) return queuedTitle;
        }
      }

      const message = record.message && typeof record.message === 'object' && !Array.isArray(record.message)
        ? (record.message as Record<string, unknown>)
        : null;
      const messageTitle = coerceTextContent(message?.content);

      if (type === 'user' && messageTitle) return messageTitle;
      if (type === 'assistant' && assistantFallback === null && messageTitle) {
        assistantFallback = messageTitle;
      }
    }

    if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
    scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
    scannedItems += page.items.length;
    offsetBytes = page.nextOffsetBytes;
  }

  return assistantFallback;
}
