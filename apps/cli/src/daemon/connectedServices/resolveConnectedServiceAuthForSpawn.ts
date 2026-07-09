import type {
  AccountSettings,
  ConnectedServiceAuthGroupV1,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

import {
  parseConnectedServiceBindingSelections,
  type ConnectedServiceBindingSelection,
  type ConnectedServicesBindingsV1,
} from './parseConnectedServicesBindings';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
  ConnectedServiceMaterializationBlockedError,
  materializeConnectedServicesForSpawn,
} from './materialize/materializeConnectedServicesForSpawn';
import { resolveConnectedServiceTargetMaterializedRoot } from './materialize/resolveConnectedServiceTargetMaterializedRoot';
import { verifySpawnResumeReachability } from './verifySpawnResumeReachability';
import type {
  ConnectedServiceResolvedSelection,
  ConnectedServicesMaterialization,
  ConnectedServicesMaterializationDiagnostic,
} from './materialization/materializer';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupMemberRuntimeState,
} from './accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from './accountGroups/selection/resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import {
  buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState,
} from './accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
  buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
  type AccountUsageStoreForAuthGroupSwitchState,
} from './accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import type {
  ConnectedServiceAuthGroupMemberRuntimeStateOverride,
  ConnectedServiceAuthGroupSwitchState,
} from './accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import {
  persistConnectedServiceCredentialHealthForMaterializationFailure,
  type ConnectedServiceCredentialRefreshResult,
} from './refresh/ConnectedServiceRefreshCoordinator';
import type {
  ConnectedServiceRecoverySoftSwitchGuardInput,
  ConnectedServiceRecoverySoftSwitchGuardResult,
} from './recovery/connectedServiceRecoverySwitchGuard';
import { decideConnectedServiceRecovery } from './runtimeAuth/ConnectedServiceRecoveryPolicy';

type ConnectedServiceAuthGroupResponse = Readonly<{
  v?: number;
  serviceId?: string;
  groupId: string;
  activeProfileId?: string | null;
  generation?: number | null;
  policy?: unknown;
  members?: unknown;
}>;

type ConnectedServiceAuthGroupApi = Readonly<{
  getConnectedServiceAuthGroup?: (params: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>) => Promise<ConnectedServiceAuthGroupResponse | null>;
  updateConnectedServiceAuthGroupActiveProfile?: (params: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    expectedGeneration?: number;
  }>) => Promise<ConnectedServiceAuthGroupResponse>;
}>;

type ConnectedServiceProfileStatus =
  | 'connected'
  | 'refreshing'
  | 'needs_reauth'
  | 'refresh_failed_retryable';

type ConnectedServiceProfilesHealthApi = Readonly<{
  listConnectedServiceProfiles?: (params: Readonly<{
    serviceId: ConnectedServiceId;
  }>) => Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<Readonly<{
      profileId: string;
      status: ConnectedServiceProfileStatus;
    }>>;
  }>>;
}>;

