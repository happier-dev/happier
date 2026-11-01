import { z } from 'zod';
import type {
  ConnectedServiceCredentialHealthStatusV1,
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceLimitCategoryV1,
  ProviderAccountUsageRecordId,
} from '@happier-dev/protocol';
import type { ConnectedServiceSharedGenerationMutationCurrentness } from '../credentials/lifecycleTypes';
import type { ConnectedServiceAccountTransitionVerificationResult } from '../accountTransitions/connectedServiceAccountTransition';
import { lazySchema } from '@happier-dev/protocol';

export const ConnectedServiceRuntimeAuthFailureKindSchema = lazySchema(() => z.enum([
  'usage_limit',
  'rate_limit',
  'capacity',
  'auth_expired',
  'account_changed',
  'refresh_failed',
  'permission_denied',
  'plan',
  'validation',
  'account_disabled',
  'temporary_throttle',
  'dependency_failure',
  'unknown',
]));

export type ConnectedServiceRuntimeAuthFailureKind =
  z.infer<typeof ConnectedServiceRuntimeAuthFailureKindSchema>;

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
  groupGeneration?: number | null;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  activeProfileId?: string | null;
  credentialHealthStatus?: ConnectedServiceCredentialHealthStatusV1 | null;
  identityProofVersion?: number | null;
  sourceKey?: string | null;
  providerAccountUsageRecordId?: ProviderAccountUsageRecordId | null;
  resetsAtMs: number | null;
  retryAfterMs?: number | null;
  quotaScope?: ConnectedServiceRuntimeQuotaScope;
  providerLimitId?: string | null;
  sourceProviderAccountId?: string | null;
  sourceProviderOrganizationId?: string | null;
  /** Exact public issue associated with this accepted runtime failure. */
  runtimeIssueFingerprint?: string | null;
  sourceAccountLabel?: string | null;
  failingAccessTokenFingerprint?: string | null;
  action?: Readonly<{ kind: 'open_url'; url: string }> | null;
  planType: string | null;
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
  validateCurrentBeforeMutation?: () => Promise<ConnectedServiceSharedGenerationMutationCurrentness>;
}>;

export type ConnectedServiceRuntimeFailureInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  error: unknown;
  selection?: unknown;
}>;

export type ConnectedServiceRuntimeAuthAdapterResult = Readonly<Record<string, unknown>>;

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
