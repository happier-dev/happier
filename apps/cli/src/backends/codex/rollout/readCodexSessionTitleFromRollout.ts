import { readJsonlFileForward } from '../../../api/session/fileBackedTranscripts/jsonl/readJsonlForward';
import { readExternalSessionTitleCandidate } from '../../../api/session/external/title/readExternalSessionTitleCandidate';
import { isChangeTitleToolNameAlias } from '@happier-dev/protocol';

import { mapCodexRolloutEventToActions } from '@happier-dev/plugins-codex/agent/rollout/projection/actions';

const TITLE_SCAN_CHUNK_MAX_BYTES = 128 * 1024;
const TITLE_SCAN_CHUNK_MAX_ITEMS = 64;
const TITLE_SCAN_TOTAL_MAX_BYTES = 1024 * 1024;
const TITLE_SCAN_TOTAL_MAX_ITEMS = 512;

function readTitleFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const title = typeof (input as Record<string, unknown>).title === 'string'
    ? String((input as Record<string, unknown>).title)
    : '';
  return readExternalSessionTitleCandidate(title);
}

function isHappierMcpServerName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'happier'
    || normalized === 'happy'
    || normalized === 'happier__happier'
    || normalized === 'happy__happier';
}

function isHappierChangeTitleToolAction(action: Extract<ReturnType<typeof mapCodexRolloutEventToActions>[number], { type: 'tool-call' }>): boolean {
  if (action.source?.kind !== 'mcp' || !isHappierMcpServerName(action.source.serverName)) {
    return false;
  }
  return isChangeTitleToolNameAlias(action.source.toolName)
    || isChangeTitleToolNameAlias(action.name);
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
        if (action.type === 'tool-call' && isHappierChangeTitleToolAction(action)) {
          const fromTool = readTitleFromToolInput(action.input);
          if (fromTool) return fromTool;
        }
        if (action.type === 'user-text') {
          const title = readExternalSessionTitleCandidate(action.text);
          if (title) return title;
        }
        if (action.type === 'assistant-text' && fallbackAssistantText === null) {
          fallbackAssistantText = readExternalSessionTitleCandidate(action.text);
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
