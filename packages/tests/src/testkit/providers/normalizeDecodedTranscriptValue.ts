import { parseSerializedJsonValue } from '@happier-dev/protocol';

export function normalizeDecodedTranscriptValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return parseSerializedJsonValue(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.__happierSerializedJsonValueV1 !== true) {
    return value;
  }

  return parseSerializedJsonValue(JSON.stringify(candidate));
}
