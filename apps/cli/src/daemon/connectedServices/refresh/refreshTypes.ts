import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceCredentialRevisionBoundaryV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServicesMaterializationDiagnostic } from '../materialize/providerMaterializerTypes';
import type { ConnectedServiceRuntimeRefreshTarget } from '../runtimeRegistry/registry';
import type {
  ConnectedServiceRefreshFailureCategory,
  ConnectedServiceRefreshReason,
} from '@/daemon/connectedServices/credentials/lifecycleTypes';

export type BoundProfile = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;

export type ConnectedServiceCredentialSource =
  | (Readonly<{ mode: 'plain'; record: ConnectedServiceCredentialRecordV1 }> & ConnectedServiceCredentialRevisionBoundaryV1)
  | (Readonly<{
    mode: 'sealed';
    record: ConnectedServiceCredentialRecordV1;
    metadata: { kind: 'oauth' | 'token'; expiresAt?: number | null };
  }> & ConnectedServiceCredentialRevisionBoundaryV1);

export type ConnectedServiceCredentialRefreshStatus =
  | 'refreshed'
  | 'not_needed'
  | 'not_oauth'
  | 'lease_not_acquired'
  | 'credential_missing'
  | 'blocked_by_credential_health'
  | 'refresh_failed';

export type ConnectedServiceCredentialRefreshDiagnostic = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  reason: ConnectedServiceRefreshReason;
  status: ConnectedServiceCredentialRefreshStatus;
  category?: ConnectedServiceRefreshFailureCategory;
  providerStatus?: number | null;
  providerErrorCode?: string | null;
  expiresAt?: number | null;
  expiryAgeMs?: number | null;
  refreshWindowMs: number;
}>;

export type ConnectedServiceCredentialRefreshResult = Readonly<{
  status: ConnectedServiceCredentialRefreshStatus;
  credential: ConnectedServiceCredentialRecordV1 | null;
  diagnostic: ConnectedServiceCredentialRefreshDiagnostic;
  credentialRevision?: string;
  /** Metadata attestation changes revision without proving auth or quota recovery. */
  mutationKind?: 'provider_context';
}>;

export type ConnectedServiceRuntimeAuthCredentialRefreshResult =
  ConnectedServiceCredentialRefreshResult & Readonly<{
    /**
     * The requested member credential rotated successfully, but the affected runtime now belongs
     * to a different authoritative group member. Runtime recovery must consume that group truth
     * instead of declaring the obsolete member refresh sufficient or falsely reporting it failed.
     */
    runtimeAuthDisposition?: 'superseded_by_current_group';
  }>;

/**
 * Outcome of a quota-probe credential refresh. `reauthRequired` is the refresh coordinator's
 * canonical verdict that the credential cannot be recovered by retrying (permanent provider auth
 * failure, or the profile is already latched needs_reauth); quota consumers must respect it
 * instead of re-deriving their own health classification.
 */
export type ConnectedServiceQuotaCredentialRefreshOutcome = Readonly<{
  record: ConnectedServiceCredentialRecordV1 | null;
  reauthRequired: boolean;
  credentialRevision?: string;
}>;

export type ConnectedServiceCredentialHealthNotificationStatus =
  | 'reconnect_required'
  | 'refresh_failed_retryable';

export type ConnectedServiceCredentialHealthNotificationTarget = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
  sessionId: string;
}>;

export type SpawnTarget = ConnectedServiceRuntimeRefreshTarget;

export type RematerializedTargetFailure = Readonly<{
  target: SpawnTarget;
  binding: BoundProfile;
  diagnostic: ConnectedServicesMaterializationDiagnostic;
}>;

export type RematerializedTargetsResult = Readonly<{
  affectedTargets: ReadonlyArray<SpawnTarget>;
  rematerializedTargets: ReadonlyArray<SpawnTarget>;
  failedTargets: ReadonlyArray<RematerializedTargetFailure>;
}>;