type ConnectedServiceAuthGroupPreTurnSwitchCoordinator = Readonly<{
  switchBeforeTurn(params: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    memberStateOverridesByProfileId?: ReadonlyArray<ConnectedServiceAuthGroupMemberRuntimeStateOverride>;
  }>): Promise<Readonly<{
    status: string;
    activeProfileId?: string | null;
    generation?: number;
  }>>;
  switchAfterClassifiedFailure?(params: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'refresh_failed';
    observedProfileId?: string | null;
  }>): Promise<Readonly<{
    status: string;
    activeProfileId?: string | null;
    generation?: number;
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

type ConnectedServiceRecoverySoftSwitchGuard = (
  input: ConnectedServiceRecoverySoftSwitchGuardInput,
) => ConnectedServiceRecoverySoftSwitchGuardResult | Promise<ConnectedServiceRecoverySoftSwitchGuardResult>;

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
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;
  readonly status: ConnectedServiceProfileStatus;

  constructor(params: Readonly<{
    serviceId: ConnectedServiceId;
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

async function resolveProfileStatusByProfileId(params: Readonly<{
  api: ApiClient;
  serviceId: ConnectedServiceId;
}>): Promise<ReadonlyMap<string, ConnectedServiceProfileStatus> | null> {
  const api = params.api as ConnectedServiceProfilesHealthApi;
  if (typeof api.listConnectedServiceProfiles !== 'function') return null;
  const result = await api.listConnectedServiceProfiles({ serviceId: params.serviceId });
  return new Map(result.profiles.map((profile) => [profile.profileId, profile.status]));
}

function throwIfProfileRequiresAction(params: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  profileStatusByProfileId: ReadonlyMap<string, ConnectedServiceProfileStatus> | null;
}>): void {
  const status = params.profileStatusByProfileId?.get(params.profileId) ?? null;
  if (status !== 'needs_reauth') return;
  throw new ConnectedServiceSpawnProfileActionRequiredError({
    serviceId: params.serviceId,
    profileId: params.profileId,
    status,
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

function isFullAuthGroup(value: ConnectedServiceAuthGroupResponse): value is ConnectedServiceAuthGroupV1 {
  return value.v === 1
    && typeof value.serviceId === 'string'
    && Array.isArray((value as { members?: unknown }).members)
    && typeof value.generation === 'number'
    && Number.isFinite(value.generation)
    && typeof value.policy === 'object'
    && value.policy !== null;
}

function resolveActiveGroupProfileIssueReason(
  state: ConnectedServiceAuthGroupSwitchState,
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
  group: ConnectedServiceAuthGroupV1;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  nowMs: number;
  allowPersistedOnly: boolean;
}>): ConnectedServiceAuthGroupSwitchState | null {
  if (params.accountUsageStore) {
    return buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group: params.group,
      accountUsageStore: params.accountUsageStore,
    })?.state ?? buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({
      group: params.group,
    });
  }
  return params.allowPersistedOnly
    ? buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group: params.group })
    : null;
}

async function maybeSelectGroupActiveProfileForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  group: ConnectedServiceAuthGroupResponse;
  serviceId: ConnectedServiceId;
  groupId: string;
  api: ConnectedServiceAuthGroupApi;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  profileStatusByProfileId: ReadonlyMap<string, ConnectedServiceProfileStatus> | null;
  quotaFreshnessMs: number;
  nowMs: number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  softSwitchRecoveryGuard?: ConnectedServiceRecoverySoftSwitchGuard | null;
}>): Promise<ConnectedServiceAuthGroupResponse> {
  const hasUnhealthyProfile = [...(params.profileStatusByProfileId?.values() ?? [])]
    .some((status) => status === 'needs_reauth');
  if ((!params.accountUsageStore && !params.runtimeQuotaSnapshots && !hasUnhealthyProfile) || !isFullAuthGroup(params.group)) return params.group;
  if (
    !params.authGroupSwitchCoordinator
    && typeof params.api.updateConnectedServiceAuthGroupActiveProfile !== 'function'
  ) return params.group;

  const state = buildSpawnSwitchState({
    group: params.group,
    accountUsageStore: params.accountUsageStore,
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
    nowMs: params.nowMs,
    allowPersistedOnly: hasUnhealthyProfile,
  });
  if (!state) return params.group;
  if (!state.policy.autoSwitch) return params.group;
  const memberStatesByProfileId = new Map(state.memberStatesByProfileId);
  const memberStateOverridesByProfileId: ConnectedServiceAuthGroupMemberRuntimeStateOverride[] = [];
  for (const member of state.members) {
    const status = params.profileStatusByProfileId?.get(member.profileId) ?? null;
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
  if (activeIssueReason === 'soft_threshold' && !params.accountUsageStore) return params.group;
  const currentActiveProfileId = readProfileId(state.activeProfileId);
  if (params.sessionId && params.softSwitchRecoveryGuard && currentActiveProfileId) {
    const guardResult = await params.softSwitchRecoveryGuard({
      sessionId: params.sessionId,
      serviceId: params.serviceId,
      groupId: params.groupId,
      activeProfileId: currentActiveProfileId,
      agentId: params.agentId,
      reason: activeIssueReason,
    });
    if (guardResult.status === 'suppress') return params.group;
  }
  if (
    params.authGroupSwitchCoordinator
    && resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
      activeProfileId: state.activeProfileId,
      members: state.members,
      memberStatesByProfileId,
      policy: state.policy,
      nowMs: params.nowMs,
      quotaFreshnessMs: params.quotaFreshnessMs,
      allowCurrentProfileRetry: true,
    }).length > 0
  ) {
    const switched = await params.authGroupSwitchCoordinator.switchBeforeTurn({
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      serviceId: params.serviceId,
      groupId: params.groupId,
      reason: activeIssueReason,
      ...(memberStateOverridesByProfileId.length > 0 ? { memberStateOverridesByProfileId } : {}),
    });
    const activeProfileId = readProfileId(switched.activeProfileId);
    if (activeProfileId) {
      return {
        ...params.group,
        activeProfileId,
        generation: typeof switched.generation === 'number' && Number.isFinite(switched.generation)
          ? switched.generation
          : params.group.generation,
      };
    }
  }

  const selected = selectConnectedServiceAuthGroupCandidate({
    nowMs: params.nowMs,
    quotaFreshnessMs: params.quotaFreshnessMs,
    activeProfileId: state.activeProfileId,
    policy: state.policy,
    members: state.members,
    memberStatesByProfileId,
    allowCurrentProfileRetry: true,
  });
  const selectedProfileId = selected.selected?.profileId ?? null;
  if (!selectedProfileId || selectedProfileId === readProfileId(state.activeProfileId)) return params.group;

  if (params.authGroupSwitchCoordinator) {
    const switched = await params.authGroupSwitchCoordinator.switchBeforeTurn({
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      serviceId: params.serviceId,
      groupId: params.groupId,
      reason: activeIssueReason,
      ...(memberStateOverridesByProfileId.length > 0 ? { memberStateOverridesByProfileId } : {}),
    });
    const activeProfileId = readProfileId(switched.activeProfileId);
    if (activeProfileId) {
      return {
        ...params.group,
        activeProfileId,
        generation: typeof switched.generation === 'number' && Number.isFinite(switched.generation)
          ? switched.generation
          : params.group.generation,
      };
    }
    return params.group;
  }

  if (typeof params.api.updateConnectedServiceAuthGroupActiveProfile !== 'function') return params.group;
  return await params.api.updateConnectedServiceAuthGroupActiveProfile({
    serviceId: params.serviceId,
    groupId: params.groupId,
    activeProfileId: selectedProfileId,
    expectedGeneration: state.generation,
  });
}

async function resolveCredentialBindings(params: Readonly<{
  agentId: CatalogAgentId;
  api: ApiClient;
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs: number;
  nowMs: number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  softSwitchRecoveryGuard?: ConnectedServiceRecoverySoftSwitchGuard | null;
}>): Promise<Readonly<{
  credentialBindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
}>> {
  const credentialBindings: Array<{ serviceId: ConnectedServiceId; profileId: string }> = [];
  const groupSelections = new Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>();

  for (const selection of params.selections) {
    const profileStatusByProfileId = await resolveProfileStatusByProfileId({
      api: params.api,
      serviceId: selection.serviceId,
    });

    if (selection.kind === 'profile') {
      throwIfProfileRequiresAction({
        serviceId: selection.serviceId,
        profileId: selection.profileId,
        profileStatusByProfileId,
      });
      credentialBindings.push({ serviceId: selection.serviceId, profileId: selection.profileId });
      continue;
    }

    const groupApi = params.api as ConnectedServiceAuthGroupApi;
    if (typeof groupApi.getConnectedServiceAuthGroup !== 'function') {
      throw new Error(`Connected service group resolution unavailable (${selection.serviceId}/${selection.groupId})`);
    }

    const group = await groupApi.getConnectedServiceAuthGroup({
      serviceId: selection.serviceId,
      groupId: selection.groupId,
    });
    if (!group) {
      throw new Error(`Missing connected service auth group (${selection.serviceId}/${selection.groupId})`);
    }

    const selectedGroup = await maybeSelectGroupActiveProfileForSpawn({
      agentId: params.agentId,
      group,
      serviceId: selection.serviceId,
      groupId: selection.groupId,
      api: groupApi,
      accountUsageStore: params.accountUsageStore,
      runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
      profileStatusByProfileId,
      quotaFreshnessMs: params.quotaFreshnessMs,
      nowMs: params.nowMs,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
      softSwitchRecoveryGuard: params.softSwitchRecoveryGuard ?? null,
    });
    const activeProfileId = readProfileId(selectedGroup.activeProfileId);
    if (!activeProfileId) {
      throw new Error(`Connected service auth group has no active profile (${selection.serviceId}/${selection.groupId})`);
    }
    throwIfProfileRequiresAction({
      serviceId: selection.serviceId,
      profileId: activeProfileId,
      profileStatusByProfileId,
    });
    credentialBindings.push({ serviceId: selection.serviceId, profileId: activeProfileId });
    groupSelections.set(selection.serviceId, {
      groupId: selection.groupId,
      activeProfileId,
      fallbackProfileId: selection.fallbackProfileId ?? activeProfileId,
      generation: typeof selectedGroup.generation === 'number' && Number.isFinite(selectedGroup.generation) ? selectedGroup.generation : 0,
      policy: selectedGroup.policy ?? null,
      memberProfileIds: isFullAuthGroup(selectedGroup)
        ? selectedGroup.members.map((member) => member.profileId)
        : [activeProfileId],
    });
  }

  return { credentialBindings, groupSelections };
}

