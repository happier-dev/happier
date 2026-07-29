function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }

  const record = asRecord(value);
  if (!record) return value;

  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, normalizeJsonValue(record[key])]),
  );
}

export function normalizeOpenCodeSessionExportForHandoffComparison(
  text: string,
  expectedSessionId: string,
): string | null {
  try {
    const parsed = asRecord(JSON.parse(text) as unknown);
    const info = asRecord(parsed?.info);
    const messages = parsed?.messages;
    if (!parsed || !info || info.id !== expectedSessionId || !Array.isArray(messages)) {
      return null;
    }

    for (const messageValue of messages) {
      const message = asRecord(messageValue);
      const messageInfo = asRecord(message?.info);
      const parts = message?.parts;
      if (
        !message
        || !messageInfo
        || typeof messageInfo.id !== 'string'
        || messageInfo.sessionID !== expectedSessionId
        || !Array.isArray(parts)
      ) {
        return null;
      }
      for (const partValue of parts) {
        const part = asRecord(partValue);
        if (
          !part
          || typeof part.id !== 'string'
          || part.sessionID !== expectedSessionId
          || part.messageID !== messageInfo.id
        ) {
          return null;
        }
      }
    }

    const {
      projectID: _projectID,
      ...portableInfo
    } = info;
    return JSON.stringify(normalizeJsonValue({
      info: portableInfo,
      messages,
    }));
  } catch {
    return null;
  }
}

export function parseOpenCodeSessionExportRecords(text: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed;

    const record = asRecord(parsed);
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    return record ? [record, ...messages] : messages;
  } catch {
    return [];
  }
}

function decodeBase64Utf8(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

export function extractOpenCodeSessionHandoffAgentBundleRecords(
  agentBundle: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  if (agentBundle.agentId !== 'opencode' || typeof agentBundle.exportJsonBase64 !== 'string') {
    return [];
  }
  return parseOpenCodeSessionExportRecords(decodeBase64Utf8(agentBundle.exportJsonBase64));
}
