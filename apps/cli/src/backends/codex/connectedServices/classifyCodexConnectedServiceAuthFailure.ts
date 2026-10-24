import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import {
  ConnectedServiceCredentialRevisionV1Schema,
  buildUsageLimitIssueFingerprint,
  type SessionRuntimeIssueV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceId,
  type ConnectedServiceLimitCategoryV1,
  type ConnectedServiceProfileId,
} from '@happier-dev/protocol';

import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { classifyProviderLimitEvidence } from '@/daemon/connectedServices/quotas/normalization';
import { normalizeConnectedServiceAccessTokenFingerprint } from '@/daemon/connectedServices/refresh/credentialFreshness/tokenFingerprint';
import { readCodexProviderErrorRecord } from '../utils/readCodexProviderErrorRecord';

export type CodexConnectedServiceRuntimeFailureKind =
  | 'usage_limit'
  | 'capacity'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failed'
  | 'permission_denied'
  | 'plan'
  | 'unknown';

export type CodexConnectedServiceRuntimeFailureClassification = Readonly<{
  runtimeIssueFingerprint?: string | null;
  kind: CodexConnectedServiceRuntimeFailureKind;
  limitCategory?: ConnectedServiceLimitCategoryV1;
  serviceId: ConnectedServiceId;
  profileId: ConnectedServiceProfileId | null;
  groupId: string | null;
  groupGeneration?: number | null;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  resetsAtMs: number | null;
  retryAfterMs: number | null;
  quotaScope?: 'provider' | 'model';
  providerLimitId?: string | null;
  planType: string | null;
  rateLimits: unknown | null;
  sourceProviderAccountId?: string | null;
  sourceAccountLabel?: string | null;
  failingAccessTokenFingerprint?: string | null;
  source: 'structured_provider_error' | 'stable_provider_message' | 'provider_runtime_marker';
  recoveryAction?: CodexConnectedServiceRecoveryAction | null;
}>;

export type CodexConnectedServiceRecoveryAction =
  | Readonly<{ kind: 'provider_state_sharing_required' }>
  | Readonly<{ kind: 'quota_recovery_required' }>;

export type ClassifyCodexConnectedServiceAuthFailureInput = Readonly<{
  providerErrorPath: boolean;
  error: unknown;
  serviceId: ConnectedServiceId;
  profileId: ConnectedServiceProfileId | null;
  groupId: string | null;
  sourceAccountIdentity?: Readonly<{
    providerAccountId?: string | null;
    accountLabel?: string | null;
    groupGeneration?: string | number | null;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    credentialFingerprint?: string | null;
  }> | null;
}>;

const CODEX_ACCOUNT_CHANGED_MESSAGE =
  'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';

const authExpiredProviderCodes = new Set([
  'token_invalidated',
  'token_revoked',
]);

const refreshFailedProviderCodes = new Set([
  'refresh_token_invalidated',
  'refresh_token_reused',
  'refresh_token_revoked',
]);

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readErrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  const record = readCodexProviderErrorRecord(value);
  if (!record) return '';
  return [record.message, record.additionalDetails, record.additional_details, record.error, record.code, record.codexErrorInfo, record.codex_error_info]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
}

export function isCodexProviderCapacityFailure(value: unknown): boolean {
  const evidence = value instanceof Error
    ? { message: value.message }
    : readCodexProviderErrorRecord(value) ?? value;
  if (classifyProviderLimitEvidence(evidence) === 'capacity') return true;
  return /\bapplication\s+network\s+permission\s+was\s+revoked\b/i.test(readErrorText(value));
}

function isStructuredUsageLimitCode(value: string | null): boolean {
  return value === 'UsageLimitExceeded'
    || value === 'UsageLimitReached'
    || value === 'usageLimitExceeded'
    || value === 'usage_limit_exceeded'
    || value === 'usage_limit_reached';
}

function normalizeProviderCode(value: string | null): string | null {
  return value ? value.trim().toLowerCase() : null;
}

