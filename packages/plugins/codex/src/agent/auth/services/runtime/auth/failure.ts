import { parseTimestampMs } from '@happier-dev/plugin-sdk';
import { classifyProviderLimitEvidence } from '@happier-dev/plugin-sdk/first-party/connected-accounts';

type ProviderLimitCategory = ReturnType<typeof classifyProviderLimitEvidence>['category'];

export type CodexConnectedServiceRuntimeFailureKind =
  | 'usage_limit'
  | 'rate_limit'
  | 'temporary_throttle'
  | 'capacity'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failed'
  | 'permission_denied'
  | 'unknown';

export type CodexConnectedServiceRuntimeFailureClassification = Readonly<{
  kind: CodexConnectedServiceRuntimeFailureKind;
  limitCategory?: ProviderLimitCategory;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  resetsAtMs: number | null;
  retryAfterMs: number | null;
  connectedServiceRecovery?: 'available';
  quotaScope?: 'provider';
  planType: string | null;
  sourceProviderAccountId?: string | null;
  sourceAccountLabel?: string | null;
  failingAccessTokenFingerprint?: string | null;
  groupGeneration?: number | null;
  expectedCredentialRevision?: string | null;
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
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  nowMs?: number | null;
  genericRuntimeIssueSource?: CodexConnectedServiceGenericRuntimeIssueSource;
  sourceAccountIdentity?: Readonly<{
    providerAccountId?: string | null;
    accountLabel?: string | null;
    credentialFingerprint?: string | null;
    groupGeneration?: string | number | null;
    credentialRevision?: string | null;
  }> | null;
}>;

const CODEX_ACCOUNT_CHANGED_MESSAGE =
  'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCredentialFingerprint(value: unknown): string | null {
  const fingerprint = readString(value);
  return fingerprint && /^sha256:[a-f0-9]{8}$/u.test(fingerprint) ? fingerprint : null;
}

function readErrorRecord(value: unknown): Record<string, unknown> | null {
  const root = isRecord(value) ? value : null;
  const direct = isRecord(root?.error) ? root.error : null;
  const turn = isRecord(root?.turn) ? root.turn : null;
  const turnError = isRecord(turn?.error) ? turn.error : null;
  const data = isRecord(root?.data) ? root.data : null;
  const dataDirect = isRecord(data?.error) ? data.error : null;
  const dataTurn = isRecord(data?.turn) ? data.turn : null;
  const dataTurnError = isRecord(dataTurn?.error) ? dataTurn.error : null;
  return direct ?? turnError ?? dataDirect ?? dataTurnError ?? data ?? root;
}

function readErrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  const record = readErrorRecord(value);
  if (!record) return value instanceof Error ? value.message : '';
  return [
    value instanceof Error ? value.message : null,
    record.message,
    record.additionalDetails,
    record.additional_details,
    record.error,
    record.code,
    record.codexErrorInfo,
    record.codex_error_info,
  ]
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
  const normalized = value?.replace(/[_\-\s]/gu, '').toLowerCase() ?? null;
  return normalized === 'tokeninvalidated'
    || normalized === 'tokenrevoked'
    || normalized === 'invalidgrant'
    || normalized === 'refreshtokenexpired'
    || normalized === 'unauthenticated'
    || normalized === 'unauthorized'
    || normalized === 'authenticationrequired';
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

function containsChatGptAccountModelIncompatibility(text: string): boolean {
  return /\bmodel\b[\s\S]{0,180}\bnot supported\b[\s\S]{0,180}\busing Codex with a ChatGPT account\b/iu.test(text);
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
  if (typeof value === 'number') return parseTimestampMs(value);
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

function readNonNegativeInteger(value: unknown): number | null {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : null;
  if (numeric === null || !Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric);
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
    quotaScope?: CodexConnectedServiceRuntimeFailureClassification['quotaScope'];
    planType?: string | null;
    rateLimits?: unknown | null;
    source: CodexConnectedServiceRuntimeFailureClassification['source'];
    recoveryAction?: CodexConnectedServiceRecoveryAction | null;
  }>,
): CodexConnectedServiceRuntimeFailureClassification {
  const sourceProviderAccountId = readString(input.sourceAccountIdentity?.providerAccountId);
  const sourceAccountLabel = sourceProviderAccountId
    ? readString(input.sourceAccountIdentity?.accountLabel)
    : null;
  const failingAccessTokenFingerprint = sourceProviderAccountId
    ? readCredentialFingerprint(input.sourceAccountIdentity?.credentialFingerprint)
    : null;
  const groupGeneration = readNonNegativeInteger(input.sourceAccountIdentity?.groupGeneration);
  const rawCredentialRevision = input.sourceAccountIdentity?.credentialRevision;
  const expectedCredentialRevision = typeof rawCredentialRevision === 'string'
    && /^csr_[A-Za-z0-9_-]{22,64}$/u.test(rawCredentialRevision)
    ? rawCredentialRevision
    : null;
  return {
    kind: params.kind,
    ...(params.limitCategory ? { limitCategory: params.limitCategory } : {}),
    serviceId: input.serviceId,
    profileId: input.profileId,
    groupId: input.groupId,
    resetsAtMs: params.resetsAtMs ?? null,
    retryAfterMs: params.retryAfterMs ?? null,
    connectedServiceRecovery: 'available',
    ...(params.quotaScope ? { quotaScope: params.quotaScope } : {}),
    planType: params.planType ?? null,
    ...(sourceProviderAccountId ? { sourceProviderAccountId } : {}),
    ...(sourceProviderAccountId && sourceAccountLabel ? { sourceAccountLabel } : {}),
    ...(failingAccessTokenFingerprint ? { failingAccessTokenFingerprint } : {}),
    ...(groupGeneration === null ? {} : { groupGeneration }),
    ...(expectedCredentialRevision === null ? {} : { expectedCredentialRevision }),
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
  if (input.providerErrorPath && containsChatGptAccountModelIncompatibility(text)) {
    return buildClassification(input, {
      kind: 'permission_denied',
      limitCategory: 'plan_invalid',
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  if (input.providerErrorPath && containsTemporaryThrottleMessage(text)) {
    return buildClassification(input, {
      kind: 'temporary_throttle',
      limitCategory: 'rate_limit',
      retryAfterMs: readRetryAfterMs(record),
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  if (input.providerErrorPath && classifyProviderLimitEvidence(input.error).category === 'capacity') {
    return buildClassification(input, {
      kind: 'capacity',
      limitCategory: 'capacity',
      quotaScope: 'provider',
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

  if (text.includes(CODEX_ACCOUNT_CHANGED_MESSAGE)) {
    return buildClassification(input, {
      kind: 'account_changed',
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
