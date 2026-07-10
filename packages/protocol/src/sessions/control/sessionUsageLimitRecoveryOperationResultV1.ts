import { z } from 'zod';

import { ConnectedServiceUxDiagnosticV1Schema } from '../../connect/connectedServiceUxDiagnostics.js';

export const SESSION_USAGE_LIMIT_RECOVERY_OPERATION_RESULT_OK_STATUSES_V1 = [
  'ready',
  'waiting',
  'resumed',
  'switch_attempted',
  'switch_applied',
  'switch_observed',
  'already_ready',
  'no_recovery_needed',
  'cancelled',
] as const;

export const SESSION_USAGE_LIMIT_RECOVERY_OPERATION_RESULT_ERROR_STATUSES_V1 = [
  'inactive',
  'exhausted',
  'cancelled',
  'rate_limited',
  'unsupported',
  'malformed_response',
  'session_unreachable',
  'generation_apply_failed',
  'group_conflict',
  'not_found',
] as const;

export const SessionUsageLimitRecoveryOperationResultOkStatusV1Schema = z.enum(
  SESSION_USAGE_LIMIT_RECOVERY_OPERATION_RESULT_OK_STATUSES_V1,
);
export type SessionUsageLimitRecoveryOperationResultOkStatusV1 =
  z.infer<typeof SessionUsageLimitRecoveryOperationResultOkStatusV1Schema>;

export const SessionUsageLimitRecoveryOperationResultErrorStatusV1Schema = z.enum(
  SESSION_USAGE_LIMIT_RECOVERY_OPERATION_RESULT_ERROR_STATUSES_V1,
);
export type SessionUsageLimitRecoveryOperationResultErrorStatusV1 =
  z.infer<typeof SessionUsageLimitRecoveryOperationResultErrorStatusV1Schema>;

const OperationResultSessionIdSchema = z.string().trim().min(1);
const OperationResultIssueFingerprintSchema = z.string().trim().min(1);
const OperationResultErrorCodeSchema = z.string().trim().min(1);
const OperationResultRetryAfterMsSchema = z
  .number()
  .finite()
  .nonnegative()
  .transform((value) => Math.trunc(value));
const OperationResultResumePromptModeSchema = z.enum(['standard', 'off', 'custom']);
type OperationResultResumePromptMode = z.infer<typeof OperationResultResumePromptModeSchema>;
const INVALID_RESUME_PROMPT_MODE = Symbol('invalid resume prompt mode');

const OperationResultDiagnosticScalarV1Schema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const OperationResultDiagnosticsV1Schema = z.record(
  z.string().trim().min(1),
  OperationResultDiagnosticScalarV1Schema,
);

export const SessionUsageLimitRecoveryOperationResultV1Schema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      status: SessionUsageLimitRecoveryOperationResultOkStatusV1Schema,
      sessionId: OperationResultSessionIdSchema,
      issueFingerprint: OperationResultIssueFingerprintSchema.optional(),
      retryAfterMs: OperationResultRetryAfterMsSchema.optional(),
      resumePromptMode: OperationResultResumePromptModeSchema.optional(),
      uxDiagnostic: ConnectedServiceUxDiagnosticV1Schema.optional(),
      diagnostics: OperationResultDiagnosticsV1Schema.optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      status: SessionUsageLimitRecoveryOperationResultErrorStatusV1Schema,
      sessionId: OperationResultSessionIdSchema.optional(),
      errorCode: OperationResultErrorCodeSchema,
      retryAfterMs: OperationResultRetryAfterMsSchema.optional(),
      resumePromptMode: OperationResultResumePromptModeSchema.optional(),
      issueFingerprint: OperationResultIssueFingerprintSchema.optional(),
      uxDiagnostic: ConnectedServiceUxDiagnosticV1Schema.optional(),
      diagnostics: OperationResultDiagnosticsV1Schema.optional(),
    })
    .strict(),
]);

export type SessionUsageLimitRecoveryOperationResultV1 =
  z.infer<typeof SessionUsageLimitRecoveryOperationResultV1Schema>;

