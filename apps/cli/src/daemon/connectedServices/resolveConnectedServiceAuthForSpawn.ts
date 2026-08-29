import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  buildQualifiedPluginContributionKey,
  isQualifiedConnectedAccountProfileActiveV4,
  parseQualifiedPluginContributionKey,
  type AccountSettings,
  type BuiltInLegacyConnectedAccountCompatibility,
  type ConnectedAccountServiceKey,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceId,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountServiceRef,
  type QualifiedConnectedAccountPurposeBindingV1,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { ApiClient } from '@/api/api';
import {
  listQualifiedConnectedAccountsV4,
  readQualifiedConnectedAccountGroupV4,
  resolveQualifiedConnectedAccountOperationTransport,
  resolveQualifiedConnectedAccountPeerClass,
} from '@/api/client/qualifiedConnectedAccountApi';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type {
  SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import type { StoredCredentials } from '@/persistence';

import {
  parseConnectedServiceBindingSelections,
  type ConnectedServiceBindingSelection,
  type ConnectedServicesBindingsV1,
} from './parseConnectedServicesBindings';
import {
  resolveConnectedServiceCredentialResolutions,
  type ConnectedServiceCredentialResolution,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
  ConnectedServiceMaterializationBlockedError,
  materializeConnectedServicesForSpawn,
} from './materialize/materializeConnectedServicesForSpawn';
import { isExactV021GeminiOauthLaunchProjection } from './compatibility/exactV021ConnectedServiceMaterialization';
import { resolveConnectedServiceTargetMaterializedRoot } from './materialize/resolveConnectedServiceTargetMaterializedRoot';
import { verifySpawnResumeReachability } from './verifySpawnResumeReachability';
import type {
  ConnectedServiceResolvedSelection,
  ConnectedServicesMaterializationAuthority,
  ConnectedServicesMaterialization,
  ConnectedServicesMaterializationDiagnostic,
} from './materialization/materializer';
import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from './accountGroups/selection/resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import {
  buildQualifiedConnectedAccountAuthGroupSwitchState,
} from './accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
  buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
  type AccountUsageStoreForAuthGroupSwitchState,
} from './accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import type {
  ConnectedServiceAuthGroupMemberRuntimeStateOverride,
  ConnectedServiceAuthGroupSwitchState,
} from './accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
type ConnectedServiceAuthGroupMemberRuntimeState =
  ConnectedServiceAuthGroupSwitchState['memberStatesByProfileId'] extends ReadonlyMap<string, infer T>
    ? T
    : never;
import { ConnectedServiceAuthGroupQuotaProbeIncompleteError } from './accountGroups/quotas/preTurnQuotaProbe';
import {
  persistConnectedServiceCredentialHealthForMaterializationFailure,
  type ConnectedServiceCredentialRefreshResult,
} from './refresh/ConnectedServiceRefreshCoordinator';
import type {
  ConnectedServicePredictiveSwitchGuardInput,
  ConnectedServicePredictiveSwitchGuardResult,
} from './accountGroups/switching/connectedServicePredictiveSwitchGuard';
import {
  resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey,
  resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import {
  resolveQualifiedRequestAuthPurposeBindingsFromSnapshot,
  type AgentSpawnQualifiedPurposeBindingSnapshot,
} from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
  assertQualifiedPurposeAuthorityForSelections,
  ConnectedServiceQualifiedPurposeAuthorityError,
} from './requestAuth/qualifiedPurposeAuthority';

export { ConnectedServiceQualifiedPurposeAuthorityError } from './requestAuth/qualifiedPurposeAuthority';
export type ConnectedServiceQualifiedAuthGroupApi = Readonly<{
  readGroup: (params: Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    groupId: string;
    signal?: AbortSignal;
  }>) => Promise<QualifiedConnectedAccountGroupV4 | null>;
  listAccounts: (params: Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    accounts: readonly QualifiedConnectedAccountProfileV4[];
  }>>;
}>;

type ConnectedServiceProfileStatus =
  | 'connected'
  | 'refreshing'
  | 'needs_reauth'
  | 'refresh_failed_retryable';

type ConnectedServiceProfileProjection = Readonly<{
  status: ConnectedServiceProfileStatus;
  kind?: ConnectedServiceCredentialRecordV1['kind'] | null;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
}>;

type ConnectedServiceProfilesHealthApi = Readonly<{
  listConnectedServiceProfiles?: (params: Readonly<{
    serviceId: ConnectedServiceId;
  }>) => Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<Readonly<{
      profileId: string;
      status: ConnectedServiceProfileStatus;
      kind?: ConnectedServiceCredentialRecordV1['kind'] | null;
    }>>;
  }>>;
}>;

type ConnectedServiceAuthGroupPreTurnSwitchCoordinator = Readonly<{
  switchBeforeTurn(params: Readonly<{
    sessionId?: string;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    observedProfileId?: string | null;
    memberStateOverridesByProfileId?: ReadonlyArray<ConnectedServiceAuthGroupMemberRuntimeStateOverride>;
  }>): Promise<Readonly<{
    status: string;
    activeProfileId?: string | null;
    generation?: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  }>>;
  switchAfterClassifiedFailure?(params: Readonly<{
    sessionId?: string;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    reason: 'refresh_failed';
    observedProfileId?: string | null;
  }>): Promise<Readonly<{
    status: string;
    activeProfileId?: string | null;
    generation?: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  }>>;
}>;

type ConnectedServiceSpawnCredentialRefreshErrorKind =
  | 'reconnect_required'
  | 'transient_refresh_failed';

type ConnectedServiceSpawnCredentialRefreshService = Readonly<{
  refreshConnectedServiceCredentialForSpawnPreflight(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<ConnectedServiceCredentialRefreshResult>;
}>;

type ConnectedServicePredictiveSwitchGuard = (
  input: ConnectedServicePredictiveSwitchGuardInput,
) => ConnectedServicePredictiveSwitchGuardResult | Promise<ConnectedServicePredictiveSwitchGuardResult>;

const CONNECTED_SERVICE_PROFILE_REAUTH_BLOCK_UNTIL_MS = Number.MAX_SAFE_INTEGER;

export class ConnectedServiceSpawnCredentialRefreshError extends Error {
  readonly kind: ConnectedServiceSpawnCredentialRefreshErrorKind;
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;
  readonly diagnostic: ConnectedServiceCredentialRefreshResult['diagnostic'];

  constructor(params: Readonly<{
    kind: ConnectedServiceSpawnCredentialRefreshErrorKind;
    diagnostic: ConnectedServiceCredentialRefreshResult['diagnostic'];
  }>) {
    super(
      params.kind === 'reconnect_required'
        ? `Connected service credential needs reconnect (${params.diagnostic.serviceId}/${params.diagnostic.profileId})`
        : `Connected service credential refresh failed transiently (${params.diagnostic.serviceId}/${params.diagnostic.profileId})`,
    );
    this.name = 'ConnectedServiceSpawnCredentialRefreshError';
    this.kind = params.kind;
    this.serviceId = params.diagnostic.serviceId;
    this.profileId = params.diagnostic.profileId;
    this.diagnostic = params.diagnostic;
  }
}

export class ConnectedServiceSpawnProfileActionRequiredError extends Error {
  readonly kind = 'profile_action_required' as const;
  readonly action = 'reconnect_connected_service_profile' as const;
  readonly serviceId: ConnectedAccountServiceKey;
  readonly profileId: string;
  readonly status: ConnectedServiceProfileStatus;

  constructor(params: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    profileId: string;
    status: ConnectedServiceProfileStatus;
  }>) {
    super(`Connected service profile requires action (${params.serviceId}/${params.profileId})`);
    this.name = 'ConnectedServiceSpawnProfileActionRequiredError';
    this.serviceId = params.serviceId;
    this.profileId = params.profileId;
    this.status = params.status;
  }
}

export class ConnectedServiceRequestAuthCredentialRevisionRequiredError extends Error {
  readonly kind = 'request_auth_credential_revision_required' as const;
  readonly serviceId: ConnectedAccountServiceKey;

