import { logger } from '@/ui/logger';
import { tryReadTextFileTail } from '@/agent/runtime/readTextFileTail';

import type { RawJSONLines } from '../types';
import { providers } from '@happier-dev/agents';
import { parseRawJsonLinesObject } from './parseRawJsonLines';

/**
 * Read and parse a Claude Code session JSONL file.
 *
 * Returns only valid conversation messages, silently skipping internal events.
 */
export async function readClaudeSessionJsonlMessages(params: Readonly<{
  sessionFilePath: string;
  logLabel: string;
  /**
   * Max bytes to read from the end of the JSONL file.
   *
   * Claude session transcripts can grow very large. Reading the entire file into
   * memory can cause OOMs in long-running scanners and integration tests.
   */
  maxBytes?: number;
  /** Observes every parsed JSONL value before conversation/internal filtering. */
  onJsonValue?: ((value: unknown) => void) | undefined;
}>): Promise<RawJSONLines[]> {
  logger.debug(`[${params.logLabel}] Reading session file: ${params.sessionFilePath}`);

  const tail = await tryReadTextFileTail(params.sessionFilePath, {
    maxBytes: params.maxBytes ?? 1_000_000,
    encoding: 'utf8',
  });
  if (!tail) {
    logger.debug(`[${params.logLabel}] Session file not found: ${params.sessionFilePath}`);
    return [];
  }

  const lines = tail.tail.split('\n');
  const candidateLines = tail.truncated ? lines.slice(1) : lines;
  const messages: RawJSONLines[] = [];
  for (const line of candidateLines) {
    try {
      if (line.trim() === '') continue;
      const raw = JSON.parse(line);
      try {
        params.onJsonValue?.(raw);
      } catch (observerError) {
        logger.debug(`[${params.logLabel}] Error observing raw message: ${observerError}`);
      }

      if (providers.claude.isClaudeInternalEventType(raw?.type)) {
        continue;
      }

      const parsed = parseRawJsonLinesObject(raw);
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
