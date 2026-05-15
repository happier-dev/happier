import type { SessionMessageRole } from '@happier-dev/protocol';

import { readStringProperty, readType } from './messageRoleClassificationPrimitives';

const CODEX_EVENT_TYPES = new Set([
  'tool-call',
  'tool-call-result',
  'tool-result',
  'token_count',
  'reasoning',
  'agent_reasoning',
  'thinking',
  'task_started',
  'task_complete',
  'turn_failed',
  'turn_cancelled',
  'turn_aborted',
  'context-compaction',
  'permission-request',
  'file-edit',
  'terminal-output',
]);

export function resolveCodexSessionMessageRole(body: unknown): SessionMessageRole {
  const type = readType(body);
  if (type === 'message' || type === 'agent_message') {
    return readStringProperty(body, 'role') === 'user' ? 'user' : 'agent';
  }
  if (type && CODEX_EVENT_TYPES.has(type)) return 'event';
  return 'unknown';
}