  constructor(serviceId: ConnectedAccountServiceKey) {
    super(`Connected Account request auth requires a revisioned credential (${serviceId})`);
    this.name = 'ConnectedServiceRequestAuthCredentialRevisionRequiredError';
    this.serviceId = serviceId;
  }
}

export class ConnectedServiceLegacyUnfencedAuthorityError extends Error {
  readonly code = 'connected_service_legacy_unfenced_authority_unsupported' as const;
  readonly operation: 'group' | 'request_auth' | 'materialization';

  constructor(operation: ConnectedServiceLegacyUnfencedAuthorityError['operation']) {
    super(
      `Legacy unfenced connected service credentials do not support ${operation}`,
    );
    this.name = 'ConnectedServiceLegacyUnfencedAuthorityError';
    this.operation = operation;
  }
}

function supportsLegacyUnfencedOneShotMaterialization(
  agentId: CatalogAgentId,
  resolutions: ReadonlyMap<
    ConnectedServiceId,
    ConnectedServiceCredentialResolution
  >,
  snapshot: CliServerFeaturesSnapshot | undefined,
  serverContract:
    SessionSyncPendingInputServerContractResult | null | undefined,
): boolean {
  return [...resolutions.values()].every((resolution) => {
    if (resolution.revisionSemantics !== 'legacy_unfenced') return true;
    const compatibility =
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
        resolution.record.serviceId as keyof
          typeof BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID
      ] as BuiltInLegacyConnectedAccountCompatibility | undefined;
    if (!compatibility) {
      return false;
    }
    const projectionOnlyGeminiOauth =
      isExactV021GeminiOauthLaunchProjection({
        agentId,
        record: resolution.record,
      });
    if (
      compatibility.authenticationModeByCredentialKind[
        resolution.record.kind
      ] === undefined
      && !projectionOnlyGeminiOauth
    ) return false;
    const authenticationModeCardinality =
      projectionOnlyGeminiOauth
        ? 'single' as const
        : (
            new Set(
              Object.values(
                compatibility.authenticationModeByCredentialKind,
              ),
            ).size > 1
              ? 'multiple' as const
              : 'single' as const
          );
    try {
      const transport =
        resolveQualifiedConnectedAccountOperationTransport({
          snapshot,
          serverContract,
          service: compatibility.service,
          operation: {
            kind: 'one_shot_materialization',
            configurationState: 'unconfigured',
            authenticationModeCardinality,
          },
        });
      return transport.kind === 'legacy'
        && transport.peerClass === 'exact_v0_2_1'
        && transport.serviceId === resolution.record.serviceId;
    } catch {
      return false;
    }
  });
}

export class ConnectedServiceAuthGroupSwitchCoordinatorUnavailableError extends Error {
  readonly kind = 'switch_coordinator_unavailable' as const;
  readonly serviceId: ConnectedAccountServiceKey;
  readonly groupId: string;
  readonly activeProfileId: string | null;
  readonly selectedProfileId: string;
  readonly reason: 'usage_limit' | 'soft_threshold' | 'auth_expired';

  constructor(params: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    activeProfileId: string | null;
    selectedProfileId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'auth_expired';
  }>) {
    super(`Connected service auth group switch coordinator unavailable (${params.serviceId}/${params.groupId})`);
    this.name = 'ConnectedServiceAuthGroupSwitchCoordinatorUnavailableError';
    this.serviceId = params.serviceId;
    this.groupId = params.groupId;
    this.activeProfileId = params.activeProfileId;
    this.selectedProfileId = params.selectedProfileId;
    this.reason = params.reason;
  }
}

/**
 * Thrown by the spawn-path post-materialization resume reachability RE-VERIFY gate (K1 §2) when the
 * resumed session is genuinely unreachable in the REAL materialized target the vendor will read.
 *
 * This is the load-bearing fail-closed: rather than returning a materialized env the vendor would
 * crash resuming ("Pi process exited" by a different door, after the daemon already respawned), the
 * spawn fails BEFORE the vendor launches with a concrete structured reason. `errorCode` reuses the
 * shared continuity vocabulary (`provider_session_state_unavailable_for_resume`) and `failurePhase`
 * is `continuity`, matching the switch-FSM taxonomy so callers/observability can treat both doors
 * identically. No provider knowledge lives here — `agentId` is a typed value.
 */
export class ConnectedServiceSpawnResumeUnreachableError extends Error {
  readonly errorCode = 'provider_session_state_unavailable_for_resume' as const;
  readonly failurePhase = 'continuity' as const;
  readonly agentId: CatalogAgentId;
  readonly vendorResumeId: string;
  readonly cwd: string;
  readonly targetMaterializedRoot: string | null;
  readonly reason: string;

  constructor(params: Readonly<{
    agentId: CatalogAgentId;
    vendorResumeId: string;
    cwd: string;
    targetMaterializedRoot: string | null;
    reason: string;
  }>) {
    super(
      `Connected service resume state unreachable for ${params.agentId} resume '${params.vendorResumeId}' (reason ${params.reason})`,
    );
    this.name = 'ConnectedServiceSpawnResumeUnreachableError';
    this.agentId = params.agentId;
    this.vendorResumeId = params.vendorResumeId;
    this.cwd = params.cwd;
    this.targetMaterializedRoot = params.targetMaterializedRoot;
    this.reason = params.reason;
  }
}

function readProfileId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

type ConnectedServiceSpawnSwitchAuthority =
  | Readonly<{
      kind: 'authoritative';
      activeProfileId: string;
      generation: number;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    }>
  | Readonly<{ kind: 'none' }>;

function readConnectedServiceSpawnSwitchAuthority(
  result: Awaited<ReturnType<ConnectedServiceAuthGroupPreTurnSwitchCoordinator['switchBeforeTurn']>>,
): ConnectedServiceSpawnSwitchAuthority {
  if (
    result.status !== 'switched'
    && result.status !== 'observed_generation'
    && result.status !== 'superseded_after_apply'
    && result.status !== 'generation_apply_failed'
    && result.status !== 'predictive_apply_unavailable'
  ) {
    return { kind: 'none' };
  }
  if (!Number.isInteger(result.generation) || (result.generation as number) < 0) {
    return { kind: 'none' };
  }
  const activeProfileId = readProfileId(result.activeProfileId);
  if (!activeProfileId) return { kind: 'none' };
  return {
    kind: 'authoritative',
    activeProfileId,
    generation: result.generation as number,
    ...(result.credentialRevision === undefined
      ? {}
      : { credentialRevision: result.credentialRevision }),
  };
}

export class ConnectedServiceSpawnAuthGroupAuthorityError extends Error {
  readonly kind: 'resolution_unavailable' | 'resolution_failed' | 'group_missing' | 'active_profile_missing';
  readonly serviceId: ConnectedAccountServiceKey;
  readonly groupId: string;

  constructor(params: Readonly<{
    kind: ConnectedServiceSpawnAuthGroupAuthorityError['kind'];
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    cause?: unknown;
  }>) {
    super(`Connected service auth group authority ${params.kind} (${params.serviceId}/${params.groupId})`);
    this.name = 'ConnectedServiceSpawnAuthGroupAuthorityError';
    this.kind = params.kind;
    this.serviceId = params.serviceId;
    this.groupId = params.groupId;
    if (params.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = params.cause;
    }
  }
}

type ConnectedServiceSpawnQualifiedGroupState = ConnectedServiceAuthGroupSwitchState<QualifiedConnectedAccountServiceRef>;

async function resolveGroupAfterSpawnSwitchResult(params: Readonly<{
  group: ConnectedServiceSpawnQualifiedGroupState;
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  result: Awaited<ReturnType<ConnectedServiceAuthGroupPreTurnSwitchCoordinator['switchBeforeTurn']>>;
}>): Promise<ConnectedServiceSpawnQualifiedGroupState | null> {
  const authority = readConnectedServiceSpawnSwitchAuthority(params.result);
  if (authority.kind === 'none') return null;
  if (authority.kind === 'authoritative') {
    return {
      ...params.group,
      activeProfileId: authority.activeProfileId,
      generation: authority.generation,
      ...(authority.credentialRevision === undefined
        ? {}
        : { credentialRevision: authority.credentialRevision }),
    };
  }
  throw new ConnectedServiceSpawnAuthGroupAuthorityError({
    kind: 'resolution_unavailable',
    serviceId: params.serviceId,
    groupId: params.groupId,
  });
}

