import type { ConnectedServiceCredentialRecordV1, ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';

export type CodexLoginStartClient = Readonly<{
  request: (method: string, params?: unknown) => Promise<unknown>;
}>;

export type CodexConnectedServiceRefreshSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: 'openai-codex';
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: 'openai-codex';
      groupId: string;
      activeProfileId: string;
      fallbackProfileId?: string | null;
      generation: number;
    }>;

export type CodexConnectedServiceRuntimeIdentitySeed = Readonly<{
  serviceId: 'openai-codex';
  activeAccountId: string;
  accountLabel: string | null;
  profileId: string;
  groupId?: string;
  generation?: string | number;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  credentialFingerprint: string | null;
  source: 'spawn_selection' | 'group_switch_selection' | 'applied_credential';
}>;

export type CodexRefreshSelectionRollback = () => Promise<void> | void;

export type CodexHotApplyEligibility =
  | Readonly<{ eligible: true }>
  | Readonly<{
      eligible: false;
      reason: 'direct_live_hot_auth_ineligible';
      detailReason: 'auth_family_mismatch' | 'credential_family_mismatch';
    }>
  | Readonly<{
      eligible: false;
      reason: 'forced_workspace_incompatible';
    }>;

export type CodexDirectLiveAuthApplyDetailReason =
  | 'auth_family_mismatch'
  | 'credential_family_mismatch'
  | 'provider_account_identity_unavailable';

export type CodexDirectLiveAuthApplyFailureReason =
  | 'direct_live_hot_auth_ineligible'
  | 'forced_workspace_incompatible'
  | 'refresh_selection_resync_failed'
  | 'experimental_api_unavailable'
  | 'live_hot_auth_failed';

export type CodexDirectLiveAuthApplyResult =
  | Readonly<{
      applied: true;
      appliedVia: 'direct_live_hot_auth';
      activeAccountId: string;
      durability:
        | Readonly<{ persisted: true }>
        | Readonly<{
            persisted: false;
            errorCode:
              | 'auth_store_persistence_unavailable_after_live_apply'
              | 'auth_store_persistence_failed_after_live_apply';
          }>;
    }>
  | Readonly<{
      applied: false;
      reason: CodexDirectLiveAuthApplyFailureReason;
      detailReason?: CodexDirectLiveAuthApplyDetailReason;
      appliedVia?: 'direct_live_hot_auth';
      activeAccountId?: string;
    }>;

export type CodexDirectLiveAuthApplyInput = Readonly<{
  client: CodexLoginStartClient;
  candidate: ConnectedServiceCredentialRecordV1;
  forcedWorkspaceId: string | null;
  forcedLoginMethod?: string | null;
  persistAuthStore?: (() => Promise<void> | void) | null;
  refreshSelection?: CodexConnectedServiceRefreshSelection | null;
  updateRefreshSelection?: ((
    selection: CodexConnectedServiceRefreshSelection,
  ) => Promise<CodexRefreshSelectionRollback | void> | CodexRefreshSelectionRollback | void) | null;
}>;
