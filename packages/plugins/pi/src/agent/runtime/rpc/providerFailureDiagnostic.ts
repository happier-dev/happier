import { projectSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import {
  redactBugReportSensitiveText,
  trimBugReportTextToMaxBytes,
} from '@happier-dev/plugin-sdk';
import { classifyProviderLimitEvidence } from '@happier-dev/plugin-sdk/connected-accounts';

const PI_PROVIDER_TOKEN_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/gu;
const HAPPIER_BROKER_BRIDGE_RETRYABLE_STATUS_PATTERN =
  /\bhappier_broker_bridge_status_5\d\d\b/iu;
const SAFE_PROVIDER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/u;

export type PiProviderFailureDiagnostic = Readonly<{
  classification: 'pi_provider_failure';
  code: string;
  sanitizedPreview: string;
  piRetryable: boolean;
  failureCause?: ReturnType<typeof projectSessionRuntimeFailureCause>;
}>;

export type PiProviderFailureLogEvidence = Readonly<{
  record: Readonly<Record<string, string | number | boolean | null>>;
  messageShape?: Readonly<Record<string, string | number | boolean | null>>;
}>;

const SAFE_FAILURE_RECORD_KEYS = [
  'type',
  'code',
  'errorCode',
  'error_code',
  'status',
  'statusCode',
  'success',
  'retryable',
  'willRetry',
  'attempt',
  'maxAttempts',
  'provider',
  'model',
  'modelId',
  'turnId',
] as const;

const SAFE_FAILURE_MESSAGE_KEYS = [
  'role',
  'provider',
  'model',
  'modelId',
  'stopReason',
  'stop_reason',
] as const;

function normalizeProviderIdentifier(value: unknown): string | null {
  return typeof value === 'string' && SAFE_PROVIDER_IDENTIFIER_PATTERN.test(value)
    ? value
    : null;
}

function readSafeScalar(
  key: string,
  value: unknown,
): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (key === 'provider' || key === 'model' || key === 'modelId') {
    return normalizeProviderIdentifier(value) ?? undefined;
  }
  return normalizeCode(value) ?? undefined;
}

function projectSafeScalars(
  source: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, string | number | boolean | null>> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const value = readSafeScalar(key, source[key]);
    if (value !== undefined) result[key] = value;
  }
  return Object.freeze(result);
}

/** Safe structured context for default-on logs; prompt/content/error bodies never enter it. */
export function buildPiProviderFailureLogEvidence(
  record: Readonly<Record<string, unknown>>,
): PiProviderFailureLogEvidence {
  const message = isRecord(record.message) ? record.message : null;
  const messageShape = message ? projectSafeScalars(message, SAFE_FAILURE_MESSAGE_KEYS) : null;
  return Object.freeze({
    record: projectSafeScalars(record, SAFE_FAILURE_RECORD_KEYS),
    ...(messageShape && Object.keys(messageShape).length > 0 ? { messageShape } : {}),
  });
}

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

function hasProviderTimeoutEvidence(...values: Array<string | null>): boolean {
  return values.some((value) => value !== null && /\b(?:timeout|timed out|etimedout)\b/iu.test(value));
}