async function resolveProfileStatusByProfileId(params: Readonly<{
  api: ApiClient;
  serviceId: ConnectedServiceId;
}>): Promise<ReadonlyMap<string, ConnectedServiceProfileProjection> | null> {
  const api = params.api as ConnectedServiceProfilesHealthApi;
  if (typeof api.listConnectedServiceProfiles !== 'function') return null;
  const result = await api.listConnectedServiceProfiles({ serviceId: params.serviceId });
  return new Map(result.profiles.map((profile) => [
    profile.profileId,
    {
      status: profile.status,
      ...(profile.kind === undefined ? {} : { kind: profile.kind }),
    },
  ]));
}

function isUnsupportedLegacyCredentialProjection(params: Readonly<{
  serviceId: ConnectedServiceId;
  profile: ConnectedServiceProfileProjection;
}>): boolean {
  if (!params.profile.kind) return false;
  const compatibility: BuiltInLegacyConnectedAccountCompatibility =
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
      params.serviceId
    ];
  return Boolean(
    compatibility.unsupportedAuthenticationModeByCredentialKind[
      params.profile.kind
    ],
  );
}

function throwIfProfileRequiresAction(params: Readonly<{
  serviceId: ConnectedAccountServiceKey;
  legacyServiceId: ConnectedServiceId;
  profileId: string;
  profileStatusByProfileId: ReadonlyMap<string, ConnectedServiceProfileProjection> | null;
}>): void {
  const profile = params.profileStatusByProfileId?.get(params.profileId) ?? null;
  if (profile?.status !== 'needs_reauth') return;
  if (isUnsupportedLegacyCredentialProjection({
    serviceId: params.legacyServiceId,
    profile,
  })) {
    return;
  }
  throw new ConnectedServiceSpawnProfileActionRequiredError({
    serviceId: params.serviceId,
    profileId: params.profileId,
    status: profile.status,
  });
}

function isReconnectRequiredRefreshCategory(category: ConnectedServiceCredentialRefreshResult['diagnostic']['category'] | undefined): boolean {
  return category === 'invalid_grant'
    || category === 'invalid_client'
    || category === 'provider_401'
    || category === 'provider_403'
    || category === 'missing_refresh_token';
}

function shouldPreflightRefreshCredential(record: ConnectedServiceCredentialRecordV1): boolean {
  return record.kind === 'oauth'
    && typeof record.expiresAt === 'number'
    && Number.isFinite(record.expiresAt);
}

async function applySpawnPreflightRefresh(params: Readonly<{
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialBindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
  refreshService: ConnectedServiceSpawnCredentialRefreshService | null;
}>): Promise<void> {
  if (!params.refreshService) return;

  for (const binding of params.credentialBindings) {
    const record = params.recordsByServiceId.get(binding.serviceId);
    if (!record || !shouldPreflightRefreshCredential(record)) continue;

    const result = await params.refreshService.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
    });
    if (result.status === 'refreshed' && result.credential) {
      params.recordsByServiceId.set(binding.serviceId, result.credential);
      continue;
    }
    if (result.status === 'refresh_failed') {
      throw new ConnectedServiceSpawnCredentialRefreshError({
        kind: isReconnectRequiredRefreshCategory(result.diagnostic.category)
          ? 'reconnect_required'
          : 'transient_refresh_failed',
        diagnostic: result.diagnostic,
      });
    }
    if (result.status === 'credential_missing' || result.status === 'lease_not_acquired') {
      throw new ConnectedServiceSpawnCredentialRefreshError({
        kind: result.status === 'credential_missing' ? 'reconnect_required' : 'transient_refresh_failed',
        diagnostic: result.diagnostic,
      });
    }
  }
}

function resolveActiveGroupProfileIssueReason(
  state: Pick<
    ConnectedServiceAuthGroupSwitchState<unknown>,
    'activeProfileId' | 'memberStatesByProfileId'
  >,
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>,
  nowMs: number,
): 'usage_limit' | 'soft_threshold' | 'auth_expired' {
  const activeState = state.activeProfileId
    ? memberStatesByProfileId.get(state.activeProfileId) ?? null
    : null;
  const activeRemaining = activeState?.quotaSnapshot?.effectiveRemainingPercent;
  const activeAuthInvalid =
    typeof activeState?.authInvalidUntilMs === 'number'
    && activeState.authInvalidUntilMs > nowMs;
  const activeExhausted =
    activeState?.quotaSnapshot?.exhausted === true
    || (typeof activeRemaining === 'number' && Number.isFinite(activeRemaining) && activeRemaining <= 0)
    || (typeof activeState?.quotaExhaustedUntilMs === 'number' && activeState.quotaExhaustedUntilMs > nowMs)
    || (typeof activeState?.rateLimitedUntilMs === 'number' && activeState.rateLimitedUntilMs > nowMs);
  return activeAuthInvalid ? 'auth_expired' : activeExhausted ? 'usage_limit' : 'soft_threshold';
}

function buildSpawnSwitchState(params: Readonly<{
  group: QualifiedConnectedAccountGroupV4;
  state: ConnectedServiceSpawnQualifiedGroupState;
  serviceId: ConnectedAccountServiceKey;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
}>): ConnectedServiceSpawnQualifiedGroupState {
  if (!params.accountUsageStore) return params.state;
  const usageState = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
    group: {
      serviceId: params.serviceId,
      groupId: params.group.ref.groupId,
      activeProfileId: params.state.activeProfileId,
      generation: params.state.generation,
      policy: params.state.policy,
      members: params.group.members.map((member) => ({
        profileId: member.connectedAccountId,
        priority: member.priority,
        enabled: member.enabled,
        state: member.state,
        createdAt: member.createdAt,
      })),
    },
    accountUsageStore: params.accountUsageStore,
  })?.state;
  return usageState
    ? { ...params.state, memberStatesByProfileId: usageState.memberStatesByProfileId }
    : params.state;
}

async function maybeSelectGroupActiveProfileForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  group: QualifiedConnectedAccountGroupV4;
  state: ConnectedServiceSpawnQualifiedGroupState;
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  profileStatusByProfileId: ReadonlyMap<string, ConnectedServiceProfileProjection> | null;
  quotaFreshnessMs: number;
  nowMs: number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  predictiveSwitchGuard?: ConnectedServicePredictiveSwitchGuard | null;
}>): Promise<ConnectedServiceSpawnQualifiedGroupState> {
  const state = buildSpawnSwitchState({
    group: params.group,
    state: params.state,
    serviceId: params.serviceId,
    accountUsageStore: params.accountUsageStore,
  });
  if (!state.policy.autoSwitch) return state;
  const memberStatesByProfileId = new Map(state.memberStatesByProfileId);
  const memberStateOverridesByProfileId: ConnectedServiceAuthGroupMemberRuntimeStateOverride[] = [];
  for (const member of state.members) {
    const status =
      params.profileStatusByProfileId?.get(member.profileId)?.status ?? null;
    if (status !== 'needs_reauth') continue;
    const existingState = memberStatesByProfileId.get(member.profileId) ?? {};
    const nextState = {
      ...existingState,
      authInvalidUntilMs: CONNECTED_SERVICE_PROFILE_REAUTH_BLOCK_UNTIL_MS,
    };
    memberStatesByProfileId.set(member.profileId, nextState);
    memberStateOverridesByProfileId.push({
      profileId: member.profileId,
      state: nextState,
    });
  }

  const activeIssueReason = resolveActiveGroupProfileIssueReason(state, memberStatesByProfileId, params.nowMs);
  if (activeIssueReason === 'soft_threshold' && !params.accountUsageStore) return state;
  const currentActiveProfileId = readProfileId(state.activeProfileId);
  if (params.sessionId && params.predictiveSwitchGuard && currentActiveProfileId) {
    const guardResult = await params.predictiveSwitchGuard({
      sessionId: params.sessionId,
      serviceId: params.serviceId,
      groupId: params.groupId,
      activeProfileId: currentActiveProfileId,
      agentId: params.agentId,
      reason: activeIssueReason,
    });
    if (guardResult.status === 'suppress') return state;
  }
  const needsPreTurnProbe = resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
    activeProfileId: state.activeProfileId,
    members: state.members,
    memberStatesByProfileId,
    policy: state.policy,
    nowMs: params.nowMs,
    quotaFreshnessMs: params.quotaFreshnessMs,
    allowCurrentProfileRetry: true,
  }).length > 0;
  const activeRemaining = memberStatesByProfileId.get(currentActiveProfileId)?.quotaSnapshot?.effectiveRemainingPercent;
  const activeBelowSoftThreshold =
    typeof activeRemaining === 'number'
    && Number.isFinite(activeRemaining)
    && activeRemaining <= state.policy.softSwitchRemainingPercent;
  if (!needsPreTurnProbe && !activeBelowSoftThreshold && activeIssueReason === 'soft_threshold') return state;

  if (params.authGroupSwitchCoordinator) {
    try {
      const switched = await params.authGroupSwitchCoordinator.switchBeforeTurn({
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        serviceId: params.serviceId,
        groupId: params.groupId,
        reason: activeIssueReason,
        observedProfileId: state.activeProfileId,
        ...(memberStateOverridesByProfileId.length > 0 ? { memberStateOverridesByProfileId } : {}),
      });
      return await resolveGroupAfterSpawnSwitchResult({
        group: state,
        serviceId: params.serviceId,
        groupId: params.groupId,
        result: switched,
      }) ?? state;
    } catch (error) {
      if (
        activeIssueReason === 'soft_threshold'
        && error instanceof ConnectedServiceAuthGroupQuotaProbeIncompleteError
      ) {
        return state;
      }
      throw error;
    }
  }

  const selectedProfileId = state.members.find((member) => member.profileId !== state.activeProfileId)?.profileId ?? null;
  if (!selectedProfileId) return state;
  throw new ConnectedServiceAuthGroupSwitchCoordinatorUnavailableError({
    serviceId: params.serviceId,
    groupId: params.groupId,
    activeProfileId: currentActiveProfileId || null,
    selectedProfileId,
    reason: activeIssueReason,
  });
}

async function resolveCredentialBindings(params: Readonly<{
  agentId: CatalogAgentId;
  api: ApiClient;
  credentials: StoredCredentials;
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  qualifiedConnectedAccountApi?: ConnectedServiceQualifiedAuthGroupApi;
  legacyDirectProfileIngress: boolean;
  quotaFreshnessMs: number;
  nowMs: number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  predictiveSwitchGuard?: ConnectedServicePredictiveSwitchGuard | null;
}>): Promise<Readonly<{
  credentialBindings: ReadonlyArray<{
    serviceId: ConnectedAccountServiceKey;
    profileId: string;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  }>;
  groupSelections: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedGroupSelection>;
}>> {
  const credentialBindings: Array<{
    serviceId: ConnectedAccountServiceKey;
    profileId: string;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  }> = [];
  const groupSelections = new Map<ConnectedAccountServiceKey, ConnectedServiceResolvedGroupSelection>();
  const qualifiedAccountApi = params.qualifiedConnectedAccountApi ?? {
    readGroup: ({ service, groupId, signal }: Readonly<{
      service: QualifiedConnectedAccountServiceRef;
      groupId: string;
      signal?: AbortSignal;
    }>) => readQualifiedConnectedAccountGroupV4({
      token: params.credentials.token,
      group: { service, groupId },
      ...(signal ? { signal } : {}),
    }),
    listAccounts: ({ service, signal }: Readonly<{
      service: QualifiedConnectedAccountServiceRef;
      signal?: AbortSignal;
    }>) => listQualifiedConnectedAccountsV4({
      token: params.credentials.token,
      service,
      ...(signal ? { signal } : {}),
    }),
  } satisfies ConnectedServiceQualifiedAuthGroupApi;

  for (const selection of params.selections) {
    const qualifiedService = parseQualifiedPluginContributionKey(selection.serviceId);
    if (!qualifiedService) {
      throw new ConnectedServiceSpawnAuthGroupAuthorityError({
        kind: 'resolution_unavailable',
        serviceId: selection.serviceId,
        groupId: selection.kind === 'group' ? selection.groupId : '',
      });
    }

    if (selection.kind === 'profile') {
      if (params.legacyDirectProfileIngress) {
        const legacyServiceId =
          resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
            selection.serviceId,
          );
        if (!legacyServiceId) {
          throw new ConnectedServiceSpawnAuthGroupAuthorityError({
            kind: 'resolution_unavailable',
            serviceId: selection.serviceId,
            groupId: '',
          });
        }
        const profileStatusByProfileId = await resolveProfileStatusByProfileId({
          api: params.api,
          serviceId: legacyServiceId,
        });
        throwIfProfileRequiresAction({
          serviceId: selection.serviceId,
          legacyServiceId,
          profileId: selection.profileId,
          profileStatusByProfileId,
        });
        credentialBindings.push({
          serviceId: selection.serviceId,
          profileId: selection.profileId,
        });
        continue;
      }

      const listed = await qualifiedAccountApi.listAccounts({
        service: qualifiedService,
      });
      if (
        listed.service.pluginId !== qualifiedService.pluginId
        || listed.service.localId !== qualifiedService.localId
      ) {
        throw new ConnectedServiceSpawnAuthGroupAuthorityError({
          kind: 'resolution_failed',
          serviceId: selection.serviceId,
          groupId: '',
        });
      }
      const profile = listed.accounts.find((candidate) => (
        candidate.ref.service.pluginId === qualifiedService.pluginId
        && candidate.ref.service.localId === qualifiedService.localId
        && candidate.ref.accountId === selection.profileId
      ));
      if (!profile) {
        throw new ConnectedServiceSpawnAuthGroupAuthorityError({
          kind: 'active_profile_missing',
          serviceId: selection.serviceId,
          groupId: '',
        });
      }
      if (!isQualifiedConnectedAccountProfileActiveV4(profile, params.nowMs)) {
        if (profile.status === 'needs_reauth') {
          throw new ConnectedServiceSpawnProfileActionRequiredError({
            serviceId: selection.serviceId,
            profileId: selection.profileId,
            status: profile.status,
          });
        }
        throw new ConnectedServiceSpawnAuthGroupAuthorityError({
          kind: 'resolution_failed',
          serviceId: selection.serviceId,
          groupId: '',
        });
      }
      credentialBindings.push({
        serviceId: selection.serviceId,
        profileId: selection.profileId,
        credentialRevision: profile.credentialRevision,
      });
      continue;
    }

    const group = await qualifiedAccountApi.readGroup({
      service: qualifiedService,
      groupId: selection.groupId,
    });
    if (
      !group
      || group.ref.service.pluginId !== qualifiedService.pluginId
      || group.ref.service.localId !== qualifiedService.localId
      || group.ref.groupId !== selection.groupId
    ) {
      throw new ConnectedServiceSpawnAuthGroupAuthorityError({
        kind: group ? 'resolution_failed' : 'group_missing',
        serviceId: selection.serviceId,
        groupId: selection.groupId,
      });
    }
    const listedAccounts = await qualifiedAccountApi.listAccounts({
      service: qualifiedService,
    });
    if (
      listedAccounts.service.pluginId !== qualifiedService.pluginId
      || listedAccounts.service.localId !== qualifiedService.localId
    ) {
      throw new ConnectedServiceSpawnAuthGroupAuthorityError({
        kind: 'resolution_failed',
        serviceId: selection.serviceId,
        groupId: selection.groupId,
      });
    }
    const state = buildQualifiedConnectedAccountAuthGroupSwitchState({
      group,
      profiles: listedAccounts.accounts,
    });
    const profileStatusByProfileId = new Map<string, ConnectedServiceProfileProjection>(
      listedAccounts.accounts.map((profile) => [profile.ref.accountId, {
        status: profile.status,
        ...(profile.kind === undefined || profile.kind === null ? {} : { kind: profile.kind }),
        credentialRevision: profile.credentialRevision,
      }]),
    );

    const selectedGroup = await maybeSelectGroupActiveProfileForSpawn({
      agentId: params.agentId,
      group,
      state,
      serviceId: selection.serviceId,
      groupId: selection.groupId,
      accountUsageStore: params.accountUsageStore,
      profileStatusByProfileId,
      quotaFreshnessMs: params.quotaFreshnessMs,
      nowMs: params.nowMs,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
      predictiveSwitchGuard: params.predictiveSwitchGuard ?? null,
    });
    const activeProfileId = readProfileId(selectedGroup.activeProfileId);
    if (!activeProfileId) {
      throw new ConnectedServiceSpawnAuthGroupAuthorityError({
        kind: 'active_profile_missing',
        serviceId: selection.serviceId,
        groupId: selection.groupId,
      });
    }
    const activeProfile = listedAccounts.accounts.find((profile) => (
      profile.ref.accountId === activeProfileId
      && profile.ref.service.pluginId === qualifiedService.pluginId
      && profile.ref.service.localId === qualifiedService.localId
    ));
    if (!activeProfile || !isQualifiedConnectedAccountProfileActiveV4(activeProfile, params.nowMs)) {
      if (activeProfile?.status === 'needs_reauth') {
        throw new ConnectedServiceSpawnProfileActionRequiredError({
          serviceId: selection.serviceId,
          profileId: activeProfileId,
          status: activeProfile.status,
        });
      }
      throw new ConnectedServiceSpawnAuthGroupAuthorityError({
        kind: 'resolution_failed',
        serviceId: selection.serviceId,
        groupId: selection.groupId,
      });
    }
    credentialBindings.push({
      serviceId: selection.serviceId,
      profileId: activeProfileId,
      credentialRevision:
        selectedGroup.credentialRevision ?? activeProfile.credentialRevision,
    });
    groupSelections.set(selection.serviceId, {
      groupId: selection.groupId,
      activeProfileId,
      fallbackProfileId: selection.fallbackProfileId ?? activeProfileId,
      generation: selectedGroup.generation,
      credentialRevision:
        selectedGroup.credentialRevision ?? activeProfile.credentialRevision,
      policy: selectedGroup.policy,
      memberProfileIds: group.members.map((member) => member.connectedAccountId),
    });
  }

  return { credentialBindings, groupSelections };
}

