import {
  isBaseCredentialDiagnosticKey,
  redactBugReportSensitiveText,
  sanitizeBugReportUrl,
  splitSensitiveDiagnosticKeySegments,
} from '@happier-dev/protocol';

import type { DaemonLocallyPersistedState } from '@/persistence';
import type { readSettings } from '@/persistence';

const DOCTOR_REDACTED_VALUE = '<redacted>';
const DOCTOR_STRING_REDACTION_MARKER = '[redacted]';

const OMIT_DIAGNOSTIC_KEY_NORMALIZED = new Set([
  'localenvironmentvariables',
]);

const DOCTOR_CREDENTIAL_SEGMENTS = new Set([
  'auth',
  'authentication',
  'credential',
  'credentials',
  'secret',
]);

const DOCTOR_CREDENTIAL_SUFFIXES = new Set([
  'token',
]);

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/giu;
const ENV_ASSIGNMENT_PATTERN = /\b([A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s;,]+)/giu;
const CLI_EQUALS_FLAG_PATTERN = /(^|\s)(--?[A-Za-z0-9][A-Za-z0-9._-]*)(=)("[^"]*"|'[^']*'|[^\s;,]+)/giu;
const CLI_SPACE_FLAG_PATTERN = /(^|\s)(--?[A-Za-z0-9][A-Za-z0-9._-]*)(\s+)("[^"]*"|'[^']*'|[^\s;,]+)/giu;

type SettingsForDisplay = Awaited<ReturnType<typeof readSettings>>;

type RedactionState = {
  readonly seen: WeakSet<object>;
};

const SKIP_VALUE = Symbol('skip-doctor-diagnostic-value');

function normalizeDiagnosticKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function isSensitiveDoctorDiagnosticKey(key: string): boolean {
  const normalized = normalizeDiagnosticKey(key);
  if (normalized === 'notsecret' || normalized === 'notauthentication') return false;
  if (isBaseCredentialDiagnosticKey(key)) return true;
  const segments = splitSensitiveDiagnosticKeySegments(key);
  return segments.some((segment) => DOCTOR_CREDENTIAL_SEGMENTS.has(segment))
    || DOCTOR_CREDENTIAL_SUFFIXES.has(segments.at(-1) ?? '')
    || (segments.length === 1 && segments[0] === 'session')
    || segments.some((segment, index) => segment === 'session' && segments[index + 1] === 'id');
}

function shouldOmitDoctorDiagnosticKey(key: string): boolean {
  return OMIT_DIAGNOSTIC_KEY_NORMALIZED.has(normalizeDiagnosticKey(key));
}

function isProcessArgvKey(key: string): boolean {
  const normalized = normalizeDiagnosticKey(key);
  return normalized === 'argv' || normalized === 'args' || normalized === 'processargv' || normalized === 'processargs';
}

function isSensitiveCliFlagWithoutInlineValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('-') || trimmed.includes('=')) return false;
  return isSensitiveDoctorDiagnosticKey(trimmed.replace(/^-+/u, ''));
}

function redactDoctorDiagnosticUrl(rawUrl: string): string {
  const sanitizedBase = sanitizeBugReportUrl(rawUrl);
  if (!sanitizedBase) return rawUrl;

  try {
    const originalUrl = new URL(rawUrl);
    const outputUrl = new URL(sanitizedBase);
    for (const [key, value] of originalUrl.searchParams.entries()) {
      outputUrl.searchParams.append(
        key,
        isSensitiveDoctorDiagnosticKey(key)
          ? DOCTOR_STRING_REDACTION_MARKER
          : redactBugReportSensitiveText(value),
      );
    }
    return outputUrl.toString();
  } catch {
    return sanitizedBase;
  }
}

function redactUrlsWithPlaceholders(value: string): { text: string; urls: readonly string[] } {
  const urls: string[] = [];
  const text = value.replace(URL_PATTERN, (rawUrl) => {
    const placeholder = `__HAPPIER_DOCTOR_URL_${urls.length}__`;
    urls.push(redactDoctorDiagnosticUrl(rawUrl));
    return placeholder;
  });
  return { text, urls };
}