function hasRetryableHappierBrokerBridgeEvidence(...values: Array<string | null>): boolean {
  return values.some((value) => (
    value !== null && HAPPIER_BROKER_BRIDGE_RETRYABLE_STATUS_PATTERN.test(value)
  ));
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

function isRetryablePiProviderFailure(params: Readonly<{
  code: string | null;
  message: string | null;
  evidence: unknown;
}>): boolean {
  const limitEvidence = classifyProviderLimitEvidence(params.evidence);
  return hasProviderTimeoutEvidence(params.code, params.message)
    || hasRetryableHappierBrokerBridgeEvidence(params.code, params.message)
    || (
      limitEvidence.confidence === 'high'
      && (limitEvidence.category === 'capacity' || limitEvidence.category === 'rate_limit')
    );
}

function readProviderFailureFields(
  record: Readonly<Record<string, unknown>>,
  message: Readonly<Record<string, unknown>> | null,
): Readonly<{
  code: string | null;
  message: string | null;
  parsed: Readonly<Record<string, unknown>> | null;
  httpStatus: number | null;
}> {
  const raw = [
    message?.happierRequestAuthProviderDiagnostic,
    message?.errorMessage,
    message?.error_message,
    record.errorMessage,
    record.error_message,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const parsed = raw ? parseProviderError(raw) : null;
  const parsedError = isRecord(parsed?.error) ? parsed.error : null;
  const errorInfoReasons = Array.isArray(parsedError?.details)
    ? parsedError.details.flatMap(detail => isRecord(detail)
      && detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' ? [detail.reason] : [])
    : [];
  const nativeStatus = parsedError?.code;
  const nestedError = isRecord(record.error) ? record.error : null;
  const nestedData = isRecord(record.data) ? record.data : null;
  return Object.freeze({
    code: [
      ...errorInfoReasons,
      parsedError?.code,
      parsed?.code,
      record.code,
      record.errorCode,
      record.error_code,
      nestedError?.code,
      nestedData?.code,
    ].map(normalizeCode).find((value): value is string => value !== null) ?? null,
    message: [
      parsedError?.message,
      parsedError?.errorMessage,
      parsed?.message,
      nestedError?.message,
      nestedError?.errorMessage,
      nestedData?.message,
      record.detail,
      typeof record.error === 'string' ? record.error : null,
      raw,
    ].map(sanitizeText).find((value): value is string => value !== null) ?? null,
    parsed,
    httpStatus: (raw ? readLeadingHttpStatus(raw) : null)
      ?? (typeof nativeStatus === 'number' && Number.isInteger(nativeStatus)
        && nativeStatus >= 100 && nativeStatus <= 599 ? nativeStatus : null),
  });
}

function projectDecodedProviderFailureCause(
  record: Readonly<Record<string, unknown>>,
  fields: ReturnType<typeof readProviderFailureFields>,
  phase: 'turn' | 'turn_start',
) {
  if (!fields.code) return undefined;
  // Project the decoded code/status, never the provider body or prompt echo.
  return projectSessionRuntimeFailureCause({
    ...record,
    code: fields.code,
    ...(fields.httpStatus === null ? {} : { status: fields.httpStatus }),
  }, phase, 'agent.turn');
}

export function readPiProviderFailureDiagnostic(
  record: Readonly<Record<string, unknown>>,
): PiProviderFailureDiagnostic | null {
  const message = isRecord(record.message) ? record.message : null;
  const isTurnFailed = record.type === 'turn_failed';
  if (!isTurnFailed && message?.role !== 'assistant') return null;
  const rawStopReason = message?.stopReason ?? message?.stop_reason;
  const stopReason = typeof rawStopReason === 'string'
    ? rawStopReason.trim()
    : '';
  const fields = readProviderFailureFields(record, message);
  if (!isTurnFailed && stopReason !== 'error' && !fields.parsed && !fields.message) return null;

  const isTimeout = hasProviderTimeoutEvidence(fields.code, fields.message);
  const code = fields.code ?? (isTimeout ? 'provider_timeout' : 'pi_provider_session_error');
  const sanitizedPreview = fields.message ?? 'Pi provider session failed';
  const retryEvidence = fields.parsed
    ? { ...record, ...fields.parsed, ...(fields.httpStatus === null ? {} : { status: fields.httpStatus }) }
    : record;
  return Object.freeze({
    classification: 'pi_provider_failure',
    code,
    sanitizedPreview,
    failureCause: projectDecodedProviderFailureCause(record, fields, 'turn'),
    piRetryable: isRetryablePiProviderFailure({
      code,
      message: fields.message,
      evidence: retryEvidence,
    }),
  });
}

export function readPiPromptRejectionDiagnostic(
  value: unknown,
): PiProviderFailureDiagnostic {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  const fields = readProviderFailureFields({ errorMessage: raw }, null);
  const parsed = fields.parsed;
  const parsedError = isRecord(parsed?.error) ? parsed.error : null;
  const code = fields.code ?? 'pi_provider_session_error';
  const parsedMessage = sanitizeText(parsedError?.message ?? parsed?.message);
  const rawMessage = /^provider session failed$/iu.test(raw.trim()) ? null : sanitizeText(raw);
  const message = parsedMessage ?? rawMessage;
  const httpStatus = fields.httpStatus;
  const retryEvidence = parsed
    ? { ...parsed, ...(httpStatus === null ? {} : { status: httpStatus }) }
    : { ...(httpStatus === null ? {} : { status: httpStatus }), message: raw };
  return Object.freeze({
    classification: 'pi_provider_failure',
    code,
    failureCause: projectDecodedProviderFailureCause(isRecord(value) ? value : {}, fields, 'turn_start'),
    sanitizedPreview: message
      ? `Pi provider rejected the prompt before acceptance: ${message}`
      : 'Pi provider rejected the prompt before acceptance without details',
    piRetryable: isRetryablePiProviderFailure({ code, message, evidence: retryEvidence }),
  });
}
