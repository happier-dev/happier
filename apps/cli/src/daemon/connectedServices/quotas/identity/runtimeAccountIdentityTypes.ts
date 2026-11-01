import { z } from 'zod';
import {
  type ConnectedServiceCredentialRevisionV1,
  ConnectedServiceIdSchema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import { lazySchema } from '@happier-dev/protocol';

export type RuntimeAccountIdentityProofStrength = 'exact' | 'weak';

export type RuntimeAccountIdentityStrategy =
  | 'provider_account_id'
  | 'shared_group_auth_surface';

export type RuntimeAccountIdentitySource =
  | 'runtime_quota_snapshot'
  | 'active_account_verification'
  | 'spawn_selection'
  | 'group_switch_selection'
  | 'codex_live_auth_apply'
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

export type RuntimeAccountIdentitySelectionInput = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId?: string | null;
  groupGeneration?: number | null;
  record: ConnectedServiceCredentialRecordV1;
  source: Extract<
    RuntimeAccountIdentitySource,
    'spawn_selection' | 'group_switch_selection' | 'codex_live_auth_apply'
  >;
}>;

export const RuntimeAccountIdentitySelectionFactV1Schema = lazySchema(() => z.object({
  serviceId: ConnectedServiceIdSchema,
  profileId: z.string().trim().min(1),
  groupId: z.string().trim().min(1).nullable(),
  groupGeneration: z.number().int().nonnegative().nullable(),
  providerAccountId: z.string().trim().min(1),
  accountLabel: z.string().trim().min(1).nullable(),
  source: z.enum(['spawn_selection', 'group_switch_selection', 'codex_live_auth_apply']),
}).strict());

/** Durable exact account identity without the credential/token material used to derive it. */
export type RuntimeAccountIdentitySelectionFactV1 = z.infer<
  typeof RuntimeAccountIdentitySelectionFactV1Schema
>;

export type RuntimeAccountIdentitySelection =
  | RuntimeAccountIdentitySelectionInput
  | RuntimeAccountIdentitySelectionFactV1;

export function buildRuntimeAccountIdentitySelectionFactV1(
  selection: RuntimeAccountIdentitySelectionInput,
): RuntimeAccountIdentitySelectionFactV1 | null {
  const providerAccountId = selection.record.kind === 'oauth'
    ? selection.record.oauth.providerAccountId?.trim() ?? ''
    : selection.record.token.providerAccountId?.trim() ?? '';
  if (!providerAccountId) return null;
  const accountLabel = selection.record.kind === 'oauth'
    ? selection.record.oauth.providerEmail?.trim() || null
    : selection.record.token.providerEmail?.trim() || null;
  return RuntimeAccountIdentitySelectionFactV1Schema.parse({
    serviceId: selection.serviceId,
    profileId: selection.profileId,
    groupId: selection.groupId ?? null,
    groupGeneration: selection.groupGeneration ?? null,
    providerAccountId,
    accountLabel,
    source: selection.source,
  });
}

export type RuntimeAccountIdentityProbeResult =
  | Readonly<{
      status: 'verified';
      strategy?: RuntimeAccountIdentityStrategy;
      providerAccountId?: string | null;
      sharedAuthSurfaceId?: string | null;
      accountLabel?: string | null;
      proofStrength?: 'exact' | 'weak';
      source?: RuntimeAccountIdentitySource;
      profileId?: string | null;
      groupId?: string | null;
      groupGeneration?: number | null;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
      runtime?: Readonly<{
        safeToApply?: boolean;
        inProviderTurn?: boolean;
      }>;
    }>
  | Readonly<{
      status: 'inexact' | 'unavailable';
      reason?: string;
      accountLabel?: string | null;
      runtime?: Readonly<{
        safeToApply?: boolean;
        inProviderTurn?: boolean;
      }>;
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

export type RuntimeSharedGroupAuthSurfaceProof = Readonly<{
  proofStrategy: 'shared_group_auth_surface';
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  accountLabel: string | null;
  observedAtMs: number;
  source: Extract<RuntimeAccountIdentitySource, 'group_switch_selection' | 'runtime_identity_probe'>;
  proofStrength: 'exact';
  groupGeneration: number | null;
}>;

export type RuntimeAccountFanoutProof =
  | RuntimeAccountIdentityEntry
  | RuntimeSharedGroupAuthSurfaceProof;

export type ReconciledRuntimeAccountIdentityEntry = RuntimeAccountFanoutProof & Readonly<{
  runtime?: Readonly<{
    safeToApply?: boolean;
    inProviderTurn?: boolean;
  }>;
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
