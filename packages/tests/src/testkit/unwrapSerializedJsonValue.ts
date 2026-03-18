import { parseSerializedJsonValue } from '@happier-dev/protocol';

export function unwrapSerializedJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return parseSerializedJsonValue(value);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.__happierSerializedJsonValueV1 !== true) {
    return value;
  }

  return parseSerializedJsonValue(JSON.stringify(candidate));
}