function restoreUrlPlaceholders(value: string, urls: readonly string[]): string {
  return urls.reduce(
    (output, url, index) => output.replace(`__HAPPIER_DOCTOR_URL_${index}__`, url),
    value,
  );
}

function redactDoctorAssignments(value: string): string {
  return value
    .replace(
      ENV_ASSIGNMENT_PATTERN,
      (match, key: string) =>
        isSensitiveDoctorDiagnosticKey(key) ? `${key}=${DOCTOR_STRING_REDACTION_MARKER}` : match,
    )
    .replace(
      CLI_EQUALS_FLAG_PATTERN,
      (match, prefix: string, flag: string, separator: string) =>
        isSensitiveDoctorDiagnosticKey(flag.replace(/^-+/u, ''))
          ? `${prefix}${flag}${separator}${DOCTOR_STRING_REDACTION_MARKER}`
          : match,
    )
    .replace(
      CLI_SPACE_FLAG_PATTERN,
      (match, prefix: string, flag: string, separator: string) =>
        isSensitiveDoctorDiagnosticKey(flag.replace(/^-+/u, ''))
          ? `${prefix}${flag}${separator}${DOCTOR_STRING_REDACTION_MARKER}`
          : match,
    );
}

export function redactDoctorDiagnosticText(value: string): string {
  const { text, urls } = redactUrlsWithPlaceholders(value);
  const redacted = redactDoctorAssignments(redactBugReportSensitiveText(text));
  return restoreUrlPlaceholders(redacted, urls);
}

function redactProcessArgvArray(value: readonly unknown[], state: RedactionState): readonly unknown[] {
  const output: unknown[] = [];
  let redactNext = false;

  for (const item of value) {
    if (typeof item !== 'string') {
      output.push(redactDoctorDiagnosticValueInternal(item, state));
      redactNext = false;
      continue;
    }

    if (redactNext) {
      output.push(DOCTOR_REDACTED_VALUE);
      redactNext = false;
      continue;
    }

    const redacted = redactDoctorDiagnosticText(item);
    output.push(redacted);
    redactNext = isSensitiveCliFlagWithoutInlineValue(item);
  }

  return output;
}

function redactArray(value: readonly unknown[], key: string | undefined, state: RedactionState): readonly unknown[] {
  if (key && isProcessArgvKey(key)) {
    return redactProcessArgvArray(value, state);
  }
  return value.map((item) => redactDoctorDiagnosticValueInternal(item, state));
}

function redactObject(value: object, state: RedactionState): Readonly<Record<string, unknown>> {
  if (state.seen.has(value)) {
    return { circular: true };
  }

  state.seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const redacted = redactDoctorDiagnosticValueInternal(child, state, key);
    if (redacted !== SKIP_VALUE) {
      output[key] = redacted;
    }
  }
  state.seen.delete(value);
  return output;
}

function redactDoctorDiagnosticValueInternal(
  value: unknown,
  state: RedactionState,
  key?: string,
): unknown | typeof SKIP_VALUE {
  if (key && shouldOmitDoctorDiagnosticKey(key)) return SKIP_VALUE;

  if (key && isSensitiveDoctorDiagnosticKey(key)) {
    return value === null || value === undefined || value === '' ? value : DOCTOR_REDACTED_VALUE;
  }

  if (typeof value === 'string') {
    return redactDoctorDiagnosticText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'symbol') {
    return String(value);
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return redactArray(value, key, state);
  }
  return redactObject(value, state);
}

export function redactDoctorDiagnosticValue(value: unknown): unknown {
  return redactDoctorDiagnosticValueInternal(value, { seen: new WeakSet<object>() });
}

export function redactSettingsForDisplay(settings: SettingsForDisplay): SettingsForDisplay {
  return redactDoctorDiagnosticValue(settings ?? {}) as SettingsForDisplay;
}

export function redactDaemonStateForDisplay(state: DaemonLocallyPersistedState): Record<string, unknown> {
  return redactDoctorDiagnosticValue(state ?? {}) as Record<string, unknown>;
}

export function redactDoctorProcessCommandForDisplay(command: string): string {
  return redactDoctorDiagnosticText(command);
}