type ConnectedServiceResolvedGroupSelection = Readonly<{
  groupId: string;
  activeProfileId: string;
  fallbackProfileId: string;
  generation: number;
  policy: unknown;
  memberProfileIds: readonly string[];
}>;

function decideSpawnCredentialFailureRecovery(params: Readonly<{
  serviceId: ConnectedServiceId;
  group: ConnectedServiceResolvedGroupSelection;
  profileId: string;
}>) {
  return decideConnectedServiceRecovery({
    actor: 'automatic',
    issue: {
      kind: 'refresh_failed',
      serviceId: params.serviceId,
      profileId: params.profileId,
      groupId: params.group.groupId,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'provider_runtime_marker',
    },
    selection: {
      kind: 'group',
      serviceId: params.serviceId,
      groupId: params.group.groupId,
      activeProfileId: params.group.activeProfileId,
    },
    credentialHealth: {
      liveEvidence: 'auth_failed',
    },
    credentialRefresh: {
      status: 'not_refreshable',
    },
  });
}

async function maybeRecoverGroupAfterSpawnPreflightRefreshFailure(params: Readonly<{
  error: ConnectedServiceSpawnCredentialRefreshError;
  groupSelections: Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
}>): Promise<boolean> {
  if (params.error.kind !== 'reconnect_required') return false;
  const group = params.groupSelections.get(params.error.serviceId);
  if (!group || group.activeProfileId !== params.error.profileId) return false;

  const decision = decideSpawnCredentialFailureRecovery({
    serviceId: params.error.serviceId,
    group,
    profileId: params.error.profileId,
  });
  return decision.action === 'no_op';
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
  groupSelections: Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
  api: ApiClient;
  nowMs: number;
}>): Promise<boolean> {
  const diagnostic = params.error.diagnostics.find((candidate) => {
    if (!candidate.serviceId) return false;
    return params.groupSelections.has(candidate.serviceId);
  });
  const serviceId = diagnostic?.serviceId;
  if (!serviceId) return false;

  const group = params.groupSelections.get(serviceId);
  if (!group) return false;
  await persistMaterializationFailureCredentialHealthForSpawn({
    api: params.api,
    serviceId,
    profileId: group.activeProfileId,
    diagnostic,
    nowMs: params.nowMs,
  });

  const decision = decideSpawnCredentialFailureRecovery({
    serviceId,
    group,
    profileId: group.activeProfileId,
  });
  return decision.action === 'no_op';
}

