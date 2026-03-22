import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';
import { readDirectSessionTitleCandidate } from '@/api/directSessions/title/readDirectSessionTitleCandidate';

import { mapCodexRolloutEventToActions } from '../localControl/rolloutMapper';

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

export async function readCodexSessionTitleFromRollout(filePath: string): Promise<string | null> {
  let fallbackAssistantText: string | null = null;
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
      const actions = mapCodexRolloutEventToActions(line.value, { debug: false });
      for (const action of actions) {
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

    if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
    scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
    scannedItems += page.items.length;
    offsetBytes = page.nextOffsetBytes;
  }

  return fallbackAssistantText;
}
