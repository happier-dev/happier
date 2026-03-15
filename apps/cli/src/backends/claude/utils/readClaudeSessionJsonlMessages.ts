import { readFile } from 'node:fs/promises';

import { logger } from '@/ui/logger';

import type { RawJSONLines } from '../types';
import { parseRawJsonLinesObject } from './parseRawJsonLines';

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
  'file-history-snapshot',
  'change',
  'queue-operation',
]);

/**
 * Read and parse a Claude Code session JSONL file.
 *
 * Returns only valid conversation messages, silently skipping internal events.
 */
export async function readClaudeSessionJsonlMessages(params: Readonly<{
  sessionFilePath: string;
  logLabel: string;
}>): Promise<RawJSONLines[]> {
  logger.debug(`[${params.logLabel}] Reading session file: ${params.sessionFilePath}`);

  let file: string;
  try {
    file = await readFile(params.sessionFilePath, 'utf-8');
  } catch {
    logger.debug(`[${params.logLabel}] Session file not found: ${params.sessionFilePath}`);
    return [];
  }

  const lines = file.split('\n');
  const messages: RawJSONLines[] = [];
  for (const line of lines) {
    try {
      if (line.trim() === '') continue;
      const raw = JSON.parse(line);

      if (raw?.type && INTERNAL_CLAUDE_EVENT_TYPES.has(String(raw.type))) {
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