type ConnectedServiceResolvedGroupSelection = Readonly<{
  groupId: string;
  activeProfileId: string;
  fallbackProfileId: string;
  generation: number;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  policy: unknown;
  memberProfileIds: readonly string[];
}>;

async function maybeRecoverGroupAfterSpawnPreflightRefreshFailure(params: Readonly<{
  error: ConnectedServiceSpawnCredentialRefreshError;
  groupSelections: Map<ConnectedAccountServiceKey, ConnectedServiceResolvedGroupSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialResolutionsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialResolution>;
  credentialRevisionsByServiceId: Map<ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1>;
  credentials: StoredCredentials;
  api: ApiClient;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
}>): Promise<boolean> {
  if (params.error.kind !== 'reconnect_required') return false;
  const serviceId = [...params.groupSelections.keys()].find((candidate) => (
    resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(candidate)
      === params.error.serviceId
  ));
  if (!serviceId) return false;
  const group = params.groupSelections.get(serviceId);
  if (!group || group.activeProfileId !== params.error.profileId) return false;
  return applyCanonicalSpawnFailureSwitch({
    serviceId,
    observedProfileId: params.error.profileId,
    groupSelections: params.groupSelections,
    recordsByServiceId: params.recordsByServiceId,
    credentialResolutionsByServiceId: params.credentialResolutionsByServiceId,
    credentialRevisionsByServiceId: params.credentialRevisionsByServiceId,
    credentials: params.credentials,
    api: params.api,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
  });
}

async function applyCanonicalSpawnFailureSwitch(params: Readonly<{
  serviceId: ConnectedAccountServiceKey;
  observedProfileId: string;
  groupSelections: Map<ConnectedAccountServiceKey, ConnectedServiceResolvedGroupSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialResolutionsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialResolution>;
  credentialRevisionsByServiceId: Map<ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1>;
  credentials: StoredCredentials;
  api: ApiClient;
  sessionId?: string;
  authGroupSwitchCoordinator: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
}>): Promise<boolean> {
  const group = params.groupSelections.get(params.serviceId);
  const switchAfterFailure = params.authGroupSwitchCoordinator?.switchAfterClassifiedFailure;
  if (!group || typeof switchAfterFailure !== 'function') return false;

  const result = await switchAfterFailure.call(params.authGroupSwitchCoordinator, {
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    serviceId: params.serviceId,
    groupId: group.groupId,
    reason: 'refresh_failed',
    observedProfileId: params.observedProfileId,
  });
  if (!result) return false;
  const activeProfileId = readProfileId(result.activeProfileId);
  const generation = typeof result.generation === 'number' && Number.isFinite(result.generation)
    ? result.generation
    : group.generation;
  if (!activeProfileId || activeProfileId === params.observedProfileId) return false;

  let credentialRevision = result.credentialRevision ?? null;
  const legacyServiceId =
    resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
      params.serviceId,
    );
  if (legacyServiceId) {
    const resolved = await resolveConnectedServiceCredentialResolutions({
      credentials: params.credentials,
      api: params.api,
      bindings: [{ serviceId: legacyServiceId, profileId: activeProfileId }],
    });
    const credential = resolved.get(legacyServiceId);
    if (!credential) return false;
    if (credential.revisionSemantics !== 'revisioned') {
      throw new ConnectedServiceLegacyUnfencedAuthorityError(
        'materialization',
      );
    }
    params.credentialResolutionsByServiceId.set(legacyServiceId, credential);
    params.recordsByServiceId.set(legacyServiceId, credential.record);
    credentialRevision = credential.credentialRevision;
  }
  if (!credentialRevision) return false;
  params.credentialRevisionsByServiceId.set(
    params.serviceId,
    credentialRevision,
  );
  params.groupSelections.set(params.serviceId, {
    ...group,
    activeProfileId,
    generation,
    credentialRevision,
  });
  return true;
}

/**
 * CS-FIX-2: the spawn-path materialization-failure health write must PROPAGATE the real failure
 * category from the diagnostic instead of fabricating `provider_403`/`needs_reauth` for every
 * blocking diagnostic. A non-auth blocking failure (e.g. a shared-state link/disk/manifest class)
 * would otherwise silently mis-latch the profile `needs_reauth` with a synthesized HTTP 403 that no
 * provider ever returned — the exact silent wrong-latch class that hides healthy accounts.
 *
 * This routes through the single canonical health-write owner
 * (`persistConnectedServiceCredentialHealthForMaterializationFailure`), which classifies the
 * diagnostic via the shared taxonomy and only latches `needs_reauth` for genuinely auth/permission
 * diagnostics; other blocking reasons keep their true category as a non-latching
 * `refresh_failed_retryable` status.
 */
export async function persistMaterializationFailureCredentialHealthForSpawn(params: Readonly<{
  api: ApiClient;
  serviceId: ConnectedServiceId;
  profileId: string;
  diagnostic: ConnectedServicesMaterializationDiagnostic;
  nowMs: number;
}>): Promise<void> {
  await persistConnectedServiceCredentialHealthForMaterializationFailure({
    api: params.api,
    binding: { serviceId: params.serviceId, profileId: params.profileId },
    diagnostic: params.diagnostic,
    now: params.nowMs,
  });
}

