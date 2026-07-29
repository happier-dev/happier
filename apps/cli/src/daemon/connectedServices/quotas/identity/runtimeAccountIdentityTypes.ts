import type { ConnectedServiceId } from '@happier-dev/protocol';

export type RuntimeAccountIdentityProofStrength = 'exact' | 'weak';

export type RuntimeAccountIdentitySource =
  | 'runtime_quota_snapshot'
  | 'active_account_verification'
  | 'runtime_auth_failure_report'
  | 'runtime_identity_probe'
  // Durable fallback proof: the candidate's PERSISTED materialization identity (provider account id +
  // group binding) matched the failing account when a live runtime-identity probe was unavailable or
  // inexact. Survives daemon restarts (the in-memory runtime identity index does not).
  | 'persisted_materialization_identity';

/**
 * Durable per-session account identity resolved from the session's PERSISTED metadata (its
 * materialization identity / connected-service binding), independent of the in-memory runtime
 * identity index that every daemon restart wipes. Used as the same-account fanout fallback proof
 * for the `provider_account_id` strategy (codex) when a live runtime probe cannot verify identity.
 */
export type PersistedSessionAccountIdentity = Readonly<{
  providerAccountId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  profileId: string;
  groupGeneration: number | null;
}>;

export type PersistedSessionAccountIdentityReader = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  expectedGroupGeneration: number | null;
}>) => Promise<PersistedSessionAccountIdentity | null>;

export type RuntimeAccountIdentityRecordInput = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  profileId: string;
  providerAccountId: string;
  accountLabel: string | null;
  observedAtMs: number;
  source: RuntimeAccountIdentitySource;
  proofStrength: RuntimeAccountIdentityProofStrength;
  groupGeneration: number | null;
}>;

export type RuntimeAccountIdentityEntry = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  profileId: string;
  providerAccountId: string;
  accountLabel: string | null;
  observedAtMs: number;
  source: RuntimeAccountIdentitySource;
  proofStrength: 'exact';
  groupGeneration: number | null;
}>;

export type RuntimeAccountIdentityRecordResult =
  | Readonly<{ status: 'recorded' }>
  | Readonly<{
      status: 'suppressed';
      reason:
        | 'exact_provider_account_proof_required'
        | 'missing_session_id'
        | 'missing_profile_id'
        | 'missing_provider_account_id'
        | 'missing_group_generation'
        | 'invalid_observed_at';
    }>;

export type RuntimeAccountIdentityFanoutProbeResult =
  | Readonly<{
      status: 'exact';
      strategy?: 'provider_account_id' | 'shared_group_auth_surface';
      providerAccountId?: string | null;
      sharedAuthSurfaceId?: string | null;
      accountLabel?: string | null;
      profileId?: string | null;
      groupId?: string | null;
      groupGeneration?: number | null;
      observedAtMs?: number | null;
      inProviderTurn?: boolean | null;
      safeToApply?: boolean | null;
    }>
  | Readonly<{
      status: 'missing' | 'unavailable' | 'inexact' | 'failed' | 'generation_mismatch';
      reason?: string;
    }>;

export type RuntimeAccountIdentityFanoutReader = (
  input: Readonly<{
    sessionId: string;
    agentId?: string | null;
    serviceId: ConnectedServiceId;
    groupId: string;
    expectedProfileId: string;
    expectedGroupGeneration: number | null;
    reason: 'same_provider_account_exhausted';
  }>,
) => RuntimeAccountIdentityFanoutProbeResult | Promise<RuntimeAccountIdentityFanoutProbeResult>;
