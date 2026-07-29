import { trimUtf8TextToMaxBytes } from './utf8.js';

const QUOTED_SECRET_FIELD_PATTERN =
  /(["'])(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|session(?:id)?|password|token|secret)\1\s*:\s*(["'])(?:\\.|(?!\3).)*\3/gi;

const SENSITIVE_DIAGNOSTIC_VALUES_REGISTRY_KEY = Symbol.for(
  'happier.protocol.sensitiveDiagnosticValues.v2',
);

type SensitiveDiagnosticValuesController = Readonly<{
  register: (values: readonly string[]) => (() => void);
  redact: (input: string) => string;
}>;

function isSensitiveDiagnosticValuesController(value: unknown): value is SensitiveDiagnosticValuesController {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.register === 'function' && typeof record.redact === 'function';
}

function createSensitiveDiagnosticValuesController(): SensitiveDiagnosticValuesController {
  const activeValues = new Map<string, number>();
  return Object.freeze({
    register: (values: readonly string[]) => {
      for (const value of values) {
        activeValues.set(value, (activeValues.get(value) ?? 0) + 1);
      }
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        for (const value of values) {
          const count = activeValues.get(value);
          if (count === undefined || count <= 1) {
            activeValues.delete(value);
          } else {
            activeValues.set(value, count - 1);
          }
        }
      };
    },
    redact: (input: string) => {
      const values = [...activeValues.keys()].sort((left, right) => right.length - left.length);
      let output = input;
      for (const value of values) {
        output = output.split(value).join('[REDACTED]');
      }
      return output;
    },
  });
}

function readSensitiveDiagnosticValuesController(): SensitiveDiagnosticValuesController {
  const existing = Reflect.get(globalThis, SENSITIVE_DIAGNOSTIC_VALUES_REGISTRY_KEY) as unknown;
  if (isSensitiveDiagnosticValuesController(existing)) return existing;
  const created = createSensitiveDiagnosticValuesController();
  Object.defineProperty(globalThis, SENSITIVE_DIAGNOSTIC_VALUES_REGISTRY_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: created,
  });
  return created;
}

export type SensitiveDiagnosticValuesLease = Readonly<{
  close: () => void;
}>;

function expandSensitiveDiagnosticValueVariants(value: string): readonly string[] {
  const variants = new Set<string>([value, JSON.stringify(value).slice(1, -1)]);
  try {
    variants.add(encodeURIComponent(value));
    variants.add(new URLSearchParams({ value }).toString().slice('value='.length));
  } catch {
    // A malformed lone surrogate still remains protected in its raw and JSON-escaped forms.
  }
  return [...variants].filter((variant) => variant.length > 0);
}

/**
 * Registers exact sensitive values for diagnostic redaction during a bounded runtime lifetime.
 * The registry intentionally exposes no read surface; callers retain and close only their lease.
 */
export function registerSensitiveDiagnosticValues(values: readonly string[]): SensitiveDiagnosticValuesLease {
  if (values.some((value) => value.length === 0)) {
    throw new TypeError('Sensitive diagnostic values cannot contain an empty value');
  }
  const uniqueValues = [...new Set(values.flatMap(expandSensitiveDiagnosticValueVariants))];
  const close = readSensitiveDiagnosticValuesController().register(uniqueValues);
  return Object.freeze({
    close,
  });
}

function redactRegisteredSensitiveDiagnosticValues(input: string): string {
  return readSensitiveDiagnosticValuesController().redact(input);
}

export function redactBugReportSensitiveText(input: string): string {
  return redactRegisteredSensitiveDiagnosticValues(String(input ?? ''))
    .replace(
      QUOTED_SECRET_FIELD_PATTERN,
      (_match, keyQuote: string, key: string, valueQuote: string) =>
        `${keyQuote}${key}${keyQuote}: ${valueQuote}[REDACTED]${valueQuote}`,
    )
    .replace(/\bauthorization\s*:\s*bearer\s+[^\r\n]+/gi, 'authorization: bearer [REDACTED]')
    .replace(/\bauthorization\s*:\s*basic\s+[^\r\n]+/gi, 'authorization: basic [REDACTED]')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, (_match, key: string) => `${key.toLowerCase()}: [REDACTED]`)
    .replace(/\bx-api-key\s*:\s*[^\r\n]+/gi, 'x-api-key: [REDACTED]')
    .replace(/\b(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|session(?:id)?)\s*[:=]\s*['"]?\S+/gi, (_match, key: string) => `${key}: [REDACTED]`)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g, '[REDACTED]')
    .replace(/\b(A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\b(password|token|secret)\s*[:=]\s*\S+/gi, (_match, key: string) => `${key}: [REDACTED]`);
}

export function trimBugReportTextToMaxBytes(input: string, maxBytes: number): string {
  return trimUtf8TextToMaxBytes(input, maxBytes);
}
