export type ClaudeTaskNotification = Readonly<{
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  summary: string | null;
  result: string | null;
  sourceSessionId?: string;
  uuid?: string;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTextContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const texts: string[] = [];
  for (const item of value) {
    const text = readString(readRecord(item)?.text);
    if (text) texts.push(text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

function readEnvelopeText(row: Record<string, unknown>): string | null {
  if (row.type === 'user') {
    return readTextContent(readRecord(row.message)?.content);
  }
  if (row.type === 'queue-operation' && row.operation === 'enqueue') {
    return readTextContent(row.content);
  }
  if (row.type === 'attachment') {
    const attachment = readRecord(row.attachment);
    return attachment?.type === 'queued_command'
      ? readString(attachment.prompt)
      : null;
  }
  return null;
}

function readXmlTag(source: string, tag: string): string | null {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1] !== undefined ? readString(match[1]) : null;
}

export function parseClaudeTaskNotification(value: unknown): ClaudeTaskNotification | null {
  const row = readRecord(value);
  if (!row) return null;
  const text = readEnvelopeText(row);
  if (!text || !/^\s*<task-notification\b/i.test(text)) return null;

  const sourceSessionId = readString(row.session_id) ?? readString(row.sessionId) ?? undefined;
  const uuid = readString(row.uuid) ?? undefined;
  return {
    taskId: readXmlTag(text, 'task-id'),
    toolUseId: readXmlTag(text, 'tool-use-id'),
    status: readXmlTag(text, 'status'),
    summary: readXmlTag(text, 'summary'),
    result: readXmlTag(text, 'result'),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(uuid ? { uuid } : {}),
  };
}
