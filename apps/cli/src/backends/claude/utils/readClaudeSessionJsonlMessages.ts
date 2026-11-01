import { logger } from '@/ui/logger';
import { tryReadTextFileTail } from '@/agent/runtime/readTextFileTail';
import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';

import type { RawJSONLines } from '../types';
import { providers } from '@happier-dev/agents';
import { parseRawJsonLinesObject } from './parseRawJsonLines';
import { isClaudeTaskLifecycleResultEnvelope, readClaudeTaskLifecycleEnvelope } from '../taskNotifications/claudeTaskLifecycleEnvelope';

/**
 * Read and parse a Claude Code session JSONL file.
 *
 * Returns only valid conversation messages, silently skipping internal events.
 */
export async function readClaudeSessionJsonlMessages(params: Readonly<{
  sessionFilePath: string;
  logLabel: string;
  /**
   * Max bytes to read from the end of the JSONL file, also used as the page budget
   * when observing startup history.
   *
   * Claude session transcripts can grow very large. Reading the entire file into
   * memory can cause OOMs in long-running scanners and integration tests.
   */
  maxBytes?: number;
  /** Observe startup history from the beginning; returned conversation messages retain the bounded tail. */
  observeFullHistory?: true;
  /** Observes every parsed JSONL value before conversation/internal filtering. */
  onJsonValue?: ((value: unknown, source: Readonly<{ lineStartOffsetBytes: number }>) => void) | undefined;
}>): Promise<RawJSONLines[]> {
  logger.debug(`[${params.logLabel}] Reading session file: ${params.sessionFilePath}`);

  if (params.observeFullHistory) {
    let offsetBytes = 0;
    for (;;) {
      const page = await readJsonlFileForward({
        filePath: params.sessionFilePath,
        offsetBytes,
        maxBytes: params.maxBytes ?? 1_000_000,
        maxItems: Infinity,
        // Startup identity cannot depend on a display-oriented line truncation boundary.
        maxOversizeLineBytes: Infinity,
      });
      if (page.truncated) throw new Error('Claude startup transcript history is unavailable');
      for (const line of page.items) {
        params.onJsonValue?.(line.value, { lineStartOffsetBytes: line.startOffsetBytes });
      }
      if (page.reachedEnd) break;
      if (page.nextOffsetBytes <= offsetBytes) throw new Error('Claude startup transcript history is incomplete');
      offsetBytes = page.nextOffsetBytes;
    }
  }

  const tail = await tryReadTextFileTail(params.sessionFilePath, {
    maxBytes: params.maxBytes ?? 1_000_000,
    encoding: 'utf8',
  });
  if (!tail) {
    if (params.observeFullHistory) throw new Error('Claude startup transcript history is unavailable');
    logger.debug(`[${params.logLabel}] Session file not found: ${params.sessionFilePath}`);
    return [];
  }

  const lines = tail.tail.split('\n');
  const candidateLines = tail.truncated ? lines.slice(1) : lines;
  // Count from the complete-line suffix: a truncated tail may start inside a UTF-8 character.
  let nextLineOffsetBytes = tail.totalBytes - Buffer.byteLength(candidateLines.join('\n'));
  const messages: RawJSONLines[] = [];
  for (const line of candidateLines) {
    const lineStartOffsetBytes = nextLineOffsetBytes;
    nextLineOffsetBytes += Buffer.byteLength(line) + 1;
    try {
      if (line.trim() === '') continue;
      const raw = JSON.parse(line);
      try {
        if (!params.observeFullHistory) params.onJsonValue?.(raw, { lineStartOffsetBytes });
      } catch (observerError) {
        logger.debug(`[${params.logLabel}] Error observing raw message: ${observerError}`);
      }

      const parsed = parseRawJsonLinesObject(raw);
      if (providers.claude.isClaudeInternalEventType(parsed?.type ?? raw?.type)
        && !isClaudeTaskLifecycleResultEnvelope(readClaudeTaskLifecycleEnvelope(raw))) {
        continue;
      }

      if (!parsed) {
        continue;
      }
      messages.push(parsed);
    } catch (e) {
      logger.debug(`[${params.logLabel}] Error processing message: ${e}`);
      continue;
    }
  }

  return messages;
}
