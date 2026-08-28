import type {
  AgentSessionAuthRefreshErrorV1,
  AgentSessionAuthRefreshPayloadV1,
  ConnectedAccountServiceKey,
  ConnectedServiceLimitCategoryV1,
  ProviderAccountUsageQuotaScopeV1,
} from '@happier-dev/protocol';
import type { ConnectedServiceCredentialRecordV1 } from '../connectedAccounts.js';
import type { JsonValue } from '../identity.js';
import type { AgentAccountUsageSnapshot } from './accountUsage.js';
import type {
  AgentSessionRuntimeAuthApplyResult,
  RuntimeDescriptorV1,
} from './session.js';

/** Opaque host-owned credential revision carried through Agent continuity checks. */
export type AgentConnectedAccountCredentialRevisionV1 = string;

export const AGENT_CONNECTED_ACCOUNT_RUNTIME_AUTH_FAILURE_KINDS = [
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

export type AgentConnectedAccountRuntimeAuthFailureKind =
  typeof AGENT_CONNECTED_ACCOUNT_RUNTIME_AUTH_FAILURE_KINDS[number];

export type AgentConnectedAccountRuntimeFailureClassificationV1 = Readonly<{
  kind: AgentConnectedAccountRuntimeAuthFailureKind;
  limitCategory?: ConnectedServiceLimitCategoryV1;
  /** Canonical qualified Plugin contribution key of the failing service. */
  serviceId: ConnectedAccountServiceKey;
  profileId: string | null;
  groupId: string | null;
  resetsAtMs: number | null;
  retryAfterMs?: number | null;
  planType: string | null;
  providerLimitId?: string | null;
  sourceProviderAccountId?: string | null;
  sourceAccountLabel?: string | null;
  failingAccessTokenFingerprint?: string | null;
  expectedCredentialRevision?: AgentConnectedAccountCredentialRevisionV1 | null;
  groupGeneration?: number | null;
  quotaScope?: ProviderAccountUsageQuotaScopeV1;
  connectedServiceRecovery?: 'available' | 'unavailable';
  action?: Readonly<{ kind: 'open_url'; url: string }> | null;
  rateLimits: unknown | null;
  source: 'structured_provider_error' | 'stable_provider_message' | 'provider_runtime_marker';
  recoveryAction?:
    | Readonly<{ kind: 'provider_state_sharing_required' }>
    | Readonly<{ kind: 'quota_recovery_required' }>
    | null;
}>;

export type AgentConnectedAccountRuntimeAuthSelectionV1 = Readonly<{
  kind?: 'profile' | 'group';
  /** Canonical qualified Plugin contribution key of the selected service. */
  serviceId?: ConnectedAccountServiceKey;
  profileId?: string | null;
  activeProfileId?: string | null;
  fallbackProfileId?: string | null;
  groupId?: string | null;
  generation?: number | null;
  groupGeneration?: number | null;
  credentialRevision?: AgentConnectedAccountCredentialRevisionV1 | null;
  sourceProviderAccountId?: string | null;
  sourceAccountLabel?: string | null;
  applyReason?: string | null;
  requireDirectLiveHotApply?: boolean;
}>;

export type AgentConnectedAccountNativeAuthCodecMaterializeInputV1 = Readonly<{
  selection: AgentConnectedAccountRuntimeAuthSelectionV1;
  credential: ConnectedServiceCredentialRecordV1;
}>;

export type AgentConnectedAccountNativeAuthCodecInspectInputV1 = Readonly<{
  selection: AgentConnectedAccountRuntimeAuthSelectionV1;
  credential: ConnectedServiceCredentialRecordV1;
  files: Readonly<Record<string, Uint8Array>>;
}>;

/**
 * Pure Agent-native credential codec. The host supplies the exact selected
 * credential and declared file bytes, then exclusively owns path resolution,
 * currentness, replacement, permissions, and cleanup.
 */
export type AgentConnectedAccountNativeAuthCodecV1 = Readonly<{
  materialize(
    input: AgentConnectedAccountNativeAuthCodecMaterializeInputV1,
  ): Readonly<{ files: Readonly<Record<string, Uint8Array>> }>;
  inspect(
    input: AgentConnectedAccountNativeAuthCodecInspectInputV1,
  ): AgentConnectedAccountTransitionVerificationResultV1;
}>;

export type AgentConnectedAccountRuntimeAuthTargetV1 = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  selection: AgentConnectedAccountRuntimeAuthSelectionV1;
}>;

