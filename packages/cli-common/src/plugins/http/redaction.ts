import { containsProviderRegisteredSensitiveValue } from '@happier-dev/protocol/providers/sensitive-value-redaction';
import type { HttpResponse } from './contracts.js';

export type ProviderRedactionLease = Readonly<{
  /** Current custody, including an active lease with no selected secrets. */
  isActive: () => boolean;
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
  /** HTTP bodies keep their exact bytes; text diagnostics use push/flush. */
  pushBytes: (chunk: Uint8Array) => Uint8Array;
  flushBytes: () => Uint8Array;
}>;

/** Preserve binary bytes unless a registered value is actually present. */
export function redactPluginHttpResponse(response: HttpResponse, redact: (value: string) => string): HttpResponse {
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(response.body);
  const sanitized = redact(text);
  if (sanitized !== text) new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  return { ...response, finalUrl: redact(response.finalUrl),
    headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [redact(name), redact(value)])),
    body: sanitized === text ? response.body : new TextEncoder().encode(sanitized) };
}

function bytesToLatin1(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}
function latin1ToBytes(value: string): Uint8Array {
  return Uint8Array.from(value, character => character.charCodeAt(0));
}

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
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  let pending = '';
  let flushed = false;

  const readOrderedValues = (): readonly string[] => {
    // A reversible one-code-unit-per-byte representation lets the existing
    // split-value matcher operate without decoding arbitrary response bytes.
    for (const value of readValues()) knownValues.add(bytesToLatin1(new TextEncoder().encode(value)));
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

  const pushBytes = (chunk: Uint8Array): Uint8Array => {
    if (flushed) throw new Error('Provider streaming sanitizer is already flushed');
    pending += bytesToLatin1(chunk);
    return latin1ToBytes(emitSafePrefix());
  };
  const flushBytes = (): Uint8Array => {
    if (flushed) return new Uint8Array();
    flushed = true;
    const output = buildProviderRedactor(readOrderedValues())(pending);
    pending = '';
    return latin1ToBytes(output);
  };
  return Object.freeze({
    pushBytes,
    flushBytes,
    push(chunk) {
      return decoder.decode(pushBytes(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk), { stream: true });
    },
    flush() {
      return decoder.decode(flushBytes());
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
    isActive: () => !closed,
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
