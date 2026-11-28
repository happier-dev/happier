import { readDirectSessionTitlePage } from '@/api/directSessions/title/readDirectSessionTitlePage';
import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';
import { readDirectSessionTitleCandidate } from '@/api/directSessions/title/readDirectSessionTitleCandidate';
import { tryParseJsonlLine } from '@/api/directSessions/filePaging/jsonlParse';
import { logger } from '@/utils/logger';

import { mapCodexRolloutEventToActions } from '../localControl/rolloutMapper';
import { canDecodeCompressedCodexRollouts, isCompressedCodexRollout, readCompressedCodexRollout } from '../rollout/openCompressedCodexRollout';

const TITLE_SCAN_CHUNK_MAX_BYTES = 128 * 1024;
const TITLE_SCAN_CHUNK_MAX_ITEMS = 64;
const TITLE_SCAN_TOTAL_MAX_BYTES = 1024 * 1024;
const TITLE_SCAN_TOTAL_MAX_ITEMS = 512;

function readTitleFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const title = typeof (input as Record<string, unknown>).title === 'string'
    ? String((input as Record<string, unknown>).title)
    : '';
  return readDirectSessionTitleCandidate(title);
}

async function* readTitleLines(filePath: string): AsyncGenerator<unknown> {
  if (isCompressedCodexRollout(filePath)) {
    if (!canDecodeCompressedCodexRollouts) return;
    try {
      let carry = Buffer.alloc(0);
      let bytes = 0;
      let items = 0;
      for await (const chunk of readCompressedCodexRollout(filePath)) {
        const slice = chunk.subarray(0, TITLE_SCAN_TOTAL_MAX_BYTES - bytes);
        bytes += slice.length;
        const buffer = Buffer.concat([carry, slice]);
        let start = 0;
        for (let end = buffer.indexOf(0x0a, start); end >= 0; end = buffer.indexOf(0x0a, start)) {
          const parsed = tryParseJsonlLine(buffer.subarray(start, end));
          start = end + 1;
          if (parsed === null) continue;
          yield parsed;
          if (++items >= TITLE_SCAN_TOTAL_MAX_ITEMS) return;
        }
        if (bytes >= TITLE_SCAN_TOTAL_MAX_BYTES) return;
        carry = buffer.subarray(start);
      }
      const parsed = tryParseJsonlLine(carry);
      if (parsed !== null) yield parsed;
    } catch {
      logger.warn('[directSessions] Could not read a compressed Codex rollout title');
    }
    return;
  }
  let offsetBytes = 0;
  let scannedBytes = 0;
  let scannedItems = 0;

  while (scannedBytes < TITLE_SCAN_TOTAL_MAX_BYTES && scannedItems < TITLE_SCAN_TOTAL_MAX_ITEMS) {
    const page = await readDirectSessionTitlePage(() => readJsonlFileForward({
      filePath,
      offsetBytes,
      maxBytes: Math.min(TITLE_SCAN_CHUNK_MAX_BYTES, TITLE_SCAN_TOTAL_MAX_BYTES - scannedBytes),
      maxItems: Math.min(TITLE_SCAN_CHUNK_MAX_ITEMS, TITLE_SCAN_TOTAL_MAX_ITEMS - scannedItems),
    }));
    if (!page) break;

    for (const line of page.items) yield line.value;

    if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
    scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
    scannedItems += page.items.length;
    offsetBytes = page.nextOffsetBytes;
  }

}

export async function readCodexSessionTitleFromRollout(filePath: string): Promise<string | null> {
  let fallbackAssistantText: string | null = null;
  for await (const line of readTitleLines(filePath)) {
    for (const action of mapCodexRolloutEventToActions(line, { debug: false })) {
      if (action.type === 'tool-call' && action.name === 'change_title') {
        const fromTool = readTitleFromToolInput(action.input);
        if (fromTool) return fromTool;
      }
      if (action.type === 'user-text') {
        const title = readDirectSessionTitleCandidate(action.text);
        if (title) return title;
      }
      if (action.type === 'assistant-text' && fallbackAssistantText === null) {
        fallbackAssistantText = readDirectSessionTitleCandidate(action.text);
      }
    }
  }
  return fallbackAssistantText;
}