export type AgentConnectedAccountRuntimeAuthHotApplyInputV1 =
  AgentConnectedAccountRuntimeAuthTargetV1 & Readonly<{
    applySelectedAuthGeneration?: () => Promise<AgentSessionRuntimeAuthApplyResult>;
    materializeNativeAuth?: () => Promise<AgentConnectedAccountTransitionVerificationResultV1>;
  }>;

export type AgentConnectedAccountRuntimeAuthVerificationInputV1 =
  AgentConnectedAccountRuntimeAuthTargetV1 & Readonly<{
    readProviderAccount?: () => Promise<unknown>;
    inspectNativeAuth?: () => Promise<AgentConnectedAccountTransitionVerificationResultV1>;
  }>;

export type AgentConnectedAccountRuntimeAuthUsageInputV1 =
  AgentConnectedAccountRuntimeAuthTargetV1 & Readonly<{
    readProviderUsage?: (params?: JsonValue) => Promise<unknown>;
  }>;

export type AgentConnectedAccountRuntimeFailureInputV1 = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  error: unknown;
  selection?: Readonly<Record<string, unknown>>;
}>;

/**
 * The finite facts consumed by the host's existing Connected Account
 * orchestration. Provider-specific diagnostics remain nested evidence; adding
 * arbitrary top-level result fields is not a second control protocol.
 */
export type AgentConnectedAccountRuntimeAuthAdapterResultV1 = Readonly<{
  supported?: boolean;
  applied?: boolean;
  status?:
    | 'applied'
    | 'superseded_after_apply'
    | 'available'
    | 'unknown'
    | 'unsupported'
    | 'refreshed'
    | 'pending'
    | 'unavailable'
    | 'forbidden'
    | 'failed';
  reason?: string;
  recovery?: 'restart_resume' | 'restart_rematerialize';
  activeProfiles?: Readonly<Partial<Record<string, string>>>;
  /** Host validates this typed provider evidence before accepting it as proof. */
  verification?:
    | AgentConnectedAccountTransitionVerificationResultV1
    | NonNullable<Extract<AgentSessionRuntimeAuthApplyResult, { ok: true }>['verification']>;
  usageSnapshot?: AgentAccountUsageSnapshot;
  refreshAttemptId?: string;
  result?: AgentSessionAuthRefreshPayloadV1;
  error?: AgentSessionAuthRefreshErrorV1;
}>;

export type AgentConnectedAccountProviderOutcomeTargetV1 = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
  groupId: string | null;
  groupGeneration: number | null;
  credentialRevision: AgentConnectedAccountCredentialRevisionV1;
}>;

export type AgentConnectedAccountProviderOutcomeSelectionV1 = Readonly<{
  kind?: 'profile' | 'group';
  serviceId: ConnectedAccountServiceKey;
  profileId?: string | null;
  activeProfileId?: string | null;
  groupId?: string | null;
  generation?: number | null;
  credentialRevision?: AgentConnectedAccountCredentialRevisionV1 | null;
}>;

export type AgentConnectedAccountProviderOutcomeInputV1 = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  selections: readonly AgentConnectedAccountProviderOutcomeSelectionV1[];
  outcome:
    | Readonly<{ kind: 'provider_activity'; event: 'task_started' | 'assistant_message_end' }>
    | Readonly<{ kind: 'quota_unknown' }>;
}>;

export type AgentConnectedAccountProviderOutcomeVerificationResultV1 =
  | Readonly<{
      status: 'verified';
      source: string;
      targets: readonly AgentConnectedAccountProviderOutcomeTargetV1[];
    }>
  | Readonly<{ status: 'unavailable'; reason: string }>;

