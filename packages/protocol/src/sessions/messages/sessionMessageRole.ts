import { z } from 'zod';

export const SESSION_MESSAGE_ROLES = ['user', 'agent', 'event', 'unknown'] as const;

export const SessionMessageRoleSchema = z.enum(SESSION_MESSAGE_ROLES);

export type SessionMessageRole = z.infer<typeof SessionMessageRoleSchema>;

export type TranscriptBodySessionMessageProtocol = 'acp' | 'codex';

export type ResolveTranscriptBodySessionMessageRoleInput = Readonly<{
  protocol: TranscriptBodySessionMessageProtocol;
  body: unknown;
}>;

export type ResolvedTranscriptBodySemanticEvent = Readonly<{
  role: Exclude<SessionMessageRole, 'unknown'>;
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

const TRANSCRIPT_BODY_WRAPPER_PROTOCOLS = new Map<string, TranscriptBodySessionMessageProtocol>([
  ['acp', 'acp'],
  ['codex', 'codex'],
  ['event', 'acp'],
  ['output', 'acp'],
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveTranscriptBodyCarrier(
  input: ResolveTranscriptBodySessionMessageRoleInput,
): Readonly<{ protocol: TranscriptBodySessionMessageProtocol; body: Record<string, unknown> }> | null {
  const outer = asRecord(input.body);
  const outerType = readNonEmptyString(outer?.type);
  if (!outer || !outerType) return null;
  const wrapperProtocol = TRANSCRIPT_BODY_WRAPPER_PROTOCOLS.get(outerType);
  if (!wrapperProtocol) return Object.freeze({ protocol: input.protocol, body: outer });
  const body = asRecord(outer.data);
  return body ? Object.freeze({ protocol: wrapperProtocol, body }) : null;
}

export function resolveTranscriptBodySessionMessageRole(
  input: ResolveTranscriptBodySessionMessageRoleInput,
): SessionMessageRole {
  const carrier = resolveTranscriptBodyCarrier(input);
  if (!carrier) return 'unknown';
  const { body: record, protocol } = carrier;
  const type = readNonEmptyString(record.type);
  if (!type) return 'unknown';

  if (type === 'text') {
    return readNonEmptyString(record.role) === 'user' ? 'user' : 'agent';
  }

  if (protocol === 'acp') {
    if (TRANSCRIPT_BODY_ASSISTANT_MESSAGE_TYPES.has(type)) return 'agent';
    return ACP_TRANSCRIPT_BODY_EVENT_TYPES.has(type) ? 'event' : 'unknown';
  }

  if (TRANSCRIPT_BODY_ASSISTANT_MESSAGE_TYPES.has(type)) {
    return readNonEmptyString(record?.role) === 'user' ? 'user' : 'agent';
  }
  return CODEX_TRANSCRIPT_BODY_EVENT_TYPES.has(type) ? 'event' : 'unknown';
}

/**
 * Converts a provider-shaped transcript body into the one body and semantic
 * role pair that host transcript writers consume. Wrapper normalization lives
 * here so callers never each parse ACP/Codex envelopes independently.
 */
export function resolveTranscriptBodySemanticEvent(
  input: ResolveTranscriptBodySessionMessageRoleInput,
): ResolvedTranscriptBodySemanticEvent | null {
  const carrier = resolveTranscriptBodyCarrier(input);
  if (!carrier) return null;
  const { body } = carrier;

  const type = readNonEmptyString(body.type);
  if (!type) return null;
  if (type === 'text') {
    if (typeof body.text !== 'string') return null;
    return Object.freeze({
      role: readNonEmptyString(body.role) === 'user' ? 'user' : 'agent',
      body: Object.freeze({ type: 'message', message: body.text }),
    });
  }

  const role = resolveTranscriptBodySessionMessageRole({
    protocol: carrier.protocol,
    body,
  });
  return role === 'unknown' ? null : Object.freeze({ role, body });
}
