import type { ConnectedServiceId, ConnectedServiceLimitCategoryV1, ConnectedServiceProfileId } from '@happier-dev/protocol';

export type CodexConnectedServiceRuntimeFailureKind =
  | 'usage_limit'
  | 'rate_limit'
  | 'temporary_throttle'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failed'
  | 'permission_denied'
  | 'unknown';

export type CodexConnectedServiceRuntimeFailureClassification = Readonly<{
  kind: CodexConnectedServiceRuntimeFailureKind;
  limitCategory?: ConnectedServiceLimitCategoryV1;
  serviceId: ConnectedServiceId;
  profileId: ConnectedServiceProfileId | null;
  groupId: string | null;
  resetsAtMs: number | null;
  retryAfterMs: number | null;
  planType: string | null;
  rateLimits: unknown | null;
  source: 'structured_provider_error' | 'stable_provider_message' | 'provider_runtime_marker';
  recoveryAction?: CodexConnectedServiceRecoveryAction | null;
}>;

export type CodexConnectedServiceRecoveryAction =
  | Readonly<{ kind: 'provider_state_sharing_required' }>
  | Readonly<{ kind: 'quota_recovery_required' }>;

export type CodexConnectedServiceGenericRuntimeIssueSource =
  | 'usage_limit'
  | 'auth_error'
  | 'permission_blocked'
  | 'other'
  | null;

export type ClassifyCodexConnectedServiceAuthFailureInput = Readonly<{
  providerErrorPath: boolean;
  error: unknown;
  serviceId: ConnectedServiceId;
  profileId: ConnectedServiceProfileId | null;
  groupId: string | null;
  nowMs?: number | null;
  genericRuntimeIssueSource?: CodexConnectedServiceGenericRuntimeIssueSource;
}>;

const CODEX_ACCOUNT_CHANGED_MESSAGE =
  'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readErrorRecord(value: unknown): Record<string, unknown> | null {
  const root = isRecord(value) ? value : null;
  const direct = isRecord(root?.error) ? root.error : null;
  const turn = isRecord(root?.turn) ? root.turn : null;
  const turnError = isRecord(turn?.error) ? turn.error : null;
  return direct ?? turnError ?? root;
}

function readErrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  const record = readErrorRecord(value);
  if (!record) return '';
  return [record.message, record.additionalDetails, record.additional_details, record.error, record.code, record.codexErrorInfo, record.codex_error_info]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
}

function isStructuredUsageLimitCode(value: string | null): boolean {
  return value === 'UsageLimitExceeded'
    || value === 'UsageLimitReached'
    || value === 'usageLimitExceeded'
    || value === 'usage_limit_exceeded'
    || value === 'usage_limit_reached';
}

function isStructuredAuthExpiredCode(value: string | null): boolean {
  return value === 'token_invalidated'
    || value === 'token_revoked'
    || value === 'invalid_grant'
    || value === 'refresh_token_expired';
}

function isStructuredRefreshFailureCode(value: string | null): boolean {
  return value === 'refresh_token_invalidated'
    || value === 'refresh_token_reused'
    || value === 'refresh_token_revoked';
}

function containsOauthTokenInvalidatedMessage(text: string): boolean {
  return /\binvalidated\s+oauth\s+token\b/iu.test(text);
}

function containsRefreshTokenFailureMessage(text: string): boolean {
  return /\brefresh\s+token\s+has\s+already\s+been\s+used\b/iu.test(text)
    || /\brefresh\s+token\s+(?:(?:has\s+been|was)\s+)?(?:invalidated|revoked)\b/iu.test(text);
}

function containsTemporaryThrottleMessage(text: string): boolean {
  return /\btemporar(?:y|ily)\s+limiting\s+requests\b/iu.test(text)
    && /\bnot\s+your\s+usage\s+limit\b/iu.test(text);
}

function containsStableUsageLimitMessage(text: string): boolean {
  return /\byou(?:'ve|\s+have)\s+hit\s+your\s+usage\s+limit\b/iu.test(text)
    && /\btry\s+again\s+at\b/iu.test(text);
}

function readResetAtMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value < 10_000_000_000 ? value * 1000 : value);
  }
  const text = readString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readDurationMs(value: unknown): number | null {
  const text = readString(value);
  const numeric = typeof value === 'number' ? value : text !== null ? Number(text) : null;
  if (numeric === null || !Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric);
}

function readDurationSecondsAsMs(value: unknown): number | null {
  const text = readString(value);
  const numeric = typeof value === 'number' ? value : text !== null ? Number(text) : null;
  if (numeric === null || !Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric * 1000);
}

function readRetryAfterMs(record: Record<string, unknown> | null): number | null {
  const explicitMs = readDurationMs(record?.retryAfterMs ?? record?.retry_after_ms);
  if (explicitMs !== null) return explicitMs;
  return readDurationSecondsAsMs(record?.retryAfter ?? record?.retry_after ?? record?.['retry-after']);
}

