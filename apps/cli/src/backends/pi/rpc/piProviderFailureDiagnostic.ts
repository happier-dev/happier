import { redactBugReportSensitiveText } from '@happier-dev/protocol';

const PI_PROVIDER_TOKEN_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/gu;
const SAFE_PROVIDER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 500;

export type PiProviderFailureDiagnostic = Readonly<{
  classification: 'pi_provider_failure';
  code: string;
  sanitizedPreview: string;
}>;

type FailureKind = 'turn_failed' | 'assistant_message_end' | 'post_acceptance_prompt' | 'prompt_rejected';

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = redactBugReportSensitiveText(value)
    .replace(PI_PROVIDER_TOKEN_PATTERN, '[redacted-provider-token]')
    .replace(/\s+/gu, ' ')
    .trim();
  return sanitized ? sanitized.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH) : null;
}

function normalizeCode(value: unknown): string | null {
  const code = typeof value === 'string' ? value.trim() : '';
  return SAFE_PROVIDER_CODE_PATTERN.test(code) ? code : null;
}

function normalizeStatus(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
    return String(value);
  }
  if (typeof value !== 'string') return null;
  const status = value.trim();
  return /^[1-5]\d{2}$/u.test(status) ? status : null;
}

function parseProviderErrorText(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length > 10_000) return null;
  const jsonStart = value.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    return asRecord(JSON.parse(value.slice(jsonStart)));
  } catch {
    return null;
  }
}

function readStructuredFields(payload: Record<string, unknown>): {
  code: string | null;
  status: string | null;
  message: string | null;
} {
  const messageRecord = asRecord(payload.message);
  const rawErrorText = messageRecord?.errorMessage
    ?? messageRecord?.error_message
    ?? payload.errorMessage
    ?? payload.error_message;
  const parsedText = parseProviderErrorText(rawErrorText);
  const parsedError = asRecord(parsedText?.error);
  const nestedError = asRecord(payload.error);
  const nestedData = asRecord(payload.data);

  const code = [
    parsedError?.code,
    parsedText?.code,
    payload.code,
    payload.errorCode,
    payload.error_code,
    nestedError?.code,
    nestedData?.code,
  ].map(normalizeCode).find((value): value is string => value !== null) ?? null;
  const statusFromText = typeof rawErrorText === 'string'
    ? /^\s*([1-5]\d{2})\s*:/u.exec(rawErrorText)?.[1] ?? null
    : null;
  const status = [
    statusFromText,
    parsedError?.status,
    parsedText?.status,
    payload.status,
    payload.statusCode,
    payload.status_code,
    nestedError?.status,
    nestedData?.status,
  ].map(normalizeStatus).find((value): value is string => value !== null) ?? null;
  const message = [
    parsedError?.message,
    parsedError?.errorMessage,
    parsedText?.message,
    payload.errorMessage,
    payload.error_message,
    payload.detail,
    typeof payload.error === 'string' ? payload.error : null,
  ].map(sanitizeText).find((value): value is string => value !== null) ?? null;

  return { code, status, message };
}

function diagnosticPrefix(kind: FailureKind): string {
  switch (kind) {
    case 'turn_failed':
      return 'Pi provider reported turn_failed';
    case 'assistant_message_end':
      return 'Pi provider reported provider failure';
    case 'post_acceptance_prompt':
      return 'Pi provider reported provider session failure';
    case 'prompt_rejected':
      return 'Pi provider rejected the prompt before acceptance';
  }
}

export function normalizePiProviderFailure(
  kind: FailureKind,
  payload: Record<string, unknown>,
): PiProviderFailureDiagnostic {
  const fields = readStructuredFields(payload);
  const message = (kind === 'post_acceptance_prompt' || kind === 'prompt_rejected')
    && /^provider session failed$/iu.test(fields.message ?? '')
    ? null
    : fields.message;
  const details = [
    fields.code ? `code=${fields.code}` : null,
    fields.status ? `status=${fields.status}` : null,
    message ? `message=${message}` : null,
  ].filter((value): value is string => value !== null);
  const bareSuffix = kind === 'assistant_message_end'
    ? ' without details after prompt acceptance'
    : kind === 'prompt_rejected'
      ? ' without details'
    : kind === 'post_acceptance_prompt'
      ? ' after prompt acceptance'
      : ' without details after prompt acceptance';
  const sanitizedPreview = details.length > 0
    ? `${diagnosticPrefix(kind)}${kind === 'prompt_rejected' ? '' : ' after prompt acceptance'}: ${details.join(', ')}`.slice(0, 2_000)
    : `${diagnosticPrefix(kind)}${bareSuffix}`;
  return Object.freeze({
    classification: 'pi_provider_failure',
    code: fields.code ?? 'pi_provider_session_error',
    sanitizedPreview,
  });
}

export function createPiProviderFailureError(
  failure: PiProviderFailureDiagnostic,
): Error & { piProviderFailure: PiProviderFailureDiagnostic } {
  return Object.assign(new Error(failure.sanitizedPreview), { piProviderFailure: failure });
}
