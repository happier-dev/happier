import {
  redactBugReportSensitiveText,
  trimBugReportTextToMaxBytes,
} from '@happier-dev/plugin-sdk';
import { classifyProviderLimitEvidence } from '@happier-dev/plugin-sdk/first-party/connected-accounts';

const PI_PROVIDER_TOKEN_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/gu;
const SAFE_PROVIDER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export type PiProviderFailureDiagnostic = Readonly<{
  classification: 'pi_provider_failure';
  code: string;
  sanitizedPreview: string;
  piRetryable: boolean;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = trimBugReportTextToMaxBytes(
    redactBugReportSensitiveText(value).replace(PI_PROVIDER_TOKEN_PATTERN, '[redacted-provider-token]'),
    500,
  ).replace(/\s+/gu, ' ').trim();
  return sanitized || null;
}

function normalizeCode(value: unknown): string | null {
  const code = typeof value === 'string' ? value.trim() : '';
  return SAFE_PROVIDER_CODE_PATTERN.test(code) ? code : null;
}

function parseProviderError(value: string): Readonly<Record<string, unknown>> | null {
  if (value.length > 10_000) return null;
  const jsonStart = value.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(value.slice(jsonStart));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readLeadingHttpStatus(value: string): number | null {
  const match = /^\s*([1-5]\d{2})\s*:?(?:\s|\{)/u.exec(value);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

export function readPiProviderFailureDiagnostic(
  record: Readonly<Record<string, unknown>>,
): PiProviderFailureDiagnostic | null {
  const message = isRecord(record.message) ? record.message : null;
  if (message?.role !== 'assistant') return null;
  const stopReason = typeof (message.stopReason ?? message.stop_reason) === 'string'
    ? String(message.stopReason ?? message.stop_reason).trim()
    : '';
  const raw = [
    message.happierRequestAuthProviderDiagnostic,
    message.errorMessage,
    message.error_message,
    record.errorMessage,
    record.error_message,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (stopReason !== 'error' && !raw) return null;

  const parsed = raw ? parseProviderError(raw) : null;
  const parsedError = isRecord(parsed?.error) ? parsed.error : null;
  const code = normalizeCode(parsedError?.code)
    ?? normalizeCode(parsed?.code)
    ?? 'pi_provider_session_error';
  const sanitizedPreview = sanitizeText(
    parsedError?.message
      ?? parsedError?.errorMessage
      ?? parsed?.message,
  ) ?? 'Pi provider session failed';
  const httpStatus = raw ? readLeadingHttpStatus(raw) : null;
  const limitEvidence = classifyProviderLimitEvidence(parsed
    ? { ...parsed, ...(httpStatus === null ? {} : { status: httpStatus }) }
    : record);
  return Object.freeze({
    classification: 'pi_provider_failure',
    code,
    sanitizedPreview,
    piRetryable: limitEvidence.piRetryable === true || (
      limitEvidence.confidence === 'high'
      && (limitEvidence.category === 'capacity' || limitEvidence.category === 'rate_limit')
    ),
  });
}

export function readPiPromptRejectionDiagnostic(
  value: unknown,
): PiProviderFailureDiagnostic {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  const parsed = parseProviderError(raw);
  const parsedError = isRecord(parsed?.error) ? parsed.error : null;
  const code = normalizeCode(parsedError?.code)
    ?? normalizeCode(parsed?.code)
    ?? 'pi_provider_session_error';
  const parsedMessage = sanitizeText(parsedError?.message ?? parsed?.message);
  const rawMessage = /^provider session failed$/iu.test(raw.trim()) ? null : sanitizeText(raw);
  const message = parsedMessage ?? rawMessage;
  return Object.freeze({
    classification: 'pi_provider_failure',
    code,
    sanitizedPreview: message
      ? `Pi provider rejected the prompt before acceptance: ${message}`
      : 'Pi provider rejected the prompt before acceptance without details',
    piRetryable: false,
  });
}