async function maybeRecoverGroupAfterSpawnMaterializationFailure(params: Readonly<{
  error: ConnectedServiceMaterializationBlockedError;
  groupSelections: Map<ConnectedAccountServiceKey, ConnectedServiceResolvedGroupSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialResolutionsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialResolution>;
  credentialRevisionsByServiceId: Map<ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1>;
  credentials: StoredCredentials;
  api: ApiClient;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  nowMs: number;
}>): Promise<boolean> {
  const diagnostic = params.error.diagnostics.find((candidate) => (
    candidate.serviceId
      ? params.groupSelections.has(candidate.serviceId)
      : false
  ));
  if (!diagnostic?.serviceId) return false;

  const serviceId = diagnostic.serviceId;
  const group = params.groupSelections.get(serviceId);
  if (!group) return false;
  const legacyServiceId =
    resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
      serviceId,
    );
  if (legacyServiceId) {
    await persistMaterializationFailureCredentialHealthForSpawn({
      api: params.api,
      serviceId: legacyServiceId,
      profileId: group.activeProfileId,
      diagnostic,
      nowMs: params.nowMs,
    });
  }

  return applyCanonicalSpawnFailureSwitch({
    serviceId,
    observedProfileId: group.activeProfileId,
    groupSelections: params.groupSelections,
    recordsByServiceId: params.recordsByServiceId,
    credentialResolutionsByServiceId: params.credentialResolutionsByServiceId,
    credentialRevisionsByServiceId: params.credentialRevisionsByServiceId,
    credentials: params.credentials,
    api: params.api,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
  });
}

function buildCurrentSpawnCredentialBindings(params: Readonly<{
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  groupSelections: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedGroupSelection>;
  credentialRevisionsByServiceId: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1>;
}>): ReadonlyArray<{
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
  credentialRevision?: ConnectedServiceCredentialRevisionV1;
}> {
  return params.selections.map((selection) => {
    if (selection.kind === 'profile') {
      const credentialRevision = params.credentialRevisionsByServiceId.get(
        selection.serviceId,
      );
      return {
        serviceId: selection.serviceId,
        profileId: selection.profileId,
        ...(credentialRevision ? { credentialRevision } : {}),
      };
    }
    const group = params.groupSelections.get(selection.serviceId);
    const profileId = group?.activeProfileId ?? selection.fallbackProfileId;
    if (!profileId) {
      throw new Error(`Connected-service group ${selection.groupId} has no resolved active profile`);
    }
    const credentialRevision = group?.credentialRevision
      ?? params.credentialRevisionsByServiceId.get(selection.serviceId);
    return {
      serviceId: selection.serviceId,
      profileId,
      ...(credentialRevision ? { credentialRevision } : {}),
    };
  });
}

function buildSelectionsByServiceIdForSpawn(params: Readonly<{
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  credentialRevisionsByServiceId: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1>;
  groupSelections: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedGroupSelection>;
}>): ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedSelection> {
  const selectionsByServiceId = new Map<ConnectedAccountServiceKey, ConnectedServiceResolvedSelection>();

  for (const selection of params.selections) {
    if (selection.kind === 'profile') {
      const credentialRevision = params.credentialRevisionsByServiceId.get(
        selection.serviceId,
      );
      selectionsByServiceId.set(selection.serviceId, {
        kind: 'profile',
        serviceId: selection.serviceId,
        profileId: selection.profileId,
        ...(credentialRevision ? { credentialRevision } : {}),
      });
      continue;
    }
    const group = params.groupSelections.get(selection.serviceId);
    if (!group) continue;
    const credentialRevision = group.credentialRevision
      ?? params.credentialRevisionsByServiceId.get(selection.serviceId);
    selectionsByServiceId.set(selection.serviceId, {
      kind: 'group',
      serviceId: selection.serviceId,
      groupId: group.groupId,
      activeProfileId: group.activeProfileId,
      fallbackProfileId: group.fallbackProfileId,
      generation: group.generation,
      ...(credentialRevision ? { credentialRevision } : {}),
      policy: group.policy,
    });
  }

  return selectionsByServiceId;
}

function assertRequestAuthCredentialRevisions(input: Readonly<{
  purposeBindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
  credentialRevisionsByServiceId: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1>;
}>): void {
  for (const binding of input.purposeBindings) {
    const service = binding.target.kind === 'account'
      ? binding.target.account.service
      : binding.target.service;
    const serviceId = buildQualifiedPluginContributionKey(service);
    if (!input.credentialRevisionsByServiceId.get(serviceId)) {
      throw new ConnectedServiceRequestAuthCredentialRevisionRequiredError(
        serviceId,
      );
    }
  }
}

function buildCanonicalConnectedServicesBindingsForSpawn(params: Readonly<{
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  groupSelections: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedGroupSelection>;
}>): ConnectedServicesBindingsV1 {
  const bindingsByServiceId: ConnectedServicesBindingsV1['bindingsByServiceId'] = {};

  for (const selection of params.selections) {
    if (selection.kind === 'profile') {
      bindingsByServiceId[selection.serviceId] = {
        source: 'connected',
        selection: 'profile',
        profileId: selection.profileId,
      };
      continue;
    }
    const group = params.groupSelections.get(selection.serviceId);
    if (!group) continue;
    bindingsByServiceId[selection.serviceId] = {
      source: 'connected',
      selection: 'group',
      groupId: group.groupId,
    };
  }

  return {
    v: 1,
    bindingsByServiceId,
  };
}

function resolveSpawnMaterializationAttemptLimit(
  groupSelections: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedGroupSelection>,
): number {
  const groupMemberAttemptCount = [...groupSelections.values()]
    .reduce((total, group) => total + Math.max(1, group.memberProfileIds.length), 0);
  return Math.max(2, groupMemberAttemptCount + 1);
}

async function materializeAndVerifyConnectedServiceAuthForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedSelection>;
  connectedAccountMaterializationAuthority: ConnectedServicesMaterializationAuthority;
  qualifiedPurposeBindingSnapshot?: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  exactPurposeBindingSubjectId?: string;
  accountSettings: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv: NodeJS.ProcessEnv;
  vendorResumeId: string | null;
  resumeReachabilityRequired: boolean;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}>): Promise<ConnectedServicesMaterialization | null> {
  const materialized = await materializeConnectedServicesForSpawn({
    agentId: params.agentId,
    materializationKey: params.materializationKey,
    activeServerDir: params.activeServerDir,
    baseDir: params.baseDir,
    sessionDirectory: params.sessionDirectory,
    recordsByServiceId: params.recordsByServiceId,
    selectionsByServiceId: params.selectionsByServiceId,
    connectedAccountMaterializationAuthority:
      params.connectedAccountMaterializationAuthority,
    qualifiedPurposeBindingSnapshot:
      params.qualifiedPurposeBindingSnapshot ?? null,
    ...(params.exactPurposeBindingSubjectId
      ? { exactPurposeBindingSubjectId: params.exactPurposeBindingSubjectId }
      : {}),
    accountSettings: params.accountSettings,
    processEnv: params.processEnv,
  });

  if (!materialized) return null;

  try {
    await assertSpawnResumeReachable({
      agentId: params.agentId,
      materializedEnv: materialized.env,
      vendorResumeId: params.vendorResumeId,
      cwd: params.sessionDirectory,
      resumeReachabilityRequired: params.resumeReachabilityRequired,
      ...(params.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.runtimeDescriptorV1 } : {}),
    });
  } catch (error) {
    // Surface a materialized-root cleanup failure without losing the causal
    // spawn-auth failure that triggered it.
    await Promise.resolve(materialized.cleanupOnFailure?.()).catch(
      (cleanupError: unknown) => {
        throw new AggregateError(
          [error, cleanupError],
          'Connected-service spawn auth and materialized-root cleanup failed',
        );
      },
    );
    throw error;
  }
  return materialized;
}

export async function resolveConnectedServiceAuthForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  connectedServicesBindingsRaw: unknown;
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  credentials: StoredCredentials;
  api: ApiClient;
  allowGroupBindingProfileFallback?: boolean;
  accountUsageStore?: AccountUsageStoreForAuthGroupSwitchState | null;
  qualifiedConnectedAccountApi?: ConnectedServiceQualifiedAuthGroupApi;
  quotaFreshnessMs?: number;
  nowMs?: () => number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  predictiveSwitchGuard?: ConnectedServicePredictiveSwitchGuard | null;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  credentialRefreshService?: ConnectedServiceSpawnCredentialRefreshService | null;
  /**
   * The vendor `--resume` reference the spawned process will resume from. Required for the §2
   * post-materialization reachability re-verify; null/absent means this is a fresh (non-resume)
   * spawn and the gate is skipped.
   */
  vendorResumeId?: string | null;
  /**
   * Whether shared-state continuity was requested for this spawn. When true (and a `vendorResumeId`
   * is present), the reachability gate runs against the REAL materialized target before the vendor
   * launches; when false the spawn is not continuity-gated (e.g. isolated state).
   */
  resumeReachabilityRequired?: boolean;
  /**
   * Host-owned current resume evidence. The strict spawn gate deliberately
   * proves the materialized target instead of exposing this path to the Agent.
   */
  candidatePersistedSessionFile?: string | null;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  resolveQualifiedPurposeBindingSnapshot?: (
    bindings: ConnectedServicesBindingsV1,
  ) => AgentSpawnQualifiedPurposeBindingSnapshot | null;
  activateQualifiedPurposeBindings?: (
    snapshot: AgentSpawnQualifiedPurposeBindingSnapshot,
  ) => Readonly<{
    subjectId: string;
    dispose(): void | Promise<void>;
  }>;
  /**
   * Allows the ordinary Agent spawn owner to downgrade an exact-old-server
   * profile selection to its bounded legacy materializer. The resolved
   * qualified purpose remains unavailable: no request-auth binding or runtime
   * registration is returned.
   */
  allowLegacyUnfencedOneShotMaterialization?: boolean;
  serverContract?:
    SessionSyncPendingInputServerContractResult | null;
}>): Promise<Readonly<{
  env: Record<string, string>;
  cleanupOnFailure: (() => void | Promise<void>) | null;
  cleanupOnExit: (() => void | Promise<void>) | null;
  connectedServicesBindings: ConnectedServicesBindingsV1;
  targetMaterializedRoot?: string | null;
  requestAuthMaterializedRoot?: string | null;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
  requestAuthPurposeBindings?: readonly QualifiedConnectedAccountPurposeBindingV1[];
  qualifiedPurposeBindingSnapshot: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  materializationPurposeLease?: Readonly<{
    subjectId: string;
    dispose(): void | Promise<void>;
  }>;
  ongoingRuntimeRegistrationAllowed?: false;
}> | null> {
  const selections = parseConnectedServiceBindingSelections(params.connectedServicesBindingsRaw);
  if (selections.length === 0) return null;
  const nowMs = (params.nowMs ?? (() => Date.now()))();
  let serverFeatures: CliServerFeaturesSnapshot | undefined;
  try {
    serverFeatures = await params.api.getServerFeaturesSnapshot?.();
  } catch {
    serverFeatures = undefined;
  }
  const exactLegacyUnfencedServer =
    resolveQualifiedConnectedAccountPeerClass(
      serverFeatures,
      params.serverContract,
    ) === 'exact_v0_2_1';
  if (
    exactLegacyUnfencedServer
    && selections.some((selection) => selection.kind === 'group')
  ) {
    throw new ConnectedServiceLegacyUnfencedAuthorityError('group');
  }

  const resolvedBindings = await resolveCredentialBindings({
    agentId: params.agentId,
    api: params.api,
    credentials: params.credentials,
    selections,
    accountUsageStore: params.accountUsageStore ?? null,
    ...(params.qualifiedConnectedAccountApi
      ? { qualifiedConnectedAccountApi: params.qualifiedConnectedAccountApi }
      : {}),
    legacyDirectProfileIngress: exactLegacyUnfencedServer,
    quotaFreshnessMs: params.quotaFreshnessMs ?? 5 * 60_000,
    nowMs,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
    predictiveSwitchGuard: params.predictiveSwitchGuard ?? null,
  });

  const legacyServiceKeyByServiceId = new Map<
    ConnectedServiceId,
    ConnectedAccountServiceKey
  >();
  const legacyCredentialBindings = resolvedBindings.credentialBindings.flatMap(
    (binding) => {
      const legacyServiceId =
        resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
          binding.serviceId,
        );
      if (!legacyServiceId) return [];
      legacyServiceKeyByServiceId.set(legacyServiceId, binding.serviceId);
      return [{
        serviceId: legacyServiceId,
        profileId: binding.profileId,
      }];
    },
  );
  let credentialResolutionsByServiceId = legacyCredentialBindings.length > 0
    ? await resolveConnectedServiceCredentialResolutions({
        credentials: params.credentials,
        api: params.api,
        bindings: legacyCredentialBindings,
      })
    : new Map<ConnectedServiceId, ConnectedServiceCredentialResolution>();
  const credentialRevisionsByServiceId = new Map<
    ConnectedAccountServiceKey,
    ConnectedServiceCredentialRevisionV1
  >(resolvedBindings.credentialBindings.flatMap((binding) => (
    binding.credentialRevision
      ? [[binding.serviceId, binding.credentialRevision] as const]
      : []
  )));
  for (const [legacyServiceId, resolution] of credentialResolutionsByServiceId) {
    const serviceKey = legacyServiceKeyByServiceId.get(legacyServiceId);
    if (
      serviceKey
      && resolution.revisionSemantics === 'revisioned'
      && resolution.credentialRevision
    ) {
      credentialRevisionsByServiceId.set(
        serviceKey,
        resolution.credentialRevision,
      );
    }
  }
  const hasLegacyUnfencedCredential = [
    ...credentialResolutionsByServiceId.values(),
  ].some((resolution) => resolution.revisionSemantics === 'legacy_unfenced');
  const hasRevisionedCredential = credentialRevisionsByServiceId.size > 0
    || [...credentialResolutionsByServiceId.values()].some(
      (resolution) => resolution.revisionSemantics === 'revisioned',
    );
  if (hasLegacyUnfencedCredential && hasRevisionedCredential) {
    throw new ConnectedServiceLegacyUnfencedAuthorityError(
      'materialization',
    );
  }
  if (
    hasLegacyUnfencedCredential
    && selections.some((selection) => selection.kind === 'group')
  ) {
    throw new ConnectedServiceLegacyUnfencedAuthorityError('group');
  }
  if (
    hasLegacyUnfencedCredential
    && (
      !exactLegacyUnfencedServer
      || !supportsLegacyUnfencedOneShotMaterialization(
        params.agentId,
        credentialResolutionsByServiceId,
        serverFeatures,
        params.serverContract,
      )
    )
  ) {
    throw new ConnectedServiceLegacyUnfencedAuthorityError(
      'materialization',
    );
  }
  const recordsByServiceId = new Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>(
    [...credentialResolutionsByServiceId].map(([serviceId, resolution]) => [serviceId, resolution.record]),
  );
  const groupSelections = new Map(resolvedBindings.groupSelections);
  const initialConnectedServicesBindings =
    buildCanonicalConnectedServicesBindingsForSpawn({
      selections,
      groupSelections,
    });
  const initialQualifiedPurposeBindingSnapshot =
    hasLegacyUnfencedCredential
      ? params.resolveQualifiedPurposeBindingSnapshot?.(
          initialConnectedServicesBindings,
        ) ?? null
      : null;
  const initialRequestAuthPurposeBindings =
    resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(
      initialQualifiedPurposeBindingSnapshot,
    );
  if (
    hasLegacyUnfencedCredential
    && params.allowLegacyUnfencedOneShotMaterialization !== true
  ) {
    throw new ConnectedServiceLegacyUnfencedAuthorityError(
      initialRequestAuthPurposeBindings.length > 0
        ? 'request_auth'
        : 'materialization',
    );
  }
  const maxPreflightAttempts = hasLegacyUnfencedCredential
    ? 1
    : resolveSpawnMaterializationAttemptLimit(groupSelections);
  for (let attempt = 0; attempt < maxPreflightAttempts; attempt += 1) {
    const credentialBindings = buildCurrentSpawnCredentialBindings({
      selections,
      groupSelections,
      credentialRevisionsByServiceId,
    });
    const legacyBindings = credentialBindings.flatMap((binding) => {
      const serviceId =
        resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
          binding.serviceId,
        );
      return serviceId
        ? [{ serviceId, profileId: binding.profileId }]
        : [];
    });
    try {
      if (!hasLegacyUnfencedCredential) {
        await applySpawnPreflightRefresh({
          recordsByServiceId,
          credentialBindings: legacyBindings,
          refreshService: params.credentialRefreshService ?? null,
        });
      }
      if (
        !hasLegacyUnfencedCredential
        && params.credentialRefreshService
        && legacyBindings.length > 0
      ) {
        const currentResolutions = await resolveConnectedServiceCredentialResolutions({
          credentials: params.credentials,
          api: params.api,
          bindings: legacyBindings,
        });
        if (
          [...currentResolutions.values()].some(
            (resolution) =>
              resolution.revisionSemantics !== 'revisioned',
          )
        ) {
          throw new ConnectedServiceLegacyUnfencedAuthorityError(
            'materialization',
          );
        }
        credentialResolutionsByServiceId = currentResolutions;
        for (const [serviceId, resolution] of currentResolutions) {
          recordsByServiceId.set(serviceId, resolution.record);
          const serviceKey = legacyServiceKeyByServiceId.get(serviceId);
          if (serviceKey && resolution.credentialRevision) {
            credentialRevisionsByServiceId.set(
              serviceKey,
              resolution.credentialRevision,
            );
          }
        }
      }
      break;
    } catch (error) {
      if (!(error instanceof ConnectedServiceSpawnCredentialRefreshError)) throw error;
      if (attempt >= maxPreflightAttempts - 1) throw error;
      const recovered = await maybeRecoverGroupAfterSpawnPreflightRefreshFailure({
        error,
        groupSelections,
        recordsByServiceId,
        credentialResolutionsByServiceId,
        credentialRevisionsByServiceId,
        credentials: params.credentials,
        api: params.api,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
      });
      if (!recovered) throw error;
    }
  }
  const maxMaterializationAttempts = hasLegacyUnfencedCredential
    ? 1
    : resolveSpawnMaterializationAttemptLimit(groupSelections);
  for (let attempt = 0; attempt < maxMaterializationAttempts; attempt += 1) {
    const selectionsByServiceId = buildSelectionsByServiceIdForSpawn({
      selections,
      credentialRevisionsByServiceId,
      groupSelections,
    });
    const connectedServicesBindings = buildCanonicalConnectedServicesBindingsForSpawn({
      selections,
      groupSelections,
    });
    const qualifiedPurposeBindingSnapshot =
      params.resolveQualifiedPurposeBindingSnapshot?.(
        connectedServicesBindings,
      ) ?? null;
    if (!hasLegacyUnfencedCredential) {
      assertQualifiedPurposeAuthorityForSelections({
        selections,
        snapshot: qualifiedPurposeBindingSnapshot,
      });
    }
    const requestAuthPurposeBindings = hasLegacyUnfencedCredential
      ? Object.freeze([])
      : resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(
          qualifiedPurposeBindingSnapshot,
        );
    assertRequestAuthCredentialRevisions({
      purposeBindings: requestAuthPurposeBindings,
      credentialRevisionsByServiceId,
    });

    const materializationPurposeLease = !hasLegacyUnfencedCredential
      && qualifiedPurposeBindingSnapshot
      ? params.activateQualifiedPurposeBindings?.(
          qualifiedPurposeBindingSnapshot,
        ) ?? null
      : null;
    let retainMaterializationPurposeLease = false;
    try {
      const materialized = await materializeAndVerifyConnectedServiceAuthForSpawn({
        agentId: params.agentId,
        materializationKey: params.materializationKey,
        activeServerDir: params.activeServerDir,
        baseDir: params.baseDir,
        sessionDirectory: params.sessionDirectory ?? null,
        recordsByServiceId,
        selectionsByServiceId,
        connectedAccountMaterializationAuthority: hasLegacyUnfencedCredential
          ? { kind: 'legacy_unfenced_one_shot' }
          : {
              kind: 'qualified',
              purposeBindings:
                qualifiedPurposeBindingSnapshot?.bindings
                ?? Object.freeze([]),
              requestAuthPurposeBindings,
            },
        qualifiedPurposeBindingSnapshot,
        ...(materializationPurposeLease
          ? {
              exactPurposeBindingSubjectId:
                materializationPurposeLease.subjectId,
            }
          : {}),
        accountSettings: params.accountSettings ?? null,
        processEnv: params.processEnv ?? process.env,
        vendorResumeId: params.vendorResumeId ?? null,
        resumeReachabilityRequired: params.resumeReachabilityRequired ?? false,
        ...(params.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.runtimeDescriptorV1 } : {}),
      });
      if (materialized === null) return null;
      retainMaterializationPurposeLease = materializationPurposeLease !== null;
      return {
        ...materialized,
        connectedServicesBindings,
        requestAuthPurposeBindings,
        qualifiedPurposeBindingSnapshot,
        ...(materializationPurposeLease
          ? { materializationPurposeLease }
          : {}),
        ...(hasLegacyUnfencedCredential
          ? { ongoingRuntimeRegistrationAllowed: false as const }
          : {}),
      };
    } catch (error) {
      if (!(error instanceof ConnectedServiceMaterializationBlockedError)) throw error;
      if (attempt >= maxMaterializationAttempts - 1) throw error;
      const recovered = await maybeRecoverGroupAfterSpawnMaterializationFailure({
        error,
        groupSelections,
        recordsByServiceId,
        credentialResolutionsByServiceId,
        credentialRevisionsByServiceId,
        credentials: params.credentials,
        api: params.api,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
        nowMs,
      });
      if (!recovered) throw error;
    } finally {
      if (!retainMaterializationPurposeLease) {
        await materializationPurposeLease?.dispose();
      }
    }
  }

  return null;
}

