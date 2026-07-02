import type { ConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol';

import { verifyClaudeCodeNativeAuth } from '../native/verify.js';
import { mapClaudeRateLimitEventToUsageDetails } from './usage.js';

export type ClaudeConnectedServiceRuntimeFailureKind =
  | 'usage_limit'
  | 'rate_limit'
  | 'temporary_throttle'
  | 'capacity'
  | 'dependency_failure'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failed'
  | 'permission_denied'
  | 'plan'
  | 'validation'
  | 'account_disabled'
  | 'unknown';

export type ClaudeConnectedServiceRuntimeFailureClassification = Readonly<{
  kind: ClaudeConnectedServiceRuntimeFailureKind;
  limitCategory?: ConnectedServiceLimitCategoryV1;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  resetsAtMs: number | null;
  retryAfterMs?: number | null;
  planType: string | null;
  providerLimitId?: string | null;
  quotaScope?: 'account' | 'workspace' | 'organization' | 'model' | 'provider' | 'unknown';
  action?: Readonly<{ kind: 'open_url'; url: string }> | null;
  rateLimits: unknown | null;
  source: 'structured_provider_error' | 'stable_provider_message' | 'provider_runtime_marker';
  recoveryAction?:
    | Readonly<{ kind: 'provider_state_sharing_required' }>
    | Readonly<{ kind: 'quota_recovery_required' }>
    | null;
}>;

export type ClaudeRuntimeAuthTargetInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  selection: unknown;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  materializedEnv?: Readonly<Record<string, string>> | null;
  env?: Readonly<Record<string, string>> | null;
}>;

export type ClaudeRuntimeFailureInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  error: unknown;
  selection?: unknown;
}>;

export type ClaudeRuntimeAuthAdapterResult = Readonly<Record<string, unknown>>;

export type ClaudeConnectedServiceAccountTransitionVerificationResult =
  | Readonly<{
      status: 'verified';
      providerAccountId?: string | null;
      reason?: string;
    }>
  | Readonly<{
      status: 'weakly_verified';
      providerAccountId?: string | null;
      reason: string;
    }>
  | Readonly<{
      status: 'mismatch';
      expectedProviderAccountId?: string | null;
      actualProviderAccountId?: string | null;
      retryable: boolean;
      reason?: string;
    }>
  | Readonly<{
      status: 'unavailable';
      retryable: boolean;
      reason: string;
      errorClassification?: unknown;
    }>;