function buildSelectionsByServiceIdForSpawn(params: Readonly<{
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
}>): ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection> {
  const selectionsByServiceId = new Map<ConnectedServiceId, ConnectedServiceResolvedSelection>();

  for (const selection of params.selections) {
    const record = params.recordsByServiceId.get(selection.serviceId);
    if (!record) continue;
    if (selection.kind === 'profile') {
      selectionsByServiceId.set(selection.serviceId, {
        kind: 'profile',
        serviceId: selection.serviceId,
        profileId: selection.profileId,
        record,
      });
      continue;
    }
    const group = params.groupSelections.get(selection.serviceId);
    if (!group) continue;
    selectionsByServiceId.set(selection.serviceId, {
      kind: 'group',
      serviceId: selection.serviceId,
      groupId: group.groupId,
      activeProfileId: group.activeProfileId,
      fallbackProfileId: group.fallbackProfileId,
      generation: group.generation,
      record,
      policy: group.policy,
    });
  }

  return selectionsByServiceId;
}

function buildCanonicalConnectedServicesBindingsForSpawn(params: Readonly<{
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
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
      profileId: group.activeProfileId,
    };
  }

  return {
    v: 1,
    bindingsByServiceId,
  };
}

function resolveSpawnMaterializationAttemptLimit(
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>,
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
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  accountSettings: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv: NodeJS.ProcessEnv;
  vendorResumeId: string | null;
  resumeReachabilityRequired: boolean;
  candidatePersistedSessionFile: string | null;
}>): Promise<ConnectedServicesMaterialization | null> {
  const materialized = await materializeConnectedServicesForSpawn({
    agentId: params.agentId,
    materializationKey: params.materializationKey,
    activeServerDir: params.activeServerDir,
    baseDir: params.baseDir,
    sessionDirectory: params.sessionDirectory,
    recordsByServiceId: params.recordsByServiceId,
    selectionsByServiceId: params.selectionsByServiceId,
    accountSettings: params.accountSettings,
    processEnv: params.processEnv,
  });

  if (!materialized) return null;

  await assertSpawnResumeReachable({
    agentId: params.agentId,
    materializedEnv: materialized.env,
    vendorResumeId: params.vendorResumeId,
    cwd: params.sessionDirectory,
    resumeReachabilityRequired: params.resumeReachabilityRequired,
    candidatePersistedSessionFile: params.candidatePersistedSessionFile,
  });
  return materialized;
}

export async function resolveConnectedServiceAuthForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  connectedServicesBindingsRaw: unknown;
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  credentials: Credentials;
  api: ApiClient;
  allowGroupBindingProfileFallback?: boolean;
  accountUsageStore?: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots?: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs?: number;
  nowMs?: () => number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  softSwitchRecoveryGuard?: ConnectedServiceRecoverySoftSwitchGuard | null;
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
   * A persisted absolute vendor session-file hint, when known. Per D8 this is a fast-path hint only:
   * a stale/cross-machine path that fails to stat must degrade to the id+cwd native search, never
   * hard-fail.
   */
  candidatePersistedSessionFile?: string | null;
}>): Promise<Readonly<{
  env: Record<string, string>;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
  connectedServicesBindings: ConnectedServicesBindingsV1;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}> | null> {
  const selections = parseConnectedServiceBindingSelections(params.connectedServicesBindingsRaw);
  if (selections.length === 0) return null;
  const nowMs = (params.nowMs ?? (() => Date.now()))();

  const resolvedBindings = await resolveCredentialBindings({
    agentId: params.agentId,
    api: params.api,
    selections,
    accountUsageStore: params.accountUsageStore ?? null,
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots ?? null,
    quotaFreshnessMs: params.quotaFreshnessMs ?? 5 * 60_000,
    nowMs,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
    softSwitchRecoveryGuard: params.softSwitchRecoveryGuard ?? null,
  });

  const recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1> =
    await resolveConnectedServiceCredentials({
      credentials: params.credentials,
      api: params.api,
      bindings: resolvedBindings.credentialBindings,
    });
  const groupSelections = new Map(resolvedBindings.groupSelections);
  try {
    await applySpawnPreflightRefresh({
      recordsByServiceId,
      credentialBindings: resolvedBindings.credentialBindings,
      refreshService: params.credentialRefreshService ?? null,
    });
  } catch (error) {
    if (!(error instanceof ConnectedServiceSpawnCredentialRefreshError)) throw error;
    const recovered = await maybeRecoverGroupAfterSpawnPreflightRefreshFailure({
      error,
      groupSelections,
    });
    if (!recovered) throw error;
  }
  const maxMaterializationAttempts = resolveSpawnMaterializationAttemptLimit(groupSelections);
  for (let attempt = 0; attempt < maxMaterializationAttempts; attempt += 1) {
    const selectionsByServiceId = buildSelectionsByServiceIdForSpawn({
      selections,
      recordsByServiceId,
      groupSelections,
    });
    const connectedServicesBindings = buildCanonicalConnectedServicesBindingsForSpawn({
      selections,
      groupSelections,
    });

    try {
      const materialized = await materializeAndVerifyConnectedServiceAuthForSpawn({
        agentId: params.agentId,
        materializationKey: params.materializationKey,
        activeServerDir: params.activeServerDir,
        baseDir: params.baseDir,
        sessionDirectory: params.sessionDirectory ?? null,
        recordsByServiceId,
        selectionsByServiceId,
        accountSettings: params.accountSettings ?? null,
        processEnv: params.processEnv ?? process.env,
        vendorResumeId: params.vendorResumeId ?? null,
        resumeReachabilityRequired: params.resumeReachabilityRequired ?? false,
        candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      });
      if (materialized === null) return null;
      return {
        ...materialized,
        connectedServicesBindings,
      };
    } catch (error) {
      if (!(error instanceof ConnectedServiceMaterializationBlockedError)) throw error;
      if (attempt >= maxMaterializationAttempts - 1) throw error;
      const recovered = await maybeRecoverGroupAfterSpawnMaterializationFailure({
        error,
        groupSelections,
        api: params.api,
        nowMs,
      });
      if (!recovered) throw error;
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
 * When reachability IS required and a resume reference is present but a required gate input (`cwd`) is
 * missing, the gate FAILS CLOSED with `resume_reachability_inputs_missing` rather than silently
 * skipping — a plumbing fault must not be able to disable the hard gate for a continuity resume.
 */
async function assertSpawnResumeReachable(params: Readonly<{
  agentId: CatalogAgentId;
  materializedEnv: Readonly<Record<string, string>>;
  vendorResumeId: string | null;
  cwd: string | null;
  resumeReachabilityRequired: boolean;
  candidatePersistedSessionFile: string | null;
}>): Promise<void> {
  if (!params.resumeReachabilityRequired) return;
  const vendorResumeId = typeof params.vendorResumeId === 'string' ? params.vendorResumeId.trim() : '';
  // No vendor resume reference => this is a fresh (non-resume) spawn; the continuity gate does not
  // apply (see the `vendorResumeId` param contract). A fresh spawn is never gated.
  if (!vendorResumeId) return;

  // A RESUME is requested and reachability is REQUIRED, but a gate input (cwd) is missing. This is a
  // plumbing fault, not a fresh spawn: returning here would SILENTLY disable the hard gate and let the
  // vendor launch resuming a path we never proved. Fail closed with the structured continuity reason
  // (same taxonomy as a genuine miss) instead of passing.
  const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
  if (!cwd) {
    throw new ConnectedServiceSpawnResumeUnreachableError({
      agentId: params.agentId,
      vendorResumeId,
      cwd: '',
      targetMaterializedRoot: resolveConnectedServiceTargetMaterializedRoot({
        agentId: params.agentId,
        targetMaterializedEnv: params.materializedEnv,
      }),
      reason: 'resume_reachability_inputs_missing',
    });
  }

  const reachability = await verifySpawnResumeReachability({
    agentId: params.agentId,
    vendorResumeId,
    cwd,
    materializedEnv: params.materializedEnv,
    candidatePersistedSessionFile: params.candidatePersistedSessionFile,
  });
  if (reachability.ok) return;

  throw new ConnectedServiceSpawnResumeUnreachableError({
    agentId: params.agentId,
    vendorResumeId,
    cwd,
    targetMaterializedRoot: resolveConnectedServiceTargetMaterializedRoot({
      agentId: params.agentId,
      targetMaterializedEnv: params.materializedEnv,
    }),
    reason: reachability.reason,
  });
}
