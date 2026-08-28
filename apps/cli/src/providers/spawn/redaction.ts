import { containsProviderRegisteredSensitiveValue } from '@happier-dev/protocol';

export type ProviderRedactionLease = Readonly<{
  redact: (value: string) => string;
  /** Host-private egress check over the same registered values as redaction. */
  containsSensitiveValue: (value: string) => boolean;
  values: () => readonly string[];
  add: (values: readonly string[]) => void;
  snapshotRedactor: () => (value: string) => string;
  createStreamingSanitizer: () => ProviderStreamingSanitizer;
  close: () => void;
}>;

export type ProviderStreamingSanitizer = Readonly<{
  push: (chunk: string | Uint8Array) => string;
  flush: () => string;
}>;

function buildProviderRedactor(values: readonly string[]): (value: string) => string {
  const ordered = [...new Set(values)].sort((left, right) => right.length - left.length);
  return (value: string) => {
    let result = value;
    for (const secret of ordered) result = result.split(secret).join('[REDACTED]');
    return result;
  };
}

function buildProviderStreamingSanitizer(
  readValues: () => readonly string[],
): ProviderStreamingSanitizer {
  const knownValues = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let pending = '';
  let flushed = false;

  const readOrderedValues = (): readonly string[] => {
    for (const value of readValues()) knownValues.add(value);
    return [...knownValues].sort((left, right) => right.length - left.length);
  };

  const emitSafePrefix = (): string => {
    const ordered = readOrderedValues();
    const maxValueLength = Math.max(1, ...ordered.map((value) => value.length));
    const boundary = Math.max(0, pending.length - (maxValueLength - 1));
    let cursor = 0;
    let output = '';
    while (cursor < boundary) {
      const match = ordered.find((value) => pending.startsWith(value, cursor));
      if (match) {
        output += '[REDACTED]';
        cursor += match.length;
      } else {
        output += pending[cursor];
        cursor += 1;
      }
    }
    pending = pending.slice(cursor);
    return output;
  };

  return Object.freeze({
    push(chunk) {
      if (flushed) throw new Error('Provider streaming sanitizer is already flushed');
      pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      return emitSafePrefix();
    },
    flush() {
      if (flushed) return '';
      flushed = true;
      pending += decoder.decode();
      const output = buildProviderRedactor(readOrderedValues())(pending);
      pending = '';
      return output;
    },
  });
}

export function createProviderRedactionLease(input: Readonly<{
  values: readonly string[];
  onClose?: () => void;
}>): ProviderRedactionLease {
  if (input.values.some((value) => value.length === 0)) {
    throw new TypeError('Provider redaction values cannot be empty');
  }
  let active = [...new Set(input.values)].sort((left, right) => right.length - left.length);
  let activeRedactor = buildProviderRedactor(active);
  let closed = false;
  return Object.freeze({
    redact: (value: string) => activeRedactor(value),
    containsSensitiveValue: (value: string) =>
      containsProviderRegisteredSensitiveValue(value, active),
    values: () => Object.freeze([...active]),
    add: (values: readonly string[]) => {
      if (closed) throw new Error('Provider redaction lease is closed');
      if (values.some((value) => value.length === 0)) {
        throw new TypeError('Provider redaction values cannot be empty');
      }
      active = [...new Set([...active, ...values])].sort((left, right) => right.length - left.length);
      activeRedactor = buildProviderRedactor(active);
    },
    snapshotRedactor: () => buildProviderRedactor(active),
    createStreamingSanitizer: () => buildProviderStreamingSanitizer(() => active),
    close: () => {
      if (closed) return;
      closed = true;
      active = [];
      activeRedactor = (value) => value;
      input.onClose?.();
    },
  });
}