export type ClaudeConnectedServiceRuntimeAuthAdapter = Readonly<{
  classifyRuntimeAuthFailure(input: ClaudeRuntimeFailureInput): ClaudeConnectedServiceRuntimeFailureClassification | null;
  materializeActiveProfile(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
  canHotApply(input: ClaudeRuntimeAuthTargetInput): ClaudeRuntimeAuthAdapterResult;
  hotApply(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
  recoverAfterRuntimeAuthSwitch(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
  verifyActiveAccount?(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeConnectedServiceAccountTransitionVerificationResult>;
  probeQuota(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
  refreshActiveProfile(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
}>;

export type ClassifyClaudeConnectedServiceRuntimeAuthFailureInput = Readonly<{
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  error: unknown;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error ?? '');
}

function hasClaudeAuthFailureEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /auth|credential|login|oauth|token|unauthori[sz]ed|api[_ -]?error[_ -]?status.*401|401/u.test(value);
  }
  if (Array.isArray(value)) return value.some(hasClaudeAuthFailureEvidence);
  const record = readRecord(value);
  if (!record) return false;
  const status = record.api_error_status ?? record.status ?? record.statusCode ?? record.status_code;
  if (status === 401 || status === '401') return true;
  return [
    record.error,
    record.errors,
    record.code,
    record.type,
    record.kind,
    record.message,
    record.detail,
    record.details,
    record.description,
    record.response,
  ].some(hasClaudeAuthFailureEvidence);
}

function classifyGenericRuntimeAuthFailure(
  input: ClassifyClaudeConnectedServiceRuntimeAuthFailureInput,
): ClaudeConnectedServiceRuntimeFailureClassification | null {
  const message = readMessage(input.error).toLowerCase();
  if (/usage\s*limit|rate\s*limit|quota|too many requests/.test(message)) {
    return {
      kind: /rate\s*limit|too many requests/.test(message) ? 'rate_limit' : 'usage_limit',
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
  }
  if (/auth|credential|login|token/.test(message)) {
    return {
      kind: 'auth_expired',
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
  }
  return null;
}

export function classifyClaudeConnectedServiceRuntimeAuthFailure(
  input: ClassifyClaudeConnectedServiceRuntimeAuthFailureInput,
): ClaudeConnectedServiceRuntimeFailureClassification | null {
  const details = mapClaudeRateLimitEventToUsageDetails(input.error);
  if (!details) {
    if (!hasClaudeAuthFailureEvidence(input.error)) return classifyGenericRuntimeAuthFailure(input);
    return {
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      resetsAtMs: null,
      retryAfterMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    };
  }
  const limitCategory = details.limitCategory
    ?? (details.utilization !== null && details.utilization < 100 ? 'rate_limit' : 'usage_limit');
  return {
    kind: limitCategory === 'capacity'
      ? 'capacity'
      : limitCategory === 'rate_limit'
        ? 'rate_limit'
        : 'usage_limit',
    limitCategory,
    serviceId: input.serviceId,
    profileId: input.profileId,
    groupId: input.groupId,
    resetsAtMs: details.resetAtMs,
    retryAfterMs: details.retryAfterMs,
    providerLimitId: details.providerLimitId ?? null,
    quotaScope: details.quotaScope,
    action: details.action,
    planType: details.planType,
    rateLimits: details,
    source: 'structured_provider_error',
  };
}

function readMaterializedClaudeConfigDir(input: Readonly<{
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  materializedEnv?: Readonly<Record<string, string>> | null;
  env?: Readonly<Record<string, string>> | null;
}>): string | null {
  const raw =
    input.targetMaterializedEnv?.CLAUDE_CONFIG_DIR
    ?? input.materializedEnv?.CLAUDE_CONFIG_DIR
    ?? input.env?.CLAUDE_CONFIG_DIR
    ?? null;
  return readString(raw);
}

function readSelectionIds(selection: unknown): Readonly<{
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
}> {
  const record = readRecord(selection);
  return {
    serviceId: readString(record?.serviceId) ?? 'claude-subscription',
    profileId: readString(record?.activeProfileId ?? record?.profileId),
    groupId: readString(record?.groupId),
  };
}

export function createClaudeConnectedServiceRuntimeAuthAdapter(): ClaudeConnectedServiceRuntimeAuthAdapter {
  return {
    classifyRuntimeAuthFailure(input) {
      return classifyClaudeConnectedServiceRuntimeAuthFailure({
        ...readSelectionIds(input.selection),
        error: input.error,
      });
    },
    async materializeActiveProfile() {
      return { supported: false, recovery: 'restart_resume' };
    },
    canHotApply() {
      return { supported: false, recovery: 'restart_resume' };
    },
    async hotApply() {
      return { applied: false, recovery: 'restart_resume' };
    },
    async recoverAfterRuntimeAuthSwitch(input) {
      const selection = readRecord(input.selection);
      const restartAndResume = selection?.restartAndResume;
      if (typeof restartAndResume !== 'function') {
        return { recovered: false, reason: 'missing_restart_resume' };
      }
      await restartAndResume();
      return { recovered: true, recovery: 'restart_resume' };
    },
    async verifyActiveAccount(input) {
      const claudeConfigDir = readMaterializedClaudeConfigDir(input);
      if (!claudeConfigDir) {
        return { status: 'verified', reason: 'provider_restart_rematerialization_authoritative' };
      }
      const verification = await verifyClaudeCodeNativeAuth({ claudeConfigDir });
      if (verification.status === 'ok') {
        return { status: 'verified', reason: 'claude_code_native_credentials_file_verified' };
      }
      return {
        status: 'unavailable',
        retryable: verification.status === 'expired',
        reason: verification.status,
      };
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
