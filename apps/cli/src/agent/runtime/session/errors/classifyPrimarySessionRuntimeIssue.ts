import type {
  SessionRuntimeTemporaryThrottleDetailsV1,
  SessionRuntimeUsageLimitDetailsV1,
  SessionRuntimeIssueSourceV1,
  SessionRuntimeIssueV1,
} from '@happier-dev/protocol';
import {
  ConnectedServiceIdSchema,
  readConnectedServiceLimitCategoryV1,
  SessionRuntimeIssueSourceV1Schema,
} from '@happier-dev/protocol';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import { hasConnectedServiceRuntimeAuthRecoveryContext } from './connectedServiceRuntimeAuthRecoveryContext';

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
  agentTurnId?: string | null;
  sessionSeq?: number | null;
  cause?: PrimarySessionRuntimeIssueCause | null;
  error?: unknown;
  occurredAt?: number | null;
}>;

const causeSourceMap = {
  status_error: 'agent_status_error',
  process_exit: 'agent_process_exit',
  session_error: 'agent_session_error',
  usage_limit: 'usage_limit',
  auth_error: 'auth_error',
  stream_error: 'stream_error',
  permission_blocked: 'permission_blocked',
  unknown: 'unknown',
} as const satisfies Record<PrimarySessionRuntimeIssueCause, SessionRuntimeIssueSourceV1>;

const sanitizedPreviewBySource = {
  agent_status_error: 'Provider reported an error',
  agent_process_exit: 'Provider process exited',
  agent_process_exit_after_switch: 'Provider process exited after connected-service switch',
  agent_session_error: 'Provider session failed',
  usage_limit: 'Usage limit reached',
  auth_error: 'Authentication failed',
  dependency_failure: 'Provider dependency failed',
  stream_error: 'Provider stream failed',
  permission_blocked: 'Permission blocked',
  unknown: 'Session runtime failed',
} as const satisfies Record<SessionRuntimeIssueSourceV1, string>;

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

function readDeclaredRuntimeIssueSource(error: unknown): SessionRuntimeIssueSourceV1 | null {
  const details = readRecord(readRecord(error)?.details);
  if (details?.v !== 1) return null;
  const parsed = SessionRuntimeIssueSourceV1Schema.safeParse(details.source);
  return parsed.success ? parsed.data : null;
}

