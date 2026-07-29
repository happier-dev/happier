import { RawJSONLinesSchema } from './rawJsonLines.js';
import { isClaudeInternalTranscriptMessage } from './visibility.js';

export type ClaudeTranscriptMessageRole = 'user' | 'agent' | 'event' | 'unknown';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readClaudeContent(body: unknown): unknown {
  return asRecord(asRecord(body)?.message)?.content;
}

function hasToolBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => {
    const type = readNonEmptyString(asRecord(block)?.type);
    return type === 'tool_use' || type === 'tool_result';
  });
}

function hasTextBlock(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some((block) => {
    const record = asRecord(block);
    return record?.type === 'text' && typeof record.text === 'string' && record.text.trim().length > 0;
  });
}

export function resolveClaudeTranscriptMessageRole(body: unknown): ClaudeTranscriptMessageRole {
  const parsed = RawJSONLinesSchema.safeParse(body);
  if (parsed.success && isClaudeInternalTranscriptMessage(parsed.data)) return 'event';

  const type = readNonEmptyString(asRecord(body)?.type);
  if (type === 'user') {
    const content = readClaudeContent(body);
    if (hasToolBlock(content)) return 'event';
    return hasTextBlock(content) ? 'user' : 'event';
  }
  if (type === 'assistant') {
    return hasTextBlock(readClaudeContent(body)) ? 'agent' : 'event';
  }
  if (type === 'summary' || type === 'system' || type === 'progress') return 'event';
  return 'unknown';
}
