import { readConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol';

import {
  ConnectedServiceRuntimeAuthFailureKindSchema,
  type ConnectedServiceRuntimeAuthFailureKind,
  type ConnectedServiceRuntimeFailureClassification,
  type ConnectedServiceRuntimeLimitCategory,
  type ConnectedServiceRuntimeQuotaScope,
} from './types';

const SAFE_STRING_MAX_LENGTH = 512;
const SAFE_ACTION_URL_MAX_LENGTH = 2_048;

const QUOTA_SCOPES = new Set<ConnectedServiceRuntimeQuotaScope>([
  'account',
  'workspace',
  'organization',
  'model',
  'provider',
  'unknown',
]);

const SOURCES = new Set<ConnectedServiceRuntimeFailureClassification['source']>([
  'structured_provider_error',
  'stable_provider_message',
  'provider_runtime_marker',
]);

const SECRETISH_VALUE_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|bearer|secret|password|credential)\b/i;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function readBoundedString(value: unknown, maxLength = SAFE_STRING_MAX_LENGTH): string | null {
  const normalized = readNonEmptyString(value);
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function readSafeProviderString(value: unknown): string | null {
  const normalized = readBoundedString(value);
  if (!normalized || SECRETISH_VALUE_PATTERN.test(normalized)) return null;
  return normalized;
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return readBoundedString(value);
}

function readNullableSafeProviderString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return readSafeProviderString(value);
}

function readNullableTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function readNullableNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : null;
  if (numeric === null || !Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric);
}

function readKind(value: unknown): ConnectedServiceRuntimeAuthFailureKind | null {
  const parsed = ConnectedServiceRuntimeAuthFailureKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readLimitCategory(value: unknown): ConnectedServiceRuntimeLimitCategory | undefined {
  return readConnectedServiceLimitCategoryV1(value) ?? undefined;
}

function readQuotaScope(value: unknown): ConnectedServiceRuntimeQuotaScope | undefined {
  return typeof value === 'string' && QUOTA_SCOPES.has(value as ConnectedServiceRuntimeQuotaScope)
    ? value as ConnectedServiceRuntimeQuotaScope
    : undefined;
}

function readSource(value: unknown): ConnectedServiceRuntimeFailureClassification['source'] | null {
  return typeof value === 'string' && SOURCES.has(value as ConnectedServiceRuntimeFailureClassification['source'])
    ? value as ConnectedServiceRuntimeFailureClassification['source']
    : null;
}

function readSafeAction(
  value: unknown,
): NonNullable<ConnectedServiceRuntimeFailureClassification['action']> | null {
  if (!isRecord(value) || value.kind !== 'open_url') return null;
  const rawUrl = readBoundedString(value.url, SAFE_ACTION_URL_MAX_LENGTH);
  if (!rawUrl || SECRETISH_VALUE_PATTERN.test(rawUrl)) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return { kind: 'open_url', url: parsed.toString() };
}

function readRecoveryAction(
  value: unknown,
): NonNullable<ConnectedServiceRuntimeFailureClassification['recoveryAction']> | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'provider_state_sharing_required') return { kind: 'provider_state_sharing_required' };
  if (value.kind === 'quota_recovery_required') return { kind: 'quota_recovery_required' };
  return null;
}

function readConnectedServiceRecovery(value: unknown): ConnectedServiceRuntimeFailureClassification['connectedServiceRecovery'] | undefined {
  return value === 'available' || value === 'unavailable' ? value : undefined;
}

export function sanitizeConnectedServiceRuntimeFailureClassification(
  value: unknown,
): ConnectedServiceRuntimeFailureClassification | null {
  if (!isRecord(value)) return null;
  const kind = readKind(value.kind);
  const serviceId = readBoundedString(value.serviceId);
  const source = readSource(value.source);
  if (!kind || !serviceId || !source) return null;

  const rateLimits = isRecord(value.rateLimits) ? value.rateLimits : null;
  const limitCategorySource = value.limitCategory === undefined ? rateLimits?.limitCategory : value.limitCategory;
  const limitCategory = readLimitCategory(limitCategorySource);
  const retryAfterMs = readNullableTimestampMs(value.retryAfterMs);
  const quotaScopeSource = value.quotaScope === undefined ? rateLimits?.quotaScope : value.quotaScope;
  const quotaScope = readQuotaScope(quotaScopeSource);
  const providerLimitIdSource = value.providerLimitId === undefined ? rateLimits?.providerLimitId : value.providerLimitId;
  const providerLimitId = readNullableSafeProviderString(providerLimitIdSource);
  const sourceProviderAccountId = readNullableSafeProviderString(value.sourceProviderAccountId);
  const sourceAccountLabel = sourceProviderAccountId
    ? readNullableSafeProviderString(value.sourceAccountLabel)
    : null;
  const failingAccessTokenFingerprint = readNullableSafeProviderString(value.failingAccessTokenFingerprint);
  const groupGeneration = readNullableNonNegativeInteger(value.groupGeneration);
  const actionSource = value.action === undefined ? rateLimits?.action : value.action;
  const action = readSafeAction(actionSource);
  const recoveryAction = readRecoveryAction(value.recoveryAction);
  const connectedServiceRecovery = readConnectedServiceRecovery(value.connectedServiceRecovery);

  return {
    kind,
    ...(limitCategory ? { limitCategory } : {}),
    serviceId,
    profileId: readNullableString(value.profileId),
    groupId: readNullableString(value.groupId),
    resetsAtMs: readNullableTimestampMs(value.resetsAtMs),
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(quotaScope ? { quotaScope } : {}),
    ...(providerLimitIdSource === undefined ? {} : { providerLimitId }),
    ...(sourceProviderAccountId ? { sourceProviderAccountId } : {}),
    ...(sourceProviderAccountId && value.sourceAccountLabel !== undefined ? { sourceAccountLabel } : {}),
    ...(failingAccessTokenFingerprint ? { failingAccessTokenFingerprint } : {}),
    ...(groupGeneration === null ? {} : { groupGeneration }),
    ...(actionSource === undefined ? {} : { action }),
    planType: readNullableSafeProviderString(value.planType),
    ...(connectedServiceRecovery ? { connectedServiceRecovery } : {}),
    rateLimits: null,
    source,
    ...(value.recoveryAction === undefined ? {} : { recoveryAction }),
  };
}
