export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v : '')).filter(Boolean);
}

export type OpenCodeEventIdentity = Readonly<{
  sessionId: string;
  messageId: string;
  record: Record<string, unknown>;
}>;

/** Native event payload locations, shared by ingress correlation and event handling. */
export function readOpenCodeEventIdentity(type: string, properties: unknown): OpenCodeEventIdentity | null {
  if (type.startsWith('server.')) return null;
  const props = asRecord(properties);
  const isSessionInfo = type === 'session.created' || type === 'session.updated' || type === 'session.deleted';
  const record = type === 'message.updated' || isSessionInfo
    ? asRecord(props?.info)
    : type === 'message.part.updated' || type === 'message.part.created'
      ? asRecord(props?.part)
      : props;
  if (!record) return null;
  const sessionId = isSessionInfo
    ? normalizeString(record.id)
    : normalizeString(record.sessionID)
      || normalizeString(record.sessionId)
      || normalizeString(record.session_id)
      || normalizeString(asRecord(record.session)?.id);
  if (!sessionId) return null;
  return {
    sessionId,
    messageId: type === 'message.updated'
      ? normalizeString(record.id)
      : normalizeString(record.messageID) || normalizeString(record.assistantMessageID),
    record,
  };
}
