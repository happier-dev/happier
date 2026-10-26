import type {
  SessionRuntimeTemporaryThrottleDetailsV1,
  SessionRuntimeUsageLimitDetailsV1,
  SessionRuntimeIssueSourceV1,
  SessionRuntimeIssueV1,
} from '@happier-dev/protocol';
import {
  ConnectedServiceIdSchema,
  readConnectedServiceLimitCategoryV1,
  redactBugReportSensitiveText,
} from '@happier-dev/protocol';

import { classifyProviderLimitEvidence, parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';
import { classifyProviderOutputFailure } from '@/agent/runtime/classifyProviderOutputFailure';
import { ProviderCliNotFoundError } from '@/runtime/managedTools/requireProviderCliCommand';

export type PrimarySessionRuntimeIssueCause =
  | 'status_error'
  | 'process_exit'
  | 'session_error'
  | 'usage_limit'
  | 'auth_error'
  | 'stream_error'
  | 'permission_blocked'
  | 'unknown';

export type ClassifyPrimarySessionRuntimeIssueInput = Readonly<{
  provider?: string | null;
  providerTurnId?: string | null;
  sessionSeq?: number | null;
  cause?: PrimarySessionRuntimeIssueCause | null;
  error?: unknown;
  occurredAt?: number | null;
}>;

const causeSourceMap = {
  status_error: 'provider_status_error',
  process_exit: 'provider_process_exit',
  session_error: 'provider_session_error',
  usage_limit: 'usage_limit',
  auth_error: 'auth_error',
  stream_error: 'stream_error',
  permission_blocked: 'permission_blocked',
  unknown: 'unknown',
} as const satisfies Record<PrimarySessionRuntimeIssueCause, SessionRuntimeIssueSourceV1>;

const sanitizedPreviewBySource = {
  provider_status_error: 'Provider reported an error',
  provider_process_exit: 'Provider process exited',
  provider_process_exit_after_switch: 'Provider process exited after connected-service switch',
  provider_session_error: 'Provider session failed',
  usage_limit: 'Usage limit reached',
  auth_error: 'Authentication failed',
  stream_error: 'Provider stream failed',
  permission_blocked: 'Permission blocked',
  dependency_failure: 'Provider dependency failed',
  unknown: 'Session runtime failed',
} as const satisfies Record<SessionRuntimeIssueSourceV1, string>;

const PI_PROVIDER_TOKEN_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/gu;
export const PI_PROVIDER_SESSION_FAILURE_AFTER_PROMPT_ACCEPTANCE_DIAGNOSTIC =
  'Pi provider reported provider session failure after prompt acceptance';
const PI_TERMINAL_DIAGNOSTIC_PREFIXES = [
  'Pi provider reported turn_failed without details after prompt acceptance',
  'Pi provider reported assistant_message_end failed without details after prompt acceptance',
  PI_PROVIDER_SESSION_FAILURE_AFTER_PROMPT_ACCEPTANCE_DIAGNOSTIC,
  'Pi provider reported turn_failed after prompt acceptance:',
  'Pi provider reported assistant_message_end failed after prompt acceptance:',
] as const;

function extractErrorTextParts(error: unknown): string[] {
  if (typeof error === 'string') return [error];
  if (error instanceof Error) return [error.message];
  if (!error || typeof error !== 'object') return [];
  const record = error as Record<string, unknown>;
  const data = readRecord(record.data);
  return [record.message, data?.message, record.detail, record.error, record.code, record.status]
    .filter((part): part is string => typeof part === 'string');
}

function extractErrorText(error: unknown): string {
  return extractErrorTextParts(error)
    .join(' ');
}

function readProviderLimitCategory(error: unknown) {
  const data = readRecord(readRecord(error)?.data);
  return readConnectedServiceLimitCategoryV1(data?.limitCategory)
    ?? classifyProviderLimitEvidence([error, data]);
}

function refineProviderFailureSource(
  input: ClassifyPrimarySessionRuntimeIssueInput,
  fallback: SessionRuntimeIssueSourceV1,
): SessionRuntimeIssueSourceV1 {
  const text = extractErrorText(input.error).toLowerCase();
  if (/\btemporar(?:y|ily)\s+limiting\s+requests\b/u.test(text) && /\bnot\s+your\s+usage\s+limit\b/u.test(text)) {
    return 'provider_status_error';
  }
  if (classifyProviderOutputFailure(text).authenticationError) {
    return 'auth_error';
  }
  if (/\b(permission denied|permission blocked|blocked by policy|not allowed|access denied)\b/u.test(text)) {
    return 'permission_blocked';
  }
  if (/\bdependency\b/u.test(text) && /\b(failed|missing|not found|unavailable)\b/u.test(text)) {
    return 'dependency_failure';
  }
  const providerLimitCategory = readProviderLimitCategory(input.error);
  if (providerLimitCategory === 'usage_limit' || providerLimitCategory === 'rate_limit') {
    return 'usage_limit';
  }
  if (providerLimitCategory !== 'unknown') {
    return 'provider_status_error';
  }
  return fallback;
}

function normalizeNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function normalizeNullableString(value: unknown, maxLength: number): string | null {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) return null;
  return normalized.length <= maxLength ? normalized : null;
}