export type NormalizeSessionUsageLimitRecoveryOperationResultV1Options = Readonly<{
  sessionId?: string | null;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readSessionId(
  raw: Record<string, unknown> | null,
  options: NormalizeSessionUsageLimitRecoveryOperationResultV1Options,
): string | undefined {
  return readString(raw?.sessionId) ?? readString(options.sessionId) ?? undefined;
}

function readRetryAfterMs(raw: Record<string, unknown> | null): number | undefined {
  const value = raw?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function readIssueFingerprint(raw: Record<string, unknown> | null): string | undefined {
  return readString(raw?.issueFingerprint) ?? undefined;
}

function readResumePromptMode(
  raw: Record<string, unknown> | null,
): OperationResultResumePromptMode | typeof INVALID_RESUME_PROMPT_MODE | undefined {
  if (!raw || !Object.prototype.hasOwnProperty.call(raw, 'resumePromptMode')) return undefined;
  const parsed = OperationResultResumePromptModeSchema.safeParse(raw.resumePromptMode);
  return parsed.success ? parsed.data : INVALID_RESUME_PROMPT_MODE;
}

function readUxDiagnostic(
  ...records: Array<Record<string, unknown> | null>
): z.infer<typeof ConnectedServiceUxDiagnosticV1Schema> | undefined {
  for (const record of records) {
    const parsed = ConnectedServiceUxDiagnosticV1Schema.safeParse(record?.uxDiagnostic);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function buildOkResult(
  status: SessionUsageLimitRecoveryOperationResultOkStatusV1,
  raw: Record<string, unknown> | null,
  options: NormalizeSessionUsageLimitRecoveryOperationResultV1Options,
  extra?: Readonly<{ uxDiagnosticSource?: Record<string, unknown> | null }>,
): SessionUsageLimitRecoveryOperationResultV1 {
  const sessionId = readSessionId(raw, options);
  if (!sessionId) {
    return {
      ok: false,
      status: 'malformed_response',
      errorCode: 'missing_session_id',
    };
  }

  const issueFingerprint = readIssueFingerprint(raw);
  const retryAfterMs = readRetryAfterMs(raw);
  const resumePromptMode = readResumePromptMode(raw);
  if (resumePromptMode === INVALID_RESUME_PROMPT_MODE) {
    return buildErrorResult(
      'malformed_response',
      'malformed_session_usage_limit_recovery_resume_prompt_mode',
      raw,
      options,
    );
  }
  const uxDiagnostic = readUxDiagnostic(raw, extra?.uxDiagnosticSource ?? null);

  return SessionUsageLimitRecoveryOperationResultV1Schema.parse({
    ok: true,
    status,
    sessionId,
    ...(issueFingerprint ? { issueFingerprint } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(resumePromptMode ? { resumePromptMode } : {}),
    ...(uxDiagnostic ? { uxDiagnostic } : {}),
  });
}

function buildErrorResult(
  status: SessionUsageLimitRecoveryOperationResultErrorStatusV1,
  errorCode: string,
  raw: Record<string, unknown> | null,
  options: NormalizeSessionUsageLimitRecoveryOperationResultV1Options,
  extra?: Readonly<{
    diagnostics?: Record<string, string | number | boolean | null>;
    uxDiagnosticSource?: Record<string, unknown> | null;
  }>,
): SessionUsageLimitRecoveryOperationResultV1 {
  const sessionId = readSessionId(raw, options);
  const issueFingerprint = readIssueFingerprint(raw);
  const retryAfterMs = readRetryAfterMs(raw);
  const resumePromptMode = readResumePromptMode(raw);
  const uxDiagnostic = readUxDiagnostic(raw, extra?.uxDiagnosticSource ?? null);

  return SessionUsageLimitRecoveryOperationResultV1Schema.parse({
    ok: false,
    status,
    ...(sessionId ? { sessionId } : {}),
    errorCode,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(resumePromptMode && resumePromptMode !== INVALID_RESUME_PROMPT_MODE ? { resumePromptMode } : {}),
    ...(issueFingerprint ? { issueFingerprint } : {}),
    ...(uxDiagnostic ? { uxDiagnostic } : {}),
    ...(extra?.diagnostics ? { diagnostics: extra.diagnostics } : {}),
  });
}

function inheritRawContext(
  result: SessionUsageLimitRecoveryOperationResultV1,
  raw: Record<string, unknown>,
  options: NormalizeSessionUsageLimitRecoveryOperationResultV1Options,
): SessionUsageLimitRecoveryOperationResultV1 {
  const sessionId = result.sessionId ?? readSessionId(raw, options);
  const issueFingerprint = result.issueFingerprint ?? readIssueFingerprint(raw);
  const retryAfterMs = result.retryAfterMs ?? readRetryAfterMs(raw);
  const resumePromptMode = result.resumePromptMode ?? readResumePromptMode(raw);
  const uxDiagnostic = result.uxDiagnostic ?? readUxDiagnostic(raw);

  return SessionUsageLimitRecoveryOperationResultV1Schema.parse({
    ...result,
    ...(sessionId ? { sessionId } : {}),
    ...(issueFingerprint ? { issueFingerprint } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(resumePromptMode && resumePromptMode !== INVALID_RESUME_PROMPT_MODE ? { resumePromptMode } : {}),
    ...(uxDiagnostic ? { uxDiagnostic } : {}),
  });
}

function statusFromErrorCode(errorCode: string): SessionUsageLimitRecoveryOperationResultErrorStatusV1 {
  const normalized = errorCode.trim().toLowerCase();
  if (normalized.includes('invalid_parameters') || normalized.includes('malformed')) return 'malformed_response';
  if (normalized.includes('rate_limited') || normalized.includes('rate-limit')) return 'rate_limited';
  if (normalized.includes('inactive')) return 'inactive';
  if (
    normalized.includes('rpc_method_not_found')
    || normalized.includes('rpc_method_not_available')
    || normalized.includes('method_not_found')
    || normalized.includes('method_not_available')
  ) {
    return 'session_unreachable';
  }
  if (normalized.includes('not_found') || normalized.includes('not-found')) return 'not_found';
  if (normalized.includes('no_eligible') || normalized.includes('exhausted')) return 'exhausted';
  if (normalized.includes('cancel')) return 'cancelled';
  if (normalized.includes('generation_apply_failed') || normalized.includes('switch_failed')) return 'generation_apply_failed';
  if (normalized.includes('issue_mismatch') || normalized.includes('conflict')) return 'group_conflict';
  if (
    normalized.includes('metadata_unavailable')
    || normalized.includes('current_machine_unknown')
    || normalized.includes('session_machine_unknown')
    || normalized.includes('machine_unknown')
    || normalized.includes('machine_unavailable')
    || normalized.includes('remote_unavailable')
    || normalized.includes('resume_failed')
    || normalized.includes('stale_machine')
    || normalized.includes('session_unreachable')
    || normalized.includes('session_rpc_failed')
    || normalized.includes('server_unreachable')
  ) {
    return 'session_unreachable';
  }
  return 'unsupported';
}

function readNestedRecoveryStatus(raw: Record<string, unknown>): string | null {
  const recovery = readRecord(raw.recovery);
  return readString(recovery?.status);
}

function normalizeKnownStatus(
  status: string,
  raw: Record<string, unknown>,
  options: NormalizeSessionUsageLimitRecoveryOperationResultV1Options,
): SessionUsageLimitRecoveryOperationResultV1 {
  switch (status) {
    case 'ready':
    case 'waiting':
    case 'resumed':
    case 'already_ready':
    case 'no_recovery_needed':
    case 'cancelled':
      return buildOkResult(status, raw, options);
    case 'recovery_retry_scheduled':
      return buildOkResult('waiting', raw, options);
    case 'credential_refreshed':
    case 'switched':
      return buildOkResult('switch_applied', raw, options);
    case 'observed_generation':
      return buildOkResult('switch_observed', raw, options);
    case 'no_eligible_member':
    case 'exhausted':
      return buildErrorResult(
        'exhausted',
        status === 'no_eligible_member'
          ? 'session_usage_limit_recovery_control_no_eligible_member'
          : 'session_usage_limit_recovery_exhausted',
        raw,
        options,
      );
    case 'session_not_found':
      return buildErrorResult('not_found', 'session_usage_limit_recovery_session_not_found', raw, options);
    case 'not_classified':
    case 'inactive':
      return buildErrorResult('inactive', 'session_usage_limit_recovery_inactive', raw, options);
    case 'selection_mismatch':
      return buildErrorResult('group_conflict', 'session_usage_limit_recovery_control_issue_mismatch', raw, options);
    case 'generation_apply_failed':
    case 'recovery_handler_failed':
      return buildErrorResult('generation_apply_failed', 'session_usage_limit_recovery_control_switch_failed', raw, options);
    case 'switch_coordinator_unavailable':
    case 'recovery_action_required':
      return buildErrorResult('unsupported', 'session_usage_limit_recovery_control_switch_unavailable', raw, options);
    case 'rate_limited':
      return buildErrorResult('rate_limited', 'session_usage_limit_recovery_rate_limited', raw, options);
    default:
      return buildErrorResult(
        'unsupported',
        'unsupported_session_usage_limit_recovery_operation_result_status',
        raw,
        options,
        { diagnostics: { status } },
      );
  }
}

function normalizeSwitchAttemptResult(
  raw: Record<string, unknown>,
  options: NormalizeSessionUsageLimitRecoveryOperationResultV1Options,
): SessionUsageLimitRecoveryOperationResultV1 | null {
  const status = readString(raw.status);
  if (status !== 'switch_attempted') return null;

  const switchResult = readRecord(raw.result);
  const switchStatus = readString(switchResult?.status);
  if (!switchStatus) {
    return buildErrorResult(
      'malformed_response',
      'malformed_session_usage_limit_recovery_switch_result',
      raw,
      options,
    );
  }

  if (switchStatus === 'switched' || switchStatus === 'credential_refreshed') {
    return buildOkResult('switch_applied', raw, options, { uxDiagnosticSource: switchResult });
  }
  if (switchStatus === 'observed_generation') {
    return buildOkResult('switch_observed', raw, options, { uxDiagnosticSource: switchResult });
  }

  return normalizeKnownStatus(switchStatus, raw, options);
}

function normalizeRawRecord(
  raw: Record<string, unknown>,
  options: NormalizeSessionUsageLimitRecoveryOperationResultV1Options,
  depth: number,
): SessionUsageLimitRecoveryOperationResultV1 {
  const direct = SessionUsageLimitRecoveryOperationResultV1Schema.safeParse(raw);
  if (direct.success) return direct.data;

  if (depth <= 2 && raw.ok === true) {
    const nested = readRecord(raw.result);
    if (nested) {
      return inheritRawContext(
        normalizeRawRecord(nested, { ...options, sessionId: readSessionId(raw, options) }, depth + 1),
        raw,
        options,
      );
    }
  }

  const switchAttempt = normalizeSwitchAttemptResult(raw, options);
  if (switchAttempt) return switchAttempt;

  const status = readString(raw.status) ?? readNestedRecoveryStatus(raw);
  if (status) {
    return normalizeKnownStatus(status, raw, options);
  }

  const errorCode = readString(raw.errorCode) ?? readString(raw.error);
  if (raw.ok === false || errorCode) {
    const stableErrorCode = errorCode ?? 'malformed_session_usage_limit_recovery_operation_result';
    return buildErrorResult(statusFromErrorCode(stableErrorCode), stableErrorCode, raw, options);
  }

  return buildErrorResult(
    'malformed_response',
    'malformed_session_usage_limit_recovery_operation_result',
    raw,
    options,
  );
}

export function normalizeSessionUsageLimitRecoveryOperationResultV1(
  value: unknown,
  options: NormalizeSessionUsageLimitRecoveryOperationResultV1Options = {},
): SessionUsageLimitRecoveryOperationResultV1 {
  const direct = SessionUsageLimitRecoveryOperationResultV1Schema.safeParse(value);
  if (direct.success) return direct.data;

  const raw = readRecord(value);
  if (!raw) {
    return {
      ok: false,
      status: 'malformed_response',
      errorCode: 'malformed_session_usage_limit_recovery_operation_result',
    };
  }

  return normalizeRawRecord(raw, options, 0);
}

export function isSessionUsageLimitRecoveryOperationResultV1(
  value: unknown,
): value is SessionUsageLimitRecoveryOperationResultV1 {
  return SessionUsageLimitRecoveryOperationResultV1Schema.safeParse(value).success;
}
