const SERIALIZED_JSON_VALUE_SENTINEL = '__happierSerializedJsonValueV1';

type SerializedJsonEnvelope =
  | {
      [SERIALIZED_JSON_VALUE_SENTINEL]: true;
      type: 'json';
      value: unknown;
    }
  | {
      [SERIALIZED_JSON_VALUE_SENTINEL]: true;
      type: 'undefined';
    };

export function stringifySerializedJsonValue(value: unknown): string {
  const envelope: SerializedJsonEnvelope =
    value === undefined
      ? {
          [SERIALIZED_JSON_VALUE_SENTINEL]: true,
          type: 'undefined',
        }
      : {
          [SERIALIZED_JSON_VALUE_SENTINEL]: true,
          type: 'json',
          value,
        };

  return JSON.stringify(envelope, (_key, currentValue) => {
    if (typeof currentValue === 'bigint') {
      return `${currentValue}n`;
    }
    return currentValue;
  });
}

export function parseSerializedJsonValue(serialized: string): unknown {
  if (serialized === 'undefined') {
    return undefined;
  }

  const parsed = JSON.parse(serialized) as unknown;
  if (!isSerializedJsonEnvelope(parsed)) {
    return parsed;
  }
  return parsed.type === 'undefined' ? undefined : parsed.value;
}

function isSerializedJsonEnvelope(value: unknown): value is SerializedJsonEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate[SERIALIZED_JSON_VALUE_SENTINEL] !== true) {
    return false;
  }
  if (candidate.type === 'undefined') {
    return true;
  }
  return candidate.type === 'json' && Object.prototype.hasOwnProperty.call(candidate, 'value');
}