function normalizeStateMode(value: unknown): 'shared' | 'isolated' | null {
  if (value === 'shared' || value === 'isolated') return value;
  return null;
}

function readProviderProcessExitAfterSwitchDetails(error: unknown): SessionRuntimeIssueV1['providerProcessExitAfterSwitch'] {
  const details = readRecord(readRecord(error)?.providerProcessExitAfterSwitch);
  if (!details) return undefined;
  const exitCode = normalizeNonNegativeInteger(details.exitCode);
  const signal = normalizeNullableString(details.signal, 128);
  const lastStderrLine = normalizeNullableString(details.lastStderrLine, 2_000);
  const vendorResumeId = normalizeNullableString(details.vendorResumeId, 512);
  const materializationRoot = normalizeNullableString(details.materializationRoot, 2_000);
  const effectiveStateMode = normalizeStateMode(details.effectiveStateMode);
  if (
    exitCode === null
    && signal === null
    && lastStderrLine === null
    && vendorResumeId === null
    && materializationRoot === null
    && effectiveStateMode === null
  ) {
    return undefined;
  }
  return {
    exitCode,
    signal,
    lastStderrLine,
    vendorResumeId,
    materializationRoot,
    effectiveStateMode,
  };
}

function buildSafeModelNotFoundPreview(error: unknown): string | null {
  const match = extractErrorTextParts(error)
    .map((part) => /^model\s+not\s+found:\s*([^/\s]+)\/([^\s]+)\.?$/iu.exec(part.trim()))
    .find((candidate): candidate is RegExpExecArray => candidate !== null);
  if (!match) return null;

  const provider = match[1]?.trim() ?? '';
  const model = (match[2]?.trim() ?? '').replace(/\.+$/u, '');
  if (!/^[a-z0-9_.-]+$/iu.test(provider)) return null;
  if (!/^[a-z0-9_.:@/+~-]+$/iu.test(model)) return null;

  const modelRef = `${provider}/${model}`;
  if (modelRef.length > 180) return null;
  return `Model not found: ${modelRef}`;
}

function buildSafePiTerminalDiagnosticPreview(params: Readonly<{
  provider: string | null;
  error: unknown;
}>): string | null {
  if (params.provider !== 'pi') return null;
  for (const part of extractErrorTextParts(params.error)) {
    const preview = redactBugReportSensitiveText(part)
      .replace(PI_PROVIDER_TOKEN_PATTERN, '[redacted-provider-token]')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!preview) continue;
    if (!PI_TERMINAL_DIAGNOSTIC_PREFIXES.some((prefix) => preview.startsWith(prefix))) continue;
    return preview.slice(0, 2_000);
  }
  return null;
}

function readPiProviderFailure(error: unknown): { code: string; sanitizedPreview: string } | null {
  const failure = readRecord(readRecord(error)?.piProviderFailure);
  const code = normalizeNullableString(failure?.code, 128);
  const sanitizedPreview = normalizeNullableString(failure?.sanitizedPreview, 2_000);
  if (!code || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(code) || !sanitizedPreview) return null;
  const safePreview = redactBugReportSensitiveText(sanitizedPreview)
    .replace(PI_PROVIDER_TOKEN_PATTERN, '[redacted-provider-token]')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!safePreview.startsWith('Pi provider reported ')) return null;
  return { code, sanitizedPreview: safePreview };
}

function readPiBrokerReadinessFailure(error: unknown): { code: string; sanitizedPreview: string } | null {
  const failure = readRecord(readRecord(error)?.piBrokerReadinessFailure);
  if (failure?.classification !== 'pi_broker_readiness_failure') return null;
  const reason = normalizeNullableString(failure.reason, 128);
  const code = normalizeNullableString(failure.code, 128);
  const sanitizedPreview = normalizeNullableString(failure.sanitizedPreview, 2_000);
  if (!reason || !/^broker_[a-z0-9_]+$/u.test(reason)) return null;
  if (code !== 'pi_broker_readiness_failure') return null;
  if (sanitizedPreview !== 'Pi connected-service broker was not ready before provider send') return null;
  return { code, sanitizedPreview };
}