function refineStatusErrorSource(input: ClassifyPrimarySessionRuntimeIssueInput): SessionRuntimeIssueSourceV1 {
  const text = extractErrorText(input.error).toLowerCase();
  if (/\btemporar(?:y|ily)\s+limiting\s+requests\b/u.test(text) && /\bnot\s+your\s+usage\s+limit\b/u.test(text)) {
    return 'agent_status_error';
  }
  if (/\b(unauthorized|unauthenticated|authentication|auth|login required|not logged in|api key|401|403)\b/u.test(text)) {
    return 'auth_error';
  }
  if (/\b(quota|usage limit|rate limit|limit reached|max turns|insufficient credits|credits exhausted|billing)\b/u.test(text)) {
    return 'usage_limit';
  }
  if (/\b(permission denied|permission blocked|blocked by policy|not allowed|access denied)\b/u.test(text)) {
    return 'permission_blocked';
  }
  return 'agent_status_error';
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

function readProviderProcessExitAfterSwitchDetails(
  error: unknown,
): SessionRuntimeIssueV1['agentProcessExitAfterSwitch'] {
  const details = readRecord(readRecord(error)?.agentProcessExitAfterSwitch);
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

function normalizeRetryAfterMs(value: unknown): number | null {
  const direct = normalizeNonNegativeInteger(value);
  if (direct !== null) return direct;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.trunc(numeric);
  const parsedDate = Date.parse(trimmed);
  if (!Number.isFinite(parsedDate)) return null;
  const deltaMs = parsedDate - Date.now();
  return deltaMs >= 0 ? Math.trunc(deltaMs) : null;
}

function readRetryAfterMs(error: unknown): number | null {
  const record = readRecord(error);
  const data = readRecord(record?.data);
  const headers = readRecord(record?.headers);
  const dataHeaders = readRecord(data?.headers);
  return normalizeRetryAfterMs(record?.retryAfterMs)
    ?? normalizeRetryAfterMs(record?.['retry-after-ms'])
    ?? normalizeRetryAfterMs(record?.retryAfter)
    ?? normalizeRetryAfterMs(record?.['retry-after'])
    ?? normalizeRetryAfterMs(headers?.['retry-after-ms'])
    ?? normalizeRetryAfterMs(headers?.['retry-after'])
    ?? normalizeRetryAfterMs(data?.retryAfterMs)
    ?? normalizeRetryAfterMs(data?.['retry-after-ms'])
    ?? normalizeRetryAfterMs(data?.retryAfter)
    ?? normalizeRetryAfterMs(data?.['retry-after'])
    ?? normalizeRetryAfterMs(dataHeaders?.['retry-after-ms'])
    ?? normalizeRetryAfterMs(dataHeaders?.['retry-after']);
}

function isTemporaryThrottleError(error: unknown): boolean {
  const text = extractErrorText(error).toLowerCase();
  return /\btemporar(?:y|ily)\s+limiting\s+requests\b/u.test(text)
    && /\bnot\s+your\s+usage\s+limit\b/u.test(text);
}

function buildTemporaryThrottleDetails(
  error: unknown,
): SessionRuntimeTemporaryThrottleDetailsV1 | null {
  if (!isTemporaryThrottleError(error)) return null;
  return {
    v: 1,
    retryAfterMs: readRetryAfterMs(error),
    recoverability: 'retry',
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

function readStableRetryTimeResetAtMs(text: string, nowMs: number): number | null {
  const match = /\btry\s+again\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/iu.exec(text);
  if (!match) return null;
  const rawHour = Number(match[1]);
  const minute = Number(match[2] ?? '00');
  const period = match[3]?.toUpperCase();
  if (!Number.isInteger(rawHour) || !Number.isInteger(minute)) return null;
  if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) return null;

  let hour = rawHour % 12;
  if (period === 'PM') hour += 12;
  const candidate = new Date(nowMs);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= nowMs) {
    candidate.setDate(candidate.getDate() + 1);
  }
  const parsed = candidate.getTime();
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function buildUsageLimitDetailsFromStableText(
  error: unknown,
  nowMs: number,
): SessionRuntimeUsageLimitDetailsV1 {
  return {
    v: 1,
    resetAtMs: readStableRetryTimeResetAtMs(extractErrorText(error), nowMs),
    retryAfterMs: null,
    quotaScope: 'unknown',
    recoverability: 'wait',
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function readRuntimeAuthClassification(error: unknown): Readonly<Record<string, unknown>> | null {
  return sanitizeConnectedServiceRuntimeFailureClassification(readRecord(readRecord(error)?.runtimeAuthClassification));
}

function buildUsageLimitDetailsFromRuntimeAuthClassification(
  classification: Readonly<Record<string, unknown>> | null,
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
  const hasConnectedServiceRecovery = hasConnectedServiceRuntimeAuthRecoveryContext(classification);
  const rateLimits = readRecord(classification.rateLimits);
  const providerLimitId = normalizeNonEmptyString(classification.providerLimitId ?? rateLimits?.providerLimitId);
  const limitCategory = readConnectedServiceLimitCategoryV1(classification.limitCategory ?? rateLimits?.limitCategory);
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
    recoverability: groupId && hasConnectedServiceRecovery ? 'switch_account' : 'wait',
    ...(limitCategory ? { limitCategory } : {}),
    ...(providerLimitId ? { providerLimitId } : {}),
    planType: normalizeNonEmptyString(classification.planType),
    ...(actionKind === 'open_url' && actionUrl ? { action: { kind: 'open_url', url: actionUrl } } : {}),
    ...(hasConnectedServiceRecovery ? {
      connectedService: {
        serviceId: serviceId.data,
        profileId,
        groupId,
      },
    } : {}),
  };
}

function refineRuntimeAuthClassificationSource(
  classification: Readonly<Record<string, unknown>> | null,
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
      return 'agent_status_error';
    case 'dependency_failure':
      return 'dependency_failure';
    default:
      return null;
  }
}

export function classifyPrimarySessionRuntimeIssue(
  input: ClassifyPrimarySessionRuntimeIssueInput,
): SessionRuntimeIssueV1 {
  const runtimeAuthClassification = readRuntimeAuthClassification(input.error);
  const runtimeAuthUsageLimit = buildUsageLimitDetailsFromRuntimeAuthClassification(
    runtimeAuthClassification,
  );
  const runtimeAuthSource = refineRuntimeAuthClassificationSource(runtimeAuthClassification);
  const declaredSource = input.cause === 'session_error'
    ? readDeclaredRuntimeIssueSource(input.error)
    : null;
  const agentProcessExitAfterSwitch = readProviderProcessExitAfterSwitchDetails(input.error);
  const source = runtimeAuthSource
    ? runtimeAuthSource
    : declaredSource
    ? declaredSource
    : input.cause === 'process_exit' && agentProcessExitAfterSwitch
    ? 'agent_process_exit_after_switch'
    : input.cause === 'status_error'
    ? refineStatusErrorSource(input)
    : causeSourceMap[input.cause ?? 'unknown'] ?? 'unknown';
  const occurredAt = normalizeNonNegativeInteger(input.occurredAt) ?? Date.now();
  const usageLimit = runtimeAuthUsageLimit ?? (source === 'usage_limit'
    ? buildUsageLimitDetailsFromStableText(input.error, occurredAt)
    : null);
  const temporaryThrottle = source === 'agent_status_error'
    ? buildTemporaryThrottleDetails(input.error)
    : null;
  const agentId = normalizeNonEmptyString(input.provider);
  const agentTurnId = normalizeNonEmptyString(input.agentTurnId);
  const sessionSeq = normalizeNonNegativeInteger(input.sessionSeq);

  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: temporaryThrottle ? 'provider_temporary_throttle' : source,
    source,
    occurredAt,
    ...(sessionSeq === null ? {} : { sessionSeq }),
    ...(agentId === null ? {} : { agentId }),
    ...(agentTurnId === null ? {} : { agentTurnId }),
    sanitizedPreview: buildSafeModelNotFoundPreview(input.error)
      ?? (temporaryThrottle ? 'Provider is temporarily limiting requests' : sanitizedPreviewBySource[source]),
    ...(usageLimit === null ? {} : { usageLimit }),
    ...(temporaryThrottle === null ? {} : { temporaryThrottle }),
    ...(agentProcessExitAfterSwitch === undefined ? {} : { agentProcessExitAfterSwitch }),
  };
}
