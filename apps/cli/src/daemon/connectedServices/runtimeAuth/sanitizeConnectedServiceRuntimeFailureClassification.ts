import {
  ConnectedServiceCredentialHealthStatusV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ProviderAccountUsageRecordIdSchema,
  readConnectedServiceLimitCategoryV1,
} from '@happier-dev/protocol';

import {
  ConnectedServiceRuntimeAuthFailureKindSchema,
  type ConnectedServiceRuntimeAuthFailureKind,
  type ConnectedServiceRuntimeFailureClassification,
  type ConnectedServiceRuntimeLimitCategory,
  type ConnectedServiceRuntimeQuotaScope,
} from './types';
import { normalizeConnectedServiceAccessTokenFingerprint } from '../refresh/credentialFreshness/tokenFingerprint';

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

function readNullableNonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function readKind(value: unknown): ConnectedServiceRuntimeAuthFailureKind | null {
  const parsed = ConnectedServiceRuntimeAuthFailureKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Report admission only: daemon intake may separately enrich an account binding. */
export function isConnectedServiceRuntimeFailureReportApplicable(value: unknown): boolean {
  if (!isRecord(value)) return true;
  const kind = readKind(value.kind);
  const needsConnectedAccount = kind === 'usage_limit' || kind === 'auth_expired'
    || kind === 'refresh_failed' || kind === 'account_changed' || kind === 'account_disabled'
    || kind === 'permission_denied';
  return !needsConnectedAccount || Boolean(readNullableString(value.profileId) || readNullableString(value.groupId));
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

function readCredentialHealthStatus(
  value: unknown,
): NonNullable<ConnectedServiceRuntimeFailureClassification['credentialHealthStatus']> | null {
  const parsed = ConnectedServiceCredentialHealthStatusV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readProviderAccountUsageRecordId(
  value: unknown,
): NonNullable<ConnectedServiceRuntimeFailureClassification['providerAccountUsageRecordId']> | null {
  const parsed = ProviderAccountUsageRecordIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function sanitizeConnectedServiceRuntimeFailureClassification(
  value: unknown,
): ConnectedServiceRuntimeFailureClassification | null {
  if (!isRecord(value)) return null;
  const kind = readKind(value.kind);
  const serviceId = readBoundedString(value.serviceId);
  const source = readSource(value.source);
  if (!kind || !serviceId || !source) return null;

  const limitCategory = readLimitCategory(value.limitCategory);
  const retryAfterMs = readNullableTimestampMs(value.retryAfterMs);
  const quotaScope = readQuotaScope(value.quotaScope);
  const providerLimitId = readNullableSafeProviderString(value.providerLimitId);
  const sourceProviderAccountId = readNullableSafeProviderString(value.sourceProviderAccountId);
  const sourceProviderOrganizationId = readNullableSafeProviderString(value.sourceProviderOrganizationId);
  const failingAccessTokenFingerprint = normalizeConnectedServiceAccessTokenFingerprint(value.failingAccessTokenFingerprint);
  const sourceAccountLabel = sourceProviderAccountId
    ? readNullableSafeProviderString(value.sourceAccountLabel)
    : null;
  const activeProfileId = readNullableString(value.activeProfileId);
  const sourceKey = readNullableSafeProviderString(value.sourceKey);
  const credentialHealthStatus = readCredentialHealthStatus(value.credentialHealthStatus);
  const providerAccountUsageRecordId = readProviderAccountUsageRecordId(value.providerAccountUsageRecordId);
  const action = readSafeAction(value.action);
  const recoveryAction = readRecoveryAction(value.recoveryAction);
  const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(value.credentialRevision);

  return {
    kind,
    ...(readBoundedString(value.runtimeIssueFingerprint) ? { runtimeIssueFingerprint: readBoundedString(value.runtimeIssueFingerprint) } : {}),
    ...(limitCategory ? { limitCategory } : {}),
    serviceId,
    profileId: readNullableString(value.profileId),
    groupId: readNullableString(value.groupId),
    ...(value.groupGeneration === undefined ? {} : { groupGeneration: readNullableNonNegativeInt(value.groupGeneration) }),
    ...(value.credentialRevision === undefined
      ? {}
      : { credentialRevision: credentialRevision.success ? credentialRevision.data : null }),
    ...(value.activeProfileId === undefined ? {} : { activeProfileId }),
    ...(value.credentialHealthStatus === undefined ? {} : { credentialHealthStatus }),
    ...(value.identityProofVersion === undefined
      ? {}
      : { identityProofVersion: readNullableNonNegativeInt(value.identityProofVersion) }),
    ...(value.sourceKey === undefined ? {} : { sourceKey }),
    ...(value.providerAccountUsageRecordId === undefined ? {} : { providerAccountUsageRecordId }),
    resetsAtMs: readNullableTimestampMs(value.resetsAtMs),
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(quotaScope ? { quotaScope } : {}),
    ...(value.providerLimitId === undefined ? {} : { providerLimitId }),
    ...(sourceProviderAccountId ? { sourceProviderAccountId } : {}),
    ...(sourceProviderAccountId && sourceProviderOrganizationId ? { sourceProviderOrganizationId } : {}),
    ...(sourceProviderAccountId && value.sourceAccountLabel !== undefined ? { sourceAccountLabel } : {}),
    ...(failingAccessTokenFingerprint ? { failingAccessTokenFingerprint } : {}),
    ...(value.action === undefined ? {} : { action }),
    planType: readNullableSafeProviderString(value.planType),
    rateLimits: null,
    source,
    ...(value.recoveryAction === undefined ? {} : { recoveryAction }),
  };
}