/**
 * The §2 hard post-materialization re-verify gate. Runs ONLY for a resume-continuity spawn — i.e.
 * shared-state continuity was requested AND a vendor resume reference is present. Proves the target
 * the vendor will actually read (from the REAL materialized env) via the central reachability
 * dispatcher; on a genuine miss it fails closed with a concrete structured reason BEFORE the vendor
 * launches, instead of letting the spawned process crash resuming a missing file.
 *
 * A fresh (no-resume) spawn and an isolated (no continuity) spawn are not gated. Per D8 the
 * cross-machine fallback is preserved by the provider probe itself (a stale absolute hint degrades to
 * the id+cwd native search), so this gate only fires when state is genuinely unreachable.
 *
 */
async function assertSpawnResumeReachable(params: Readonly<{
  agentId: CatalogAgentId;
  materializedEnv: Readonly<Record<string, string>>;
  vendorResumeId: string | null;
  cwd: string | null;
  resumeReachabilityRequired: boolean;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}>): Promise<void> {
  if (!params.resumeReachabilityRequired) return;
  const vendorResumeId = typeof params.vendorResumeId === 'string' ? params.vendorResumeId.trim() : '';
  // No vendor resume reference => this is a fresh (non-resume) spawn; the continuity gate does not
  // apply (see the `vendorResumeId` param contract). A fresh spawn is never gated.
  if (!vendorResumeId) return;

  const reachability = await verifySpawnResumeReachability({
    agentId: params.agentId,
    vendorResumeId,
    materializedEnv: params.materializedEnv,
    ...(params.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.runtimeDescriptorV1 } : {}),
  });
  if (reachability.ok) return;

  throw new ConnectedServiceSpawnResumeUnreachableError({
    agentId: params.agentId,
    vendorResumeId,
    cwd: typeof params.cwd === 'string' ? params.cwd.trim() : '',
    targetMaterializedRoot: resolveConnectedServiceTargetMaterializedRoot({
      agentId: params.agentId,
      targetMaterializedEnv: params.materializedEnv,
    }),
    reason: reachability.reason,
  });
}