export type AgentConnectedAccountTransitionVerificationResultV1 =
  | Readonly<{
      status: 'verified';
      providerAccountId?: string | null;
      activeAccountId?: string | null;
      sharedAuthSurfaceId?: string | null;
      proofStrength?: 'exact' | 'weak' | 'diagnostic';
      source?: string;
      reason?: string;
      credentialRevision?: AgentConnectedAccountCredentialRevisionV1 | null;
      credentialFingerprint?: string | null;
      generationApplication?: Readonly<{
        serviceId: ConnectedAccountServiceKey;
        groupId: string;
        profileId: string;
        generation: number;
        credentialRevision: AgentConnectedAccountCredentialRevisionV1;
        credentialFingerprint: string;
      }>;
    }>
  | Readonly<{
      status: 'weakly_verified';
      providerAccountId?: string | null;
      activeAccountId?: string | null;
      sharedAuthSurfaceId?: string | null;
      proofStrength?: 'exact' | 'weak' | 'diagnostic';
      source?: string;
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

export type AgentConnectedAccountRuntimeAuthAdapterV1 = Readonly<{
  classifyRuntimeAuthFailure(
    input: AgentConnectedAccountRuntimeFailureInputV1,
  ): AgentConnectedAccountRuntimeFailureClassificationV1 | null;
  materializeActiveProfile(
    input: AgentConnectedAccountRuntimeAuthTargetV1,
  ): Promise<AgentConnectedAccountRuntimeAuthAdapterResultV1>;
  canHotApply(
    input: AgentConnectedAccountRuntimeAuthHotApplyInputV1,
  ): AgentConnectedAccountRuntimeAuthAdapterResultV1;
  hotApply(
    input: AgentConnectedAccountRuntimeAuthHotApplyInputV1,
  ): Promise<AgentConnectedAccountRuntimeAuthAdapterResultV1>;
  verifyActiveAccount?(
    input: AgentConnectedAccountRuntimeAuthVerificationInputV1,
  ): Promise<AgentConnectedAccountTransitionVerificationResultV1>;
  verifyProviderOutcome?(
    input: AgentConnectedAccountProviderOutcomeInputV1,
  ): Promise<AgentConnectedAccountProviderOutcomeVerificationResultV1>;
  probeQuota(
    input: AgentConnectedAccountRuntimeAuthUsageInputV1,
  ): Promise<AgentConnectedAccountRuntimeAuthAdapterResultV1>;
  refreshActiveProfile(
    input: AgentConnectedAccountRuntimeAuthTargetV1,
  ): Promise<AgentConnectedAccountRuntimeAuthAdapterResultV1>;
}>;

export type AgentConnectedAccountResumeFileCandidateV1 = Readonly<{
  fileName: string;
  nativeSessionId: string | null;
}>;

export type AgentConnectedAccountResumeFileLookupV1 = Readonly<{
  findDeclaredCandidate(input: Readonly<{
    matchesCandidate(candidate: AgentConnectedAccountResumeFileCandidateV1): boolean;
  }>): Promise<Readonly<{ found: boolean }>>;
}>;

export type AgentConnectedAccountResumeReachabilityInputV1 = Readonly<{
  vendorResumeId: string | null;
  /** Opaque Agent-owned resume/checkpoint facts; interpreted only by its owner. */
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  /**
   * Host-owned lookup over files beneath the Agent's declared state-sharing
   * entries. The Agent owns only native correlation; paths and filesystem
   * custody never cross this boundary.
   */
  sessionFiles: AgentConnectedAccountResumeFileLookupV1;
}>;

export type AgentConnectedAccountResumeReachabilityResultV1 =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

export type AgentConnectedAccountContinuityV1 = Readonly<{
  nativeAuthCodec?: AgentConnectedAccountNativeAuthCodecV1;
  runtimeAuthAdapter?: AgentConnectedAccountRuntimeAuthAdapterV1;
  verifyResumeReachable?: (
    input: AgentConnectedAccountResumeReachabilityInputV1,
  ) => Promise<AgentConnectedAccountResumeReachabilityResultV1>;
}>;
