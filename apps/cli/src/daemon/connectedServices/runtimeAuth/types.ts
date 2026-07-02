import { z } from 'zod';
import type { ConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol';

export const CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_KINDS = [
  'usage_limit',
  'rate_limit',
  'temporary_throttle',
  'capacity',
  'dependency_failure',
  'auth_expired',
  'account_changed',
  'refresh_failed',
  'permission_denied',
  'plan',
  'validation',
  'account_disabled',
  'unknown',
] as const;

export type ConnectedServiceRuntimeAuthFailureKind =
  typeof CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_KINDS[number];

export const ConnectedServiceRuntimeAuthFailureKindSchema = z.enum(CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_KINDS);

export type ConnectedServiceRuntimeLimitCategory = ConnectedServiceLimitCategoryV1;

export type ConnectedServiceRuntimeQuotaScope =
  | 'account'
  | 'workspace'
  | 'organization'
  | 'model'
  | 'provider'
  | 'unknown';

export type ConnectedServiceRuntimeFailureClassification = Readonly<{
  kind: ConnectedServiceRuntimeAuthFailureKind;
  limitCategory?: ConnectedServiceRuntimeLimitCategory;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  resetsAtMs: number | null;
  retryAfterMs?: number | null;
  planType: string | null;
  providerLimitId?: string | null;
  quotaScope?: ConnectedServiceRuntimeQuotaScope;
  connectedServiceRecovery?: 'available' | 'unavailable';
  action?: Readonly<{ kind: 'open_url'; url: string }> | null;
  rateLimits: unknown | null;
  source: 'structured_provider_error' | 'stable_provider_message' | 'provider_runtime_marker';
  recoveryAction?:
    | Readonly<{ kind: 'provider_state_sharing_required' }>
    | Readonly<{ kind: 'quota_recovery_required' }>
    | null;
}>;

export type ConnectedServiceRuntimeAuthTargetInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  selection: unknown;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  materializedEnv?: Readonly<Record<string, string>> | null;
  env?: Readonly<Record<string, string>> | null;
}>;

export type ConnectedServiceRuntimeFailureInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  error: unknown;
  selection?: unknown;
}>;

export type ConnectedServiceRuntimeAuthAdapterResult = Readonly<Record<string, unknown>>;

export type ConnectedServiceAccountTransitionVerificationResult =
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

export type ConnectedServiceProviderRuntimeAuthAdapter = Readonly<{
  classifyRuntimeAuthFailure(input: ConnectedServiceRuntimeFailureInput): ConnectedServiceRuntimeFailureClassification | null;
  materializeActiveProfile(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceRuntimeAuthAdapterResult>;
  canHotApply(input: ConnectedServiceRuntimeAuthTargetInput): ConnectedServiceRuntimeAuthAdapterResult;
  hotApply(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceRuntimeAuthAdapterResult>;
  recoverAfterRuntimeAuthSwitch(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceRuntimeAuthAdapterResult>;
  verifyActiveAccount?(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceAccountTransitionVerificationResult>;
  probeQuota(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceRuntimeAuthAdapterResult>;
  refreshActiveProfile(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceRuntimeAuthAdapterResult>;
}>;