function containsAuthTokenInvalidatedMessage(text: string): boolean {
  return /authentication\s+token\s+has\s+been\s+invalidated/i.test(text);
}

function containsOauthTokenInvalidatedMessage(text: string): boolean {
  return /invalidated\s+oauth\s+token/i.test(text);
}

function containsRefreshTokenFailureMessage(text: string): boolean {
  return /refresh\s+token\s+has\s+already\s+been\s+used/i.test(text)
    || /refresh\s+token\s+was\s+already\s+used/i.test(text)
    || /refresh\s+token\s+(?:(?:has\s+been|was)\s+)?(?:invalidated|revoked)/i.test(text);
}

function readChatGptAccountUnsupportedModel(text: string): string | null {
  return /The\s+['"]([^'"]+)['"]\s+model\s+is\s+not\s+supported\s+when\s+using\s+Codex\s+with\s+a\s+ChatGPT\s+account\./i.exec(text)?.[1]?.trim() || null;
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

function readRetryAfterMs(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric);
}

// F11: human-readable "try again at <time/date>" retry wording carries no timezone/offset
// and must stay advisory-only — it is never parsed into a durable daemon-local
// `resetsAtMs`. Only structured provider reset metadata may drive reset timing.
function buildClassification(
  input: ClassifyCodexConnectedServiceAuthFailureInput,
  params: Readonly<{
    kind: CodexConnectedServiceRuntimeFailureKind;
    limitCategory?: CodexConnectedServiceRuntimeFailureClassification['limitCategory'];
    resetsAtMs?: number | null;
    retryAfterMs?: number | null;
    quotaScope?: CodexConnectedServiceRuntimeFailureClassification['quotaScope'];
    providerLimitId?: string | null;
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
  const groupGeneration = readNonNegativeInteger(input.sourceAccountIdentity?.groupGeneration);
  const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
    input.sourceAccountIdentity?.credentialRevision,
  );
  const failingAccessTokenFingerprint = normalizeConnectedServiceAccessTokenFingerprint(
    input.sourceAccountIdentity?.credentialFingerprint,
  );
  return {
    kind: params.kind,
    ...(params.limitCategory ? { limitCategory: params.limitCategory } : {}),
    serviceId: input.serviceId,
    profileId: input.profileId,
    groupId: input.groupId,
    ...(groupGeneration !== null ? { groupGeneration } : {}),
    ...(credentialRevision.success ? { credentialRevision: credentialRevision.data } : {}),
    resetsAtMs: params.resetsAtMs ?? null,
    retryAfterMs: params.retryAfterMs ?? null,
    ...(params.quotaScope ? { quotaScope: params.quotaScope } : {}),
    ...(params.providerLimitId ? { providerLimitId: params.providerLimitId } : {}),
    planType: params.planType ?? null,
    rateLimits: params.rateLimits ?? null,
    ...(sourceProviderAccountId ? { sourceProviderAccountId } : {}),
    ...(sourceProviderAccountId && sourceAccountLabel !== null ? { sourceAccountLabel } : {}),
    ...(failingAccessTokenFingerprint ? { failingAccessTokenFingerprint } : {}),
    source: params.source,
    ...(params.recoveryAction ? { recoveryAction: params.recoveryAction } : {}),
  };
}

// Usage-limit (capacity) recovery is distinct from provider state-sharing capability.
// Quota recovery is satisfied by proven fresh quota or canonical provider-account proof, not by
// sharing vendor continuity state. Keep `provider_state_sharing_required` reserved for genuine
// continuity/state-sharing failures.
const codexUsageLimitRecoveryAction = { kind: 'quota_recovery_required' } as const;

