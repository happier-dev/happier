import type { ClaudeGoalStatusTranscriptEvent } from '../workState/claudeGoalStatus';
import { readClaudeJsonlTimestampMs } from '../utils/claudeJsonlTimestamp';

/**
 * A native Claude Code transcript `attachment` record. The inner `attachment`
 * object is intentionally open: the router dispatches by `attachment.type` and
 * each typed handler owns the deeper parsing for its subtype.
 */
export type ClaudeAttachmentRecord = Readonly<{
  type: 'attachment';
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  attachment: Readonly<{ type: string; [key: string]: unknown }>;
}>;

/** Parsed `queued_command` attachment (a deferred/queued prompt). */
export type ClaudeQueuedCommandAttachment = Readonly<{
  prompt: string;
}>;

export type ClaudeCredentialOrganizationAttachment = Readonly<{
  sourceSessionId: string;
  organizationId: string | null;
  timestampMs: number;
}>;

/**
 * Typed dispatch callbacks for {@link routeClaudeAttachment}. All optional and
 * forward-compatible: unknown `attachment.type` values are ignored (or routed
 * to `onUnknown` when provided).
 */
export type ClaudeAttachmentHandlers = Readonly<{
  onGoalStatus?: (event: ClaudeGoalStatusTranscriptEvent) => void;
  onQueuedCommand?: (command: ClaudeQueuedCommandAttachment) => void;
  onCredentialOrganization?: (event: ClaudeCredentialOrganizationAttachment) => void;
  onUnknown?: (record: ClaudeAttachmentRecord) => void;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Narrow an arbitrary transcript value to a well-formed attachment envelope.
 * Returns null for anything that is not an `attachment` record carrying an
 * `attachment.type`.
 */
export function readClaudeAttachmentRecord(value: unknown): ClaudeAttachmentRecord | null {
  const message = readRecord(value);
  if (!message || message.type !== 'attachment') return null;

  const attachment = readRecord(message.attachment);
  const attachmentType = attachment && typeof attachment.type === 'string' ? attachment.type : null;
  if (!attachment || !attachmentType) return null;

  return {
    type: 'attachment',
    ...(typeof message.uuid === 'string' ? { uuid: message.uuid } : {}),
    ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
    ...(typeof message.timestamp === 'string' ? { timestamp: message.timestamp } : {}),
    attachment: { ...attachment, type: attachmentType },
  };
}

/**
 * Parse a `queued_command` attachment's prompt. Shared by the attachment router
 * and the accepted-prompt transcript discovery so the `queued_command` literal +
 * prompt extraction live in one place.
 */
export function parseClaudeQueuedCommandAttachment(value: unknown): ClaudeQueuedCommandAttachment | null {
  const record = readClaudeAttachmentRecord(value);
  if (!record || record.attachment.type !== 'queued_command') return null;
  const prompt = record.attachment.prompt;
  return typeof prompt === 'string' && prompt.length > 0 ? { prompt } : null;
}

export function parseClaudeCredentialOrganizationAttachment(value: unknown): ClaudeCredentialOrganizationAttachment | null {
  const record = readClaudeAttachmentRecord(value);
  if (!record || record.attachment.type !== 'credential_org') return null;
  const timestampMs = readClaudeJsonlTimestampMs(record);
  const sourceSessionId = record.sessionId?.trim();
  if (!sourceSessionId || timestampMs === null) return null;
  const organizationUuid = record.attachment.organizationUuid;
  return {
    sourceSessionId,
    organizationId: typeof organizationUuid === 'string' && organizationUuid.trim() ? organizationUuid.trim() : null,
    timestampMs,
  };
}
