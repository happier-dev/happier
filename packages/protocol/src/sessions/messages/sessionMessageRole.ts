import { z } from 'zod';

export const SESSION_MESSAGE_ROLES = ['user', 'agent', 'event', 'unknown'] as const;

export const SessionMessageRoleSchema = z.enum(SESSION_MESSAGE_ROLES);

export type SessionMessageRole = z.infer<typeof SessionMessageRoleSchema>;

export type TranscriptBodySessionMessageProtocol = 'acp' | 'codex';

export type ResolveTranscriptBodySessionMessageRoleInput = Readonly<{
  protocol: TranscriptBodySessionMessageProtocol;
  body: unknown;
}>;

const TRANSCRIPT_BODY_ASSISTANT_MESSAGE_TYPES = new Set(['message', 'agent_message']);

const ACP_TRANSCRIPT_BODY_EVENT_TYPES = new Set([
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

const CODEX_TRANSCRIPT_BODY_EVENT_TYPES = new Set([
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveTranscriptBodySessionMessageRole(
  input: ResolveTranscriptBodySessionMessageRoleInput,
): SessionMessageRole {
  const record = asRecord(input.body);
  const type = readNonEmptyString(record?.type);
  if (!type) return 'unknown';

  if (input.protocol === 'acp') {
    if (TRANSCRIPT_BODY_ASSISTANT_MESSAGE_TYPES.has(type)) return 'agent';
    return ACP_TRANSCRIPT_BODY_EVENT_TYPES.has(type) ? 'event' : 'unknown';
  }

  if (TRANSCRIPT_BODY_ASSISTANT_MESSAGE_TYPES.has(type)) {
    return readNonEmptyString(record?.role) === 'user' ? 'user' : 'agent';
  }
  return CODEX_TRANSCRIPT_BODY_EVENT_TYPES.has(type) ? 'event' : 'unknown';
}