function normalizeUrl(value: unknown): string | null {
  const raw = normalizeNonEmptyString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function buildUsageLimitDetailsFromProviderFailure(
  error: unknown,
  nowMs: number,
): SessionRuntimeUsageLimitDetailsV1 {
  const record = readRecord(error);
  const data = readRecord(record?.data);
  const timing = parseProviderResetAt({ body: data ?? error, headers: record?.headers ?? data?.headers, nowMs });
  const limitCategory = readProviderLimitCategory(error);
  const retryAfterMs = readTemporaryThrottleRetryAfterMs(error, nowMs) ?? timing.retryAfterMs;
  return {
    v: 1,
    resetAtMs: normalizeNonNegativeInteger(record?.resetAtMs ?? data?.resetAtMs)
      ?? timing.resetAtMs,
    retryAfterMs,
    quotaScope: 'unknown',
    recoverability: 'wait',
    ...(limitCategory === 'usage_limit' || limitCategory === 'rate_limit' ? { limitCategory } : {}),
  };
}

function isTemporaryThrottleError(error: unknown): boolean {
  const text = extractErrorText(error).toLowerCase();
  return /\btemporar(?:y|ily)\s+limiting\s+requests\b/u.test(text)
    && /\bnot\s+your\s+usage\s+limit\b/u.test(text);
}

type HeaderGetter = Readonly<{ get: (name: string) => unknown }>;

function hasHeaderGetter(value: unknown): value is HeaderGetter {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as Partial<HeaderGetter>).get === 'function';
}

function parseRetryAfterMs(value: unknown, nowMs: number): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1_000);
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs) || dateMs < nowMs) return null;
  return dateMs - nowMs;
}