function readStableRetryTimeResetAtMs(text: string, nowMs: number): number | null {
  const fullDateMatch = /\btry\s+again\s+at\s+([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/iu.exec(text);
  if (fullDateMatch) {
    void nowMs;
    return null;
  }

  const match = /\btry\s+again\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/iu.exec(text);
  if (!match) return null;
  void nowMs;
  return null;
}

function buildClassification(
  input: ClassifyCodexConnectedServiceAuthFailureInput,
  params: Readonly<{
    kind: CodexConnectedServiceRuntimeFailureKind;
    limitCategory?: CodexConnectedServiceRuntimeFailureClassification['limitCategory'];
    resetsAtMs?: number | null;
    retryAfterMs?: number | null;
    planType?: string | null;
    rateLimits?: unknown | null;
    source: CodexConnectedServiceRuntimeFailureClassification['source'];
    recoveryAction?: CodexConnectedServiceRecoveryAction | null;
  }>,
): CodexConnectedServiceRuntimeFailureClassification {
  return {
    kind: params.kind,
    ...(params.limitCategory ? { limitCategory: params.limitCategory } : {}),
    serviceId: input.serviceId,
    profileId: input.profileId,
    groupId: input.groupId,
    resetsAtMs: params.resetsAtMs ?? null,
    retryAfterMs: params.retryAfterMs ?? null,
    planType: params.planType ?? null,
    rateLimits: params.rateLimits ?? null,
    source: params.source,
    ...(params.recoveryAction ? { recoveryAction: params.recoveryAction } : {}),
  };
}

const codexUsageLimitRecoveryAction = { kind: 'quota_recovery_required' } as const;

export function classifyCodexConnectedServiceAuthFailure(
  input: ClassifyCodexConnectedServiceAuthFailureInput,
): CodexConnectedServiceRuntimeFailureClassification | null {
  const record = readErrorRecord(input.error);
  const codexErrorInfo = readString(record?.codexErrorInfo ?? record?.codex_error_info);
  const structuredCode = readString(record?.code ?? record?.type ?? record?.reason);
  if (isStructuredUsageLimitCode(codexErrorInfo) || isStructuredUsageLimitCode(structuredCode)) {
    const text = readErrorText(input.error);
    return buildClassification(input, {
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      resetsAtMs:
        readResetAtMs(record?.resetsAt ?? record?.resets_at)
        ?? readStableRetryTimeResetAtMs(text, input.nowMs ?? Date.now()),
      retryAfterMs: readRetryAfterMs(record),
      planType: readString(record?.planType ?? record?.plan_type),
      rateLimits: record?.rateLimits ?? record?.rate_limits ?? null,
      source: 'structured_provider_error',
      recoveryAction: codexUsageLimitRecoveryAction,
    });
  }

  const text = readErrorText(input.error);
  if (input.providerErrorPath && containsTemporaryThrottleMessage(text)) {
    return buildClassification(input, {
      kind: 'temporary_throttle',
      limitCategory: 'rate_limit',
      retryAfterMs: readRetryAfterMs(record),
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  if (input.providerErrorPath && containsStableUsageLimitMessage(text)) {
    return buildClassification(input, {
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      resetsAtMs: readStableRetryTimeResetAtMs(text, input.nowMs ?? Date.now()),
      retryAfterMs: readRetryAfterMs(record),
      source: 'stable_provider_message',
      recoveryAction: codexUsageLimitRecoveryAction,
    });
  }

  if (isStructuredRefreshFailureCode(codexErrorInfo) || isStructuredRefreshFailureCode(structuredCode) || containsRefreshTokenFailureMessage(text)) {
    return buildClassification(input, {
      kind: 'refresh_failed',
      limitCategory: 'auth_invalid',
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  if (isStructuredAuthExpiredCode(codexErrorInfo) || isStructuredAuthExpiredCode(structuredCode) || containsOauthTokenInvalidatedMessage(text)) {
    return buildClassification(input, {
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  if (text.includes(CODEX_ACCOUNT_CHANGED_MESSAGE)) {
    return buildClassification(input, {
      kind: 'account_changed',
      limitCategory: 'auth_invalid',
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  if (!input.providerErrorPath) return null;

  const genericRuntimeIssueSource = input.genericRuntimeIssueSource ?? null;
  if (genericRuntimeIssueSource === 'usage_limit') {
    return buildClassification(input, {
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      resetsAtMs: readStableRetryTimeResetAtMs(text, input.nowMs ?? Date.now()),
      source: 'stable_provider_message',
      recoveryAction: codexUsageLimitRecoveryAction,
    });
  }
  if (genericRuntimeIssueSource === 'auth_error') {
    return buildClassification(input, {
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      source: 'stable_provider_message',
    });
  }
  if (genericRuntimeIssueSource === 'permission_blocked') {
    return buildClassification(input, {
      kind: 'permission_denied',
      limitCategory: 'plan_invalid',
      source: 'stable_provider_message',
    });
  }
  return null;
}