export function classifyCodexConnectedServiceAuthFailure(
  input: ClassifyCodexConnectedServiceAuthFailureInput,
): CodexConnectedServiceRuntimeFailureClassification | null {
  const record = readCodexProviderErrorRecord(input.error);
  const codexErrorInfo = readString(record?.codexErrorInfo ?? record?.codex_error_info);
  const structuredCode = readString(record?.code ?? record?.type ?? record?.reason);
  if (isStructuredUsageLimitCode(codexErrorInfo) || isStructuredUsageLimitCode(structuredCode)) {
    return buildClassification(input, {
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      resetsAtMs: readResetAtMs(record?.resetsAt ?? record?.resets_at),
      retryAfterMs: readRetryAfterMs(record?.retryAfterMs ?? record?.retry_after_ms),
      planType: readString(record?.planType ?? record?.plan_type),
      rateLimits: record?.rateLimits ?? record?.rate_limits ?? null,
      source: 'structured_provider_error',
      recoveryAction: codexUsageLimitRecoveryAction,
    });
  }

  const text = readErrorText(input.error);
  if (text.includes(CODEX_ACCOUNT_CHANGED_MESSAGE)) {
    return buildClassification(input, {
      kind: 'account_changed',
      limitCategory: 'auth_invalid',
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  if (!input.providerErrorPath) return null;

  const unsupportedModel = readChatGptAccountUnsupportedModel(text);
  if (unsupportedModel) {
    return buildClassification(input, {
      kind: 'plan',
      limitCategory: 'plan_invalid',
      quotaScope: 'model',
      providerLimitId: unsupportedModel,
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  const providerCode = normalizeProviderCode(structuredCode ?? codexErrorInfo);
  if ((providerCode && refreshFailedProviderCodes.has(providerCode)) || containsRefreshTokenFailureMessage(text)) {
    return buildClassification(input, {
      kind: 'refresh_failed',
      limitCategory: 'auth_invalid',
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  if (
    (providerCode && authExpiredProviderCodes.has(providerCode))
    || containsAuthTokenInvalidatedMessage(text)
    || containsOauthTokenInvalidatedMessage(text)
  ) {
    return buildClassification(input, {
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  if (isCodexProviderCapacityFailure(input.error)) {
    return buildClassification(input, {
      kind: 'capacity',
      limitCategory: 'capacity',
      quotaScope: 'provider',
      source: record ? 'structured_provider_error' : 'stable_provider_message',
    });
  }

  const generic = classifyPrimarySessionRuntimeIssue({
    provider: 'codex',
    cause: 'status_error',
    // The app-server wraps stable provider copy below `error` or `turn.error`.
    // Classify that extracted provider text rather than the transport envelope.
    error: text || input.error,
  });
  if (generic.source === 'usage_limit') {
    return buildClassification(input, {
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      source: 'stable_provider_message',
      recoveryAction: codexUsageLimitRecoveryAction,
    });
  }
  if (generic.source === 'auth_error') {
    return buildClassification(input, {
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      source: 'stable_provider_message',
    });
  }
  if (generic.source === 'permission_blocked') {
    return buildClassification(input, {
      kind: 'permission_denied',
      limitCategory: 'plan_invalid',
      source: 'stable_provider_message',
    });
  }
  return null;
}

export function readCodexRuntimeAuthClassification(error: unknown): ConnectedServiceRuntimeFailureClassification | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const record = error as Record<string, unknown>;
  return sanitizeConnectedServiceRuntimeFailureClassification(record.runtimeAuthClassification);
}

export function attachCodexRuntimeAuthFailureIssue(error: unknown, issue: SessionRuntimeIssueV1): void {
  const classification = readCodexRuntimeAuthClassification(error);
  if (!classification) return;
  Object.assign(error as object, {
    runtimeAuthClassification: {
      ...classification,
      runtimeIssueFingerprint: buildUsageLimitIssueFingerprint(issue),
    },
  });
}

export function createCodexRuntimeAuthFailureTurnHook(
  reportFailure: (classification: ConnectedServiceRuntimeFailureClassification, error: unknown) => Promise<void>,
): (failure: Readonly<{ error: unknown; issue?: SessionRuntimeIssueV1 | null }>) => Promise<void> {
  return async ({ error, issue }) => {
    if (!issue) return;
    attachCodexRuntimeAuthFailureIssue(error, issue);
    const classification = readCodexRuntimeAuthClassification(error);
    if (classification?.runtimeIssueFingerprint) await reportFailure(classification, error);
  };
}