function parseRetryAfterMilliseconds(value: unknown): number | null {
  const explicitMs = normalizeNonNegativeInteger(value);
  if (explicitMs !== null) return explicitMs;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function readHeaderValue(headers: unknown, name: string): unknown {
  if (hasHeaderGetter(headers)) return headers.get(name);
  const record = readRecord(headers);
  if (!record) return null;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return null;
}

function readTemporaryThrottleRetryAfterMs(error: unknown, nowMs: number): number | null {
  const record = readRecord(error);
  const data = readRecord(record?.data);
  const directRetryAfterMs = parseRetryAfterMilliseconds(record?.retryAfterMs ?? data?.retryAfterMs);
  if (directRetryAfterMs !== null) return directRetryAfterMs;

  const headers = record?.headers ?? data?.headers;
  const retryAfterMsHeader = parseRetryAfterMilliseconds(readHeaderValue(headers, 'retry-after-ms'));
  if (retryAfterMsHeader !== null) return retryAfterMsHeader;

  return parseRetryAfterMs(
    readHeaderValue(headers, 'retry-after'),
    nowMs,
  );
}

function buildTemporaryThrottleDetails(
  error: unknown,
  nowMs: number,
): SessionRuntimeTemporaryThrottleDetailsV1 | null {
  if (!isTemporaryThrottleError(error)) return null;
  return {
    v: 1,
    retryAfterMs: readTemporaryThrottleRetryAfterMs(error, nowMs),
    recoverability: 'retry',
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readRuntimeAuthClassification(error: unknown): Record<string, unknown> | null {
  return readRecord(readRecord(error)?.runtimeAuthClassification);
}

function buildUsageLimitDetailsFromRuntimeAuthClassification(
  classification: Record<string, unknown> | null,
): SessionRuntimeUsageLimitDetailsV1 | null {
  if (!classification) return null;
  const kind = normalizeNonEmptyString(classification.kind);
  if (![
    'usage_limit',
    'rate_limit',
    'capacity',
    'auth_expired',
    'refresh_failed',
    'plan',
    'validation',
    'account_disabled',
  ].includes(kind ?? '')) return null;
  const serviceId = ConnectedServiceIdSchema.safeParse(classification.serviceId);
  if (!serviceId.success) return null;
  const groupId = normalizeNonEmptyString(classification.groupId);
  const profileId = normalizeNonEmptyString(classification.profileId);
  const rateLimits = readRecord(classification.rateLimits);
  const providerLimitId = normalizeNonEmptyString(classification.providerLimitId ?? rateLimits?.providerLimitId);
  const limitCategory = readConnectedServiceLimitCategoryV1(
    classification.limitCategory ?? rateLimits?.limitCategory,
  );
  const quotaScope = normalizeNonEmptyString(classification.quotaScope ?? rateLimits?.quotaScope);
  const action = readRecord(classification.action) ?? readRecord(rateLimits?.action);
  const actionKind = normalizeNonEmptyString(action?.kind);
  const actionUrl = actionKind === 'open_url' ? normalizeUrl(action?.url) : null;
  return {
    v: 1,
    resetAtMs: normalizeNonNegativeInteger(classification.resetsAtMs),
    retryAfterMs: normalizeNonNegativeInteger(classification.retryAfterMs),
    quotaScope: quotaScope === 'workspace' || quotaScope === 'organization' || quotaScope === 'model' || quotaScope === 'provider' || quotaScope === 'unknown'
      ? quotaScope
      : 'account',
    recoverability: groupId ? 'switch_account' : 'wait',
    ...(limitCategory ? { limitCategory } : {}),
    ...(providerLimitId ? { providerLimitId } : {}),
    planType: normalizeNonEmptyString(classification.planType),
    ...(actionKind === 'open_url' && actionUrl ? { action: { kind: 'open_url', url: actionUrl } } : {}),
    connectedService: {
      serviceId: serviceId.data,
      profileId,
      groupId,
    },
  };
}

function refineRuntimeAuthClassificationSource(
  classification: Record<string, unknown> | null,
): SessionRuntimeIssueSourceV1 | null {
  const kind = normalizeNonEmptyString(classification?.kind);
  switch (kind) {
    case 'usage_limit':
    case 'rate_limit':
      return 'usage_limit';
    case 'auth_expired':
    case 'refresh_failed':
      return 'auth_error';
    case 'capacity':
    case 'plan':
    case 'validation':
    case 'account_disabled':
      return 'provider_status_error';
    case 'dependency_failure':
      return 'dependency_failure';
    default:
      return null;
  }
}

export function classifyPrimarySessionRuntimeIssue(
  input: ClassifyPrimarySessionRuntimeIssueInput,
): SessionRuntimeIssueV1 {
  const provider = normalizeNonEmptyString(input.provider);
  const missingCli = input.error instanceof ProviderCliNotFoundError ? input.error : null;
  const piBrokerReadinessFailure = provider === 'pi' ? readPiBrokerReadinessFailure(input.error) : null;
  const runtimeAuthClassification = readRuntimeAuthClassification(input.error);
  const runtimeAuthUsageLimit = buildUsageLimitDetailsFromRuntimeAuthClassification(runtimeAuthClassification);
  const runtimeAuthSource = refineRuntimeAuthClassificationSource(runtimeAuthClassification);
  const providerProcessExitAfterSwitch = readProviderProcessExitAfterSwitchDetails(input.error);
  const source = missingCli || piBrokerReadinessFailure
    ? 'dependency_failure'
    : runtimeAuthSource
    ? runtimeAuthSource
    : input.cause === 'process_exit' && providerProcessExitAfterSwitch
    ? 'provider_process_exit_after_switch'
    : input.cause === 'status_error' || input.cause === 'session_error'
    ? refineProviderFailureSource(input, causeSourceMap[input.cause])
    : causeSourceMap[input.cause ?? 'unknown'] ?? 'unknown';
  const occurredAt = normalizeNonNegativeInteger(input.occurredAt) ?? Date.now();
  const usageLimit = runtimeAuthUsageLimit ?? (source === 'usage_limit'
    ? buildUsageLimitDetailsFromProviderFailure(input.error, occurredAt)
    : null);
  const temporaryThrottle = source === 'provider_status_error'
    ? buildTemporaryThrottleDetails(input.error, occurredAt)
    : null;
  const piProviderFailure = provider === 'pi' ? readPiProviderFailure(input.error) : null;
  const providerTurnId = normalizeNonEmptyString(input.providerTurnId);
  const sessionSeq = normalizeNonNegativeInteger(input.sessionSeq);

  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: temporaryThrottle === null
      ? (missingCli ? 'provider_cli_not_found' : null) ?? piBrokerReadinessFailure?.code ?? piProviderFailure?.code ?? source
      : 'provider_temporary_throttle',
    source,
    occurredAt,
    ...(sessionSeq === null ? {} : { sessionSeq }),
    ...(provider === null ? {} : { provider }),
    ...(providerTurnId === null ? {} : { providerTurnId }),
    sanitizedPreview: temporaryThrottle === null
      ? missingCli?.message
        ?? piBrokerReadinessFailure?.sanitizedPreview
        ?? piProviderFailure?.sanitizedPreview
        ?? buildSafeModelNotFoundPreview(input.error)
        ?? buildSafePiTerminalDiagnosticPreview({ provider, error: input.error })
        ?? sanitizedPreviewBySource[source]
      : 'Provider is temporarily limiting requests',
    ...(usageLimit === null ? {} : { usageLimit }),
    ...(temporaryThrottle === null ? {} : { temporaryThrottle }),
    ...(providerProcessExitAfterSwitch ? { providerProcessExitAfterSwitch } : {}),
  };
}
