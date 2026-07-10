function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
