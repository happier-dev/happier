export function getToolCallNameKey(provider: string, callId: string): string {
  return `${provider}:${callId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isEmptyObject(value: unknown): boolean {
  const record = asRecord(value);
  return !!record && Object.keys(record).length === 0;
}

export function extractPermissionToolCallRawInput(options: unknown): unknown | null {
  const record = asRecord(options);
  if (!record) return null;

  const candidates = [record, asRecord(record.options)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const toolCallRecord = asRecord(candidate.toolCall);
    if (!toolCallRecord) continue;

    if (toolCallRecord.rawInput != null) return toolCallRecord.rawInput;

    // Gemini ACP uses `toolCall.content` + `toolCall.locations` and leaves `input={}`.
    if (Array.isArray(toolCallRecord.content)) {
      const locations = Array.isArray(toolCallRecord.locations) ? toolCallRecord.locations : [];
      return { items: toolCallRecord.content, locations };
    }

    if (typeof toolCallRecord.title === 'string' && toolCallRecord.title.trim().length > 0) {
      return { title: toolCallRecord.title };
    }
  }

  return null;
}

export function backfillPermissionRequestOptionsInput(options: unknown, rawInputHint: unknown): unknown {
  if (rawInputHint == null) return options;
  const record = asRecord(options);
  if (!record) return options;

  // Most ACP providers nest their permission UI payload under `options.options`.
  const nested = asRecord(record.options);
  if (nested && isEmptyObject(nested.input)) {
    return { ...record, options: { ...nested, input: rawInputHint } };
  }

  // Some providers may place `input` at the top level.
  if (isEmptyObject(record.input)) {
    return { ...record, input: rawInputHint };
  }

  return options;
}
