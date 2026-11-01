import { RawJSONLinesSchema, type RawJSONLines } from '../types';
import { projectClaudePeerMessage } from '../attachments/claudePeerMessageProjection';
import { projectClaudeTaskLifecycleToolResult } from '../taskNotifications/claudeTaskLifecycleEnvelope';

export function parseRawJsonLinesObject(value: unknown): RawJSONLines | null {
  const peerMessage = projectClaudePeerMessage(value);
  if (peerMessage) return peerMessage;
  const taskResult = projectClaudeTaskLifecycleToolResult(value);
  if (taskResult) return taskResult;
  const parsed = RawJSONLinesSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

export function parseRawJsonLinesLine(line: string): RawJSONLines | null {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return parseRawJsonLinesObject(obj);
}
