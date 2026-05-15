import type { SessionMessageRole } from '@happier-dev/protocol';

import { asRecord, readNestedProperty, readType } from './messageRoleClassificationPrimitives';

const CLAUDE_EVENT_TYPES = new Set(['summary', 'system', 'progress']);
const CLAUDE_TOOL_BLOCK_TYPES = new Set(['tool_use', 'tool_result']);

function readClaudeContent(body: unknown): unknown {
  return readNestedProperty(readNestedProperty(body, 'message'), 'content');
}

function contentBlocks(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [];
}

function hasToolBlock(content: unknown): boolean {
  return contentBlocks(content).some((block) => {
    const type = readType(block);
    return type !== null && CLAUDE_TOOL_BLOCK_TYPES.has(type);
  });
}

function hasTextBlock(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return contentBlocks(content).some((block) => {
    const record = asRecord(block);
    return record?.type === 'text' && typeof record.text === 'string' && record.text.trim().length > 0;
  });
}

export function resolveClaudeSessionMessageRole(body: unknown): SessionMessageRole {
  const type = readType(body);
  if (type === 'user') {
    const content = readClaudeContent(body);
    if (hasToolBlock(content)) return 'event';
    return hasTextBlock(content) ? 'user' : 'event';
  }
  if (type === 'assistant') {
    const content = readClaudeContent(body);
    return hasTextBlock(content) ? 'agent' : 'event';
  }
  if (type && CLAUDE_EVENT_TYPES.has(type)) return 'event';
  return 'unknown';
}
