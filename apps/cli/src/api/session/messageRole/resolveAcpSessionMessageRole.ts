import type { SessionMessageRole } from '@happier-dev/protocol';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';

import { readType } from './messageRoleClassificationPrimitives';

const ACP_EVENT_TYPES = new Set([
  'reasoning',
  'thinking',
  'tool-call',
  'tool-result',
  'file-edit',
  'terminal-output',
  'task_started',
  'task_complete',
  'turn_failed',
  'turn_cancelled',
  'turn_aborted',
  'permission-request',
  'permission-response',
  'token_count',
  'context-compaction',
]);

export function resolveAcpSessionMessageRole(body: ACPMessageData | unknown): SessionMessageRole {
  const type = readType(body);
  if (type === 'message') return 'agent';
  if (type && ACP_EVENT_TYPES.has(type)) return 'event';
  return 'unknown';
}
