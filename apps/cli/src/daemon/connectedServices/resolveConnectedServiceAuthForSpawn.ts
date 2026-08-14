import {
  ConnectedServiceCredentialRevisionV1Schema,
  type AccountSettings,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceId,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { resolveConnectedServiceCredentialLifecycleDescriptor } from '@/backends/catalog';
import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

import {
  parseConnectedServiceBindingSelections,
  type ConnectedServiceBindingSelection,
  type ConnectedServicesBindingsV1,
} from './parseConnectedServicesBindings';
import { resolveConnectedServiceCredentialsWithRevisions } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
  materializeConnectedServicesForSpawn,
  type ConnectedServiceResolvedSelection,
} from './materialize/materializeConnectedServicesForSpawn';
import { createConnectedServiceGroupMutationCurrentnessValidator } from './credentials/createConnectedServiceGroupMutationCurrentnessValidator';
import { createConnectedServiceMaterializedTargetRootCleanup } from './materialize/createConnectedServiceMaterializedTargetRootCleanup';
import {
  collectBlockingConnectedServicesMaterializationDiagnostics,
  type ConnectedServicesMaterializationDiagnostic,
  type ConnectedServicesMaterializeResult,
} from './materialize/providerMaterializerTypes';
import { resolveConnectedServiceTargetMaterializedRoot } from './materialize/resolveConnectedServiceTargetMaterializedRoot';
import type { ConnectedServiceCredentialRefreshResult } from './refresh/ConnectedServiceRefreshCoordinator';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import type { RuntimeAccountIdentitySelectionInput } from './quotas/identity/runtimeAccountIdentityTypes';
import { selectConnectedServiceAuthGroupCandidate } from './accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from './accountGroups/selection/resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import {
  buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState,
} from './accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
  buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
  type AccountUsageStoreForAuthGroupSwitchState,
} from './accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import {
  ConnectedServiceAuthGroupQuotaProbeIncompleteError,
  type ConnectedServiceAuthGroupSwitchState,
} from './accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { evaluatePredictiveSoftSwitchPolicy } from './accountGroups/switching/predictiveSoftSwitchPolicy';
import type { ConnectedServiceRefreshFailureCategory } from './credentials/lifecycleTypes';
import { persistCredentialHealthForMaterializationFailure } from './refresh/refreshDiagnostics';
import { verifySpawnResumeReachability } from './verifySpawnResumeReachability';

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
}>;

type ConnectedServiceProfilesHealthApi = Readonly<{
  listConnectedServiceProfiles?: (params: Readonly<{ serviceId: ConnectedServiceId }>) => Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<Readonly<{
      profileId: string;
      status: ConnectedServiceCredentialHealthStatusV1;
    }>>;
  }>>;
}>;

type ConnectedServiceAuthGroupPreTurnSwitchCoordinator = Readonly<{
  switchBeforeTurn(params: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    observedProfileId?: string | null;
    deadlineAtMs?: number;
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
    force?: boolean;
  }>): Promise<ConnectedServiceCredentialRefreshResult>;
}>;

type ConnectedServiceAuthGroupPreTurnSwitchResult = Awaited<
  ReturnType<ConnectedServiceAuthGroupPreTurnSwitchCoordinator['switchBeforeTurn']>
>;

type AuthoritativeSpawnSwitchResult =
  | Readonly<{
      kind: 'authoritative';
      activeProfileId: string | null;
      generation: number | null;
    }>
  | Readonly<{ kind: 'requires_group_reread' }>
  | Readonly<{ kind: 'none' }>;

function readAuthoritativeSpawnSwitchResult(
  result: ConnectedServiceAuthGroupPreTurnSwitchResult,
): AuthoritativeSpawnSwitchResult {
  if (
    result.status === 'switched'
    || result.status === 'observed_generation'
    || result.status === 'superseded_after_apply'
  ) {
    return {
      kind: 'authoritative',
      activeProfileId: readProfileId(result.activeProfileId) || null,
      generation: typeof result.generation === 'number' && Number.isFinite(result.generation)
        ? result.generation
        : null,
    };
  }
  if (result.status === 'generation_apply_failed' || result.status === 'predictive_apply_unavailable') {
    return { kind: 'requires_group_reread' };
  }
  return { kind: 'none' };
}

export class ConnectedServiceSpawnAuthGroupAuthorityError extends Error {
  readonly kind: 'resolution_unavailable' | 'resolution_failed' | 'group_missing';
  readonly serviceId: ConnectedServiceId;
  readonly groupId: string;

  constructor(params: Readonly<{
    kind: ConnectedServiceSpawnAuthGroupAuthorityError['kind'];
    serviceId: ConnectedServiceId;
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

export class ConnectedServiceSpawnMaterializationError extends Error {
  readonly agentId: CatalogAgentId;
  readonly diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];

  constructor(params: Readonly<{
    agentId: CatalogAgentId;
    diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
  }>) {
    const primary = params.diagnostics[0];
    super(
      primary
        ? `Connected service materialization failed for ${params.agentId} (${primary.code})`
        : `Connected service materialization failed for ${params.agentId}`,
    );
    this.name = 'ConnectedServiceSpawnMaterializationError';
    this.agentId = params.agentId;
    this.diagnostics = params.diagnostics;
  }
}

function readProfileId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isReconnectRequiredRefreshCategory(category: ConnectedServiceRefreshFailureCategory | undefined): boolean {
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

function assertNoBlockingMaterializationDiagnostics(params: Readonly<{
  agentId: CatalogAgentId;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}>): void {
  const blocking = collectBlockingConnectedServicesMaterializationDiagnostics(params.diagnostics);
  if (blocking.length === 0) return;
  throw new ConnectedServiceSpawnMaterializationError({
    agentId: params.agentId,
    diagnostics: blocking,
  });
}

async function applySpawnPreflightRefresh(params: Readonly<{
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialRevisionsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRevisionV1 | null>;
  credentialBindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
  refreshService: ConnectedServiceSpawnCredentialRefreshService | null;
  nowMs: number;
  forceOauthRefresh: boolean;
}>): Promise<void> {
  for (const binding of params.credentialBindings) {
    const record = params.recordsByServiceId.get(binding.serviceId);
    if (!record || !shouldPreflightRefreshCredential(record)) continue;
    if (!params.refreshService) {
      if (typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) && record.expiresAt <= params.nowMs) {
        throw new ConnectedServiceSpawnCredentialRefreshError({
          kind: 'reconnect_required',
          diagnostic: {
            serviceId: binding.serviceId,
            profileId: binding.profileId,
            reason: 'spawn_preflight',
            status: 'refresh_failed',
            category: 'provider_401',
            expiresAt: record.expiresAt,
            expiryAgeMs: params.nowMs - record.expiresAt,
            refreshWindowMs: 0,
          },
        });
      }
      continue;
    }

    const result = await params.refreshService.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
      ...(params.forceOauthRefresh ? { force: true } : {}),
    });
    if (result.status === 'refreshed' && result.credential) {
      params.recordsByServiceId.set(binding.serviceId, result.credential);
      const revision = ConnectedServiceCredentialRevisionV1Schema.safeParse(result.credentialRevision);
      params.credentialRevisionsByServiceId.set(binding.serviceId, revision.success ? revision.data : null);
      continue;
    }
    const outcome = resolveSpawnRefreshOutcome({ result, record, nowMs: params.nowMs });
    if (outcome !== record) {
      params.recordsByServiceId.set(binding.serviceId, outcome);
    }
  }
}

/**
 * Canonical policy for a spawn-context credential refresh outcome — the SINGLE owner consumed by
 * BOTH the spawn preflight and the materialization-time refresh callback. Reconnect-required
 * failures and missing credentials always fail the spawn. TRANSIENT failures (non-reconnect
 * refresh_failed, lease_not_acquired) proceed on the CURRENT record while it is still clock-valid:
 * another refresher owns the rotation, and live application (scheduled loop / SDK callback / home
 * re-read) picks it up — failing here turned refresh-lease contention right after a daemon restart
 * into a user-visible "Failed to resume session" (live incident 2026-07-08 19:39). Expired records
 * still fail the spawn.
 */
function resolveSpawnRefreshOutcome(params: Readonly<{
  result: Awaited<ReturnType<ConnectedServiceSpawnCredentialRefreshService['refreshConnectedServiceCredentialForSpawnPreflight']>>;
  record: ConnectedServiceCredentialRecordV1;
  nowMs: number;
}>): ConnectedServiceCredentialRecordV1 {
  const { result, record, nowMs } = params;
  if (result.status === 'refreshed' && result.credential) {
    return result.credential;
  }
  if (result.status === 'refresh_failed') {
    if (isReconnectRequiredRefreshCategory(result.diagnostic.category)) {
      throw new ConnectedServiceSpawnCredentialRefreshError({
        kind: 'reconnect_required',
        diagnostic: result.diagnostic,
      });
    }
    if (isRecordStillUsableForSpawn(record, nowMs)) return record;
    throw new ConnectedServiceSpawnCredentialRefreshError({
      kind: 'transient_refresh_failed',
      diagnostic: result.diagnostic,
    });
  }
  if (result.status === 'credential_missing') {
    throw new ConnectedServiceSpawnCredentialRefreshError({
      kind: 'reconnect_required',
      diagnostic: result.diagnostic,
    });
  }
  if (result.status === 'lease_not_acquired') {
    if (isRecordStillUsableForSpawn(record, nowMs)) return record;
    throw new ConnectedServiceSpawnCredentialRefreshError({
      kind: 'transient_refresh_failed',
      diagnostic: result.diagnostic,
    });
  }
  return record;
}

function isRecordStillUsableForSpawn(record: ConnectedServiceCredentialRecordV1, nowMs: number): boolean {
  return typeof record.expiresAt !== 'number'
    || !Number.isFinite(record.expiresAt)
    || record.expiresAt > nowMs;
}

async function assertCredentialHealthAllowsSpawn(params: Readonly<{
  api: ApiClient;
  credentialBindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
}>): Promise<void> {
  const profilesApi = params.api as ConnectedServiceProfilesHealthApi;
  if (typeof profilesApi.listConnectedServiceProfiles !== 'function') return;

  const bindingsByServiceId = new Map<ConnectedServiceId, Set<string>>();
  for (const binding of params.credentialBindings) {
    const profileId = String(binding.profileId ?? '').trim();
    if (!profileId) continue;
    const existing = bindingsByServiceId.get(binding.serviceId);
    if (existing) {
      existing.add(profileId);
    } else {
      bindingsByServiceId.set(binding.serviceId, new Set([profileId]));
    }
  }

  for (const [serviceId, profileIds] of bindingsByServiceId.entries()) {
    const result = await profilesApi.listConnectedServiceProfiles({ serviceId });
    const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
    for (const profile of profiles) {
      if (!profileIds.has(profile.profileId)) continue;
      if (profile.status !== 'needs_reauth') continue;
      throw new ConnectedServiceSpawnCredentialRefreshError({
        kind: 'reconnect_required',
        diagnostic: {
          serviceId,
          profileId: profile.profileId,
          reason: 'spawn_preflight',
          status: 'refresh_failed',
          category: 'invalid_grant',
          expiresAt: null,
          expiryAgeMs: null,
          refreshWindowMs: 0,
        },
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

function isActiveGroupProfileUsageExhausted(
  state: ConnectedServiceAuthGroupSwitchState,
  nowMs: number,
): boolean {
  const activeState = state.activeProfileId
    ? state.memberStatesByProfileId.get(state.activeProfileId) ?? null
    : null;
  const activeRemaining = activeState?.quotaSnapshot?.effectiveRemainingPercent;
  return activeState?.quotaSnapshot?.exhausted === true
    || (typeof activeRemaining === 'number' && Number.isFinite(activeRemaining) && activeRemaining <= 0)
    || (typeof activeState?.quotaExhaustedUntilMs === 'number' && activeState.quotaExhaustedUntilMs > nowMs)
    || (typeof activeState?.rateLimitedUntilMs === 'number' && activeState.rateLimitedUntilMs > nowMs);
}

function buildSpawnSwitchState(params: Readonly<{
  group: ConnectedServiceAuthGroupV1;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  nowMs: number;
}>): ConnectedServiceAuthGroupSwitchState | null {
  if (params.accountUsageStore) {
    // CLOSE-11 contract: only an explicitly SOURCE-BACKED account-usage result carries canonical
    // authority; a provisional (cold-store) result degrades to the persisted-member projection.
    const accountUsageSwitchState = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group: params.group,
      accountUsageStore: params.accountUsageStore,
    });
    return accountUsageSwitchState.kind === 'source_backed'
      ? accountUsageSwitchState.state
      : buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({
        group: params.group,
      });
  }
  return buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({
    group: params.group,
  });
}

async function resolveAuthoritativeGroupAfterSpawnSwitchResult(params: Readonly<{
  group: ConnectedServiceAuthGroupResponse;
  serviceId: ConnectedServiceId;
  groupId: string;
  api: ConnectedServiceAuthGroupApi;
  result: ConnectedServiceAuthGroupPreTurnSwitchResult;
}>): Promise<ConnectedServiceAuthGroupResponse | null> {
  const authoritative = readAuthoritativeSpawnSwitchResult(params.result);
  if (authoritative.kind === 'none') return null;
  if (authoritative.kind === 'authoritative') {
    return {
      ...params.group,
      activeProfileId: authoritative.activeProfileId,
      generation: authoritative.generation ?? params.group.generation,
    };
  }
  if (typeof params.api.getConnectedServiceAuthGroup !== 'function') {
    throw new ConnectedServiceSpawnAuthGroupAuthorityError({
      kind: 'resolution_unavailable',
      serviceId: params.serviceId,
      groupId: params.groupId,
    });
  }
  let currentGroup: ConnectedServiceAuthGroupResponse | null;
  try {
    currentGroup = await params.api.getConnectedServiceAuthGroup({
      serviceId: params.serviceId,
      groupId: params.groupId,
    });
  } catch (cause) {
    throw new ConnectedServiceSpawnAuthGroupAuthorityError({
      kind: 'resolution_failed',
      serviceId: params.serviceId,
      groupId: params.groupId,
      cause,
    });
  }
  if (!currentGroup) {
    throw new ConnectedServiceSpawnAuthGroupAuthorityError({
      kind: 'group_missing',
      serviceId: params.serviceId,
      groupId: params.groupId,
    });
  }
  return currentGroup;
}

async function maybeSelectGroupActiveProfileForSpawn(params: Readonly<{
  group: ConnectedServiceAuthGroupResponse;
  serviceId: ConnectedServiceId;
  groupId: string;
  api: ConnectedServiceAuthGroupApi;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs: number;
  nowMs: number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  predictiveSoftSwitchMode: 'supported' | 'unsupported';
  quotaProbeDeadlineAtMs?: number;
}>): Promise<ConnectedServiceAuthGroupResponse> {
  if (!isFullAuthGroup(params.group)) return params.group;
  // Pre-spawn switches only happen through the injected switch coordinator FSM. There is no
  // direct active-profile API fallback: a raw write would be a lease-less, event-less parallel
  // switching mechanism invisible to switch telemetry and locking (RD-SW-4).
  if (!params.authGroupSwitchCoordinator) return params.group;

  const state = buildSpawnSwitchState({
    group: params.group,
    accountUsageStore: params.accountUsageStore,
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
    nowMs: params.nowMs,
  });
  if (!state) return params.group;
  if (!state.policy.autoSwitch) return params.group;
  const activeUsageExhausted = isActiveGroupProfileUsageExhausted(state, params.nowMs);
  const switchReason = activeUsageExhausted ? 'usage_limit' : 'soft_threshold';
  if (switchReason === 'soft_threshold' && !params.accountUsageStore) return params.group;
  const predictivePolicy = evaluatePredictiveSoftSwitchPolicy({
    context: 'pre_spawn',
    reason: switchReason,
    predictiveSoftSwitchMode: params.predictiveSoftSwitchMode,
  });
  if (predictivePolicy.status === 'suppress') return params.group;

  if (
    params.authGroupSwitchCoordinator
    && resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
      activeProfileId: state.activeProfileId,
      members: state.members,
      memberStatesByProfileId: state.memberStatesByProfileId,
      policy: state.policy,
      nowMs: params.nowMs,
      quotaFreshnessMs: params.quotaFreshnessMs,
      allowCurrentProfileRetry: true,
    }).length > 0
  ) {
    let switched: Awaited<ReturnType<ConnectedServiceAuthGroupPreTurnSwitchCoordinator['switchBeforeTurn']>>;
    try {
      switched = await params.authGroupSwitchCoordinator.switchBeforeTurn({
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        serviceId: params.serviceId,
        groupId: params.groupId,
        reason: switchReason,
        observedProfileId: state.activeProfileId,
        ...(params.quotaProbeDeadlineAtMs === undefined ? {} : { deadlineAtMs: params.quotaProbeDeadlineAtMs }),
      });
    } catch (error) {
      if (error instanceof ConnectedServiceAuthGroupQuotaProbeIncompleteError && switchReason === 'soft_threshold') {
        return params.group;
      }
      throw error;
    }
    const authoritative = await resolveAuthoritativeGroupAfterSpawnSwitchResult({
      group: params.group,
      serviceId: params.serviceId,
      groupId: params.groupId,
      api: params.api,
      result: switched,
    });
    if (authoritative) return authoritative;
    if (switched.status === 'no_eligible_member') {
      const authoritative = await maybeResolveAuthoritativeGroupForPreTurnUnavailableSwitch(params);
      if (authoritative) return authoritative;
    }
  }

  const selected = selectConnectedServiceAuthGroupCandidate({
    nowMs: params.nowMs,
    quotaFreshnessMs: params.quotaFreshnessMs,
    activeProfileId: state.activeProfileId,
    policy: state.policy,
    members: state.members,
    memberStatesByProfileId: state.memberStatesByProfileId,
    allowCurrentProfileRetry: true,
  });
  const selectedProfileId = selected.selected?.profileId ?? null;
  if (!selectedProfileId || selectedProfileId === readProfileId(state.activeProfileId)) return params.group;

  let switched: Awaited<ReturnType<ConnectedServiceAuthGroupPreTurnSwitchCoordinator['switchBeforeTurn']>>;
  try {
    switched = await params.authGroupSwitchCoordinator.switchBeforeTurn({
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      serviceId: params.serviceId,
      groupId: params.groupId,
      reason: switchReason,
      observedProfileId: state.activeProfileId,
      ...(params.quotaProbeDeadlineAtMs === undefined ? {} : { deadlineAtMs: params.quotaProbeDeadlineAtMs }),
    });
  } catch (error) {
    if (error instanceof ConnectedServiceAuthGroupQuotaProbeIncompleteError && switchReason === 'soft_threshold') {
      return params.group;
    }
    throw error;
  }
  const authoritative = await resolveAuthoritativeGroupAfterSpawnSwitchResult({
    group: params.group,
    serviceId: params.serviceId,
    groupId: params.groupId,
    api: params.api,
    result: switched,
  });
  if (authoritative) return authoritative;
  if (switched.status === 'no_eligible_member') {
    const authoritative = await maybeResolveAuthoritativeGroupForPreTurnUnavailableSwitch(params);
    if (authoritative) return authoritative;
  }
  return params.group;
}

async function maybeResolveAuthoritativeGroupForPreTurnUnavailableSwitch(params: Readonly<{
  group: ConnectedServiceAuthGroupResponse;
  serviceId: ConnectedServiceId;
  groupId: string;
  api: ConnectedServiceAuthGroupApi;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs: number;
  nowMs: number;
}>): Promise<ConnectedServiceAuthGroupResponse | null> {
  if (typeof params.api.getConnectedServiceAuthGroup !== 'function') return null;
  const currentGroup = await params.api.getConnectedServiceAuthGroup({
    serviceId: params.serviceId,
    groupId: params.groupId,
  }).catch(() => null);
  if (!currentGroup) return null;
  const activeProfileId = readProfileId(currentGroup.activeProfileId);
  if (!activeProfileId || activeProfileId === readProfileId(params.group.activeProfileId)) return null;
  if (!isAuthoritativeGroupActiveProfileEligible({
    group: currentGroup,
    activeProfileId,
    accountUsageStore: params.accountUsageStore,
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
    quotaFreshnessMs: params.quotaFreshnessMs,
    nowMs: params.nowMs,
  })) {
    return null;
  }
  return {
    ...params.group,
    activeProfileId,
    generation: typeof currentGroup.generation === 'number' && Number.isFinite(currentGroup.generation)
      ? currentGroup.generation
      : params.group.generation,
    ...(currentGroup.policy === undefined ? {} : { policy: currentGroup.policy }),
    ...(currentGroup.members === undefined ? {} : { members: currentGroup.members }),
  };
}

async function resolveCredentialBindings(params: Readonly<{
  api: ApiClient;
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs: number;
  nowMs: number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  predictiveSoftSwitchMode: 'supported' | 'unsupported';
  quotaProbeDeadlineAtMs?: number;
}>): Promise<Readonly<{
  credentialBindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
}>> {
  const credentialBindings: Array<{ serviceId: ConnectedServiceId; profileId: string }> = [];
  const groupSelections = new Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>();

  for (const selection of params.selections) {
    if (selection.kind === 'profile') {
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
      group,
      serviceId: selection.serviceId,
      groupId: selection.groupId,
      api: groupApi,
      accountUsageStore: params.accountUsageStore,
      runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
      quotaFreshnessMs: params.quotaFreshnessMs,
      nowMs: params.nowMs,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
      predictiveSoftSwitchMode: params.predictiveSoftSwitchMode,
      quotaProbeDeadlineAtMs: params.quotaProbeDeadlineAtMs,
    });
    const activeProfileId = readProfileId(selectedGroup.activeProfileId);
    if (!activeProfileId) {
      throw new Error(`Connected service auth group has no active profile (${selection.serviceId}/${selection.groupId})`);
    }
    credentialBindings.push({ serviceId: selection.serviceId, profileId: activeProfileId });
    groupSelections.set(selection.serviceId, {
      groupId: selection.groupId,
      activeProfileId,
      fallbackProfileId: selection.fallbackProfileId ?? activeProfileId,
      generation: typeof selectedGroup.generation === 'number' && Number.isFinite(selectedGroup.generation) ? selectedGroup.generation : 0,
      policy: selectedGroup.policy ?? null,
      memberCount: Array.isArray(selectedGroup.members)
        ? selectedGroup.members.filter((member) => member.enabled !== false).length
        : 1,
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
  memberCount: number;
}>;

function isAuthoritativeGroupActiveProfileEligible(params: Readonly<{
  group: ConnectedServiceAuthGroupResponse;
  activeProfileId: string;
  accountUsageStore: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs: number;
  nowMs: number;
}>): boolean {
  if (!isFullAuthGroup(params.group)) return false;
  const state = buildSpawnSwitchState({
    group: params.group,
    accountUsageStore: params.accountUsageStore,
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
    nowMs: params.nowMs,
  });
  if (!state) return false;
  const activeMembers = state.members.filter((member) => member.profileId === params.activeProfileId);
  if (activeMembers.length === 0) return false;
  const selected = selectConnectedServiceAuthGroupCandidate({
    nowMs: params.nowMs,
    quotaFreshnessMs: params.quotaFreshnessMs,
    activeProfileId: params.activeProfileId,
    policy: state.policy,
    members: activeMembers,
    memberStatesByProfileId: state.memberStatesByProfileId,
    allowCurrentProfileRetry: true,
  });
  return selected.selected?.profileId === params.activeProfileId;
}

async function maybeSwitchGroupAfterSpawnPreflightRefreshFailure(params: Readonly<{
  error: ConnectedServiceSpawnCredentialRefreshError;
  groupSelections: Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialRevisionsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRevisionV1 | null>;
  credentials: Credentials;
  api: ApiClient;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  quotaProbeDeadlineAtMs?: number;
}>): Promise<boolean> {
  if (params.error.kind !== 'reconnect_required') return false;
  const group = params.groupSelections.get(params.error.serviceId);
  if (!group || group.activeProfileId !== params.error.profileId) return false;
  return applyCanonicalSpawnFailureSwitch({
    serviceId: params.error.serviceId,
    observedProfileId: params.error.profileId,
    groupSelections: params.groupSelections,
    recordsByServiceId: params.recordsByServiceId,
    credentialRevisionsByServiceId: params.credentialRevisionsByServiceId,
    credentials: params.credentials,
    api: params.api,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
  });
}

async function applyCanonicalSpawnFailureSwitch(params: Readonly<{
  serviceId: ConnectedServiceId;
  observedProfileId: string;
  groupSelections: Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialRevisionsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRevisionV1 | null>;
  credentials: Credentials;
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
  const authoritative = await resolveAuthoritativeGroupAfterSpawnSwitchResult({
    group: {
      groupId: group.groupId,
      activeProfileId: group.activeProfileId,
      generation: group.generation,
      policy: group.policy,
    },
    serviceId: params.serviceId,
    groupId: group.groupId,
    api: params.api,
    result,
  });
  const activeProfileId = readProfileId(authoritative?.activeProfileId);
  if (!activeProfileId || activeProfileId === params.observedProfileId) return false;

  const resolved = await resolveConnectedServiceCredentialsWithRevisions({
    credentials: params.credentials,
    api: params.api,
    bindings: [{ serviceId: params.serviceId, profileId: activeProfileId }],
  });
  const credential = resolved.get(params.serviceId);
  if (!credential) return false;

  params.recordsByServiceId.set(params.serviceId, credential.record);
  params.credentialRevisionsByServiceId.set(params.serviceId, credential.credentialRevision);
  params.groupSelections.set(params.serviceId, {
    ...group,
    activeProfileId,
    generation: typeof authoritative?.generation === 'number'
      ? authoritative.generation
      : group.generation,
  });
  return true;
}

async function maybeSwitchGroupAfterSpawnMaterializationFailure(params: Readonly<{
  error: ConnectedServiceSpawnMaterializationError;
  groupSelections: Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialRevisionsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRevisionV1 | null>;
  credentials: Credentials;
  api: ApiClient;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
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
    now: params.nowMs,
  });
  return applyCanonicalSpawnFailureSwitch({
    serviceId,
    observedProfileId: group.activeProfileId,
    groupSelections: params.groupSelections,
    recordsByServiceId: params.recordsByServiceId,
    credentialRevisionsByServiceId: params.credentialRevisionsByServiceId,
    credentials: params.credentials,
    api: params.api,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
  });
}

function buildCurrentSpawnCredentialBindings(params: Readonly<{
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
}>): ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }> {
  return params.selections.map((selection) => {
    if (selection.kind === 'profile') {
      return { serviceId: selection.serviceId, profileId: selection.profileId };
    }
    const profileId = params.groupSelections.get(selection.serviceId)?.activeProfileId
      ?? selection.fallbackProfileId;
    if (!profileId) {
      throw new Error(`Connected-service group ${selection.groupId} has no resolved active profile`);
    }
    return { serviceId: selection.serviceId, profileId };
  });
}

/**
 * CS-FIX-2: the spawn-path materialization-failure health write must PROPAGATE the real failure
 * category from the diagnostic instead of fabricating `provider_403`/`needs_reauth` for every
 * blocking diagnostic. A non-auth blocking failure (e.g. a shared-state link/disk/manifest class)
 * would otherwise silently mis-latch the profile `needs_reauth` with a synthesized HTTP 403 that no
 * provider ever returned — the exact silent wrong-latch class that hides healthy accounts.
 *
 * This routes through the single canonical health-write owner
 * (`persistCredentialHealthForMaterializationFailure`), which classifies the diagnostic via the
 * shared taxonomy and only latches `needs_reauth` for genuinely auth/permission diagnostics; other
 * blocking reasons keep their true category as a non-latching `refresh_failed_retryable` status.
 */
export async function persistMaterializationFailureCredentialHealthForSpawn(params: Readonly<{
  api: ApiClient;
  serviceId: ConnectedServiceId;
  profileId: string;
  diagnostic: ConnectedServicesMaterializationDiagnostic;
  now?: number;
}>): Promise<void> {
  await persistCredentialHealthForMaterializationFailure({
    api: params.api,
    binding: { serviceId: params.serviceId, profileId: params.profileId },
    diagnostic: params.diagnostic,
    now: params.now ?? Date.now(),
  });
}

function buildSelectionsByServiceIdForSpawn(params: Readonly<{
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialRevisionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRevisionV1 | null>;
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
        credentialRevision: params.credentialRevisionsByServiceId.get(selection.serviceId) ?? null,
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
      credentialRevision: params.credentialRevisionsByServiceId.get(selection.serviceId) ?? null,
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
    };
  }

  return {
    v: 1,
    bindingsByServiceId,
  };
}

function buildRuntimeAccountIdentitySelectionsForSpawn(
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>,
): RuntimeAccountIdentitySelectionInput[] {
  return Array.from(selectionsByServiceId.values()).map((selection) => {
    if (selection.kind === 'group') {
      return {
        serviceId: selection.serviceId,
        profileId: selection.activeProfileId,
        groupId: selection.groupId,
        groupGeneration: selection.generation,
        record: selection.record,
        source: 'spawn_selection',
      };
    }
    return {
      serviceId: selection.serviceId,
      profileId: selection.profileId,
      groupId: null,
      groupGeneration: null,
      record: selection.record,
      source: 'spawn_selection',
    };
  });
}

function resolveMaxSpawnMaterializationAttempts(
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>,
): number {
  const groupMemberCounts = Array.from(groupSelections.values())
    .map((group) => group.memberCount)
    .filter((count) => Number.isInteger(count) && count > 0);
  return Math.max(1, ...groupMemberCounts);
}

async function materializeAndVerifyConnectedServiceAuthForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1 | null;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialRevisionsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRevisionV1 | null>;
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  accountSettings: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv: NodeJS.ProcessEnv;
  refreshService: ConnectedServiceSpawnCredentialRefreshService | null;
  forceOauthRefresh: boolean;
  nowMs: number;
  vendorResumeId: string | null;
  resumeReachabilityRequired: boolean;
  candidatePersistedSessionFile: string | null;
  validateGroupMutationCurrentness: ReturnType<typeof createConnectedServiceGroupMutationCurrentnessValidator>;
}>): Promise<ConnectedServicesMaterializeResult | null> {
  const materialized = await materializeConnectedServicesForSpawn({
    agentId: params.agentId,
    materializationKey: params.materializationKey,
    connectedServiceMaterializationIdentityV1: params.connectedServiceMaterializationIdentityV1,
    activeServerDir: params.activeServerDir,
    baseDir: params.baseDir,
    sessionDirectory: params.sessionDirectory,
    recordsByServiceId: params.recordsByServiceId,
    selectionsByServiceId: params.selectionsByServiceId,
    refreshCredentialForMaterialization: params.refreshService
      ? async ({ serviceId, profileId, record }) => {
          const result = await params.refreshService!.refreshConnectedServiceCredentialForSpawnPreflight({
            serviceId,
            profileId,
            ...(params.forceOauthRefresh ? { force: true } : {}),
          });
          const refreshed = resolveSpawnRefreshOutcome({ result, record, nowMs: params.nowMs });
          if (!refreshed) return null;
          const revision = ConnectedServiceCredentialRevisionV1Schema.safeParse(result.credentialRevision);
          params.credentialRevisionsByServiceId.set(serviceId, revision.success ? revision.data : null);
          return {
            record: refreshed,
            credentialRevision: revision.success ? revision.data : null,
          };
        }
      : null,
    accountSettings: params.accountSettings,
    processEnv: params.processEnv,
    vendorResumeId: params.vendorResumeId,
    candidatePersistedSessionFile: params.candidatePersistedSessionFile,
    validateGroupMutationCurrentness: params.validateGroupMutationCurrentness,
  });

  if (!materialized) return null;

  try {
    assertNoBlockingMaterializationDiagnostics({
      agentId: params.agentId,
      diagnostics: materialized.diagnostics,
    });
    await assertSpawnResumeReachable({
      agentId: params.agentId,
      materializedEnv: materialized.env,
      vendorResumeId: params.vendorResumeId,
      cwd: params.sessionDirectory,
      resumeReachabilityRequired: params.resumeReachabilityRequired,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile,
    });
    return materialized;
  } catch (error) {
    const cleanupOnFailure = materialized.cleanupOnFailure
      ?? createConnectedServiceMaterializedTargetRootCleanup({
        agentId: params.agentId,
        env: materialized.env,
      });
    cleanupOnFailure?.();
    throw error;
  }
}

export async function resolveConnectedServiceAuthForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  sessionDirectory?: string | null;
  connectedServicesBindingsRaw: unknown;
  materializationKey: string;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  activeServerDir: string;
  baseDir: string;
  credentials: Credentials;
  api: ApiClient;
  accountUsageStore?: AccountUsageStoreForAuthGroupSwitchState | null;
  runtimeQuotaSnapshots?: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs?: number;
  nowMs?: () => number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  quotaProbeDeadlineAtMs?: number;
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
  runtimeAccountIdentitySelections: ReadonlyArray<RuntimeAccountIdentitySelectionInput>;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}> | null> {
  const selections = parseConnectedServiceBindingSelections(params.connectedServicesBindingsRaw);
  if (selections.length === 0) return null;
  const nowMs = (params.nowMs ?? (() => Date.now()))();
  const credentialLifecycleDescriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(params.agentId);
  const forceSpawnPreflightOauthRefresh =
    credentialLifecycleDescriptor.spawnPreflightOauthRefresh.mode === 'force';

  const resolvedBindings = await resolveCredentialBindings({
    api: params.api,
    selections,
    accountUsageStore: params.accountUsageStore ?? null,
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots ?? null,
    quotaFreshnessMs: params.quotaFreshnessMs ?? 5 * 60_000,
    nowMs,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
    predictiveSoftSwitchMode: credentialLifecycleDescriptor.predictiveSoftSwitch.mode,
    quotaProbeDeadlineAtMs: params.quotaProbeDeadlineAtMs,
  });

  const resolvedCredentials = await resolveConnectedServiceCredentialsWithRevisions({
      credentials: params.credentials,
      api: params.api,
      bindings: resolvedBindings.credentialBindings,
    });
  const recordsByServiceId = new Map(Array.from(
    resolvedCredentials,
    ([serviceId, resolved]) => [serviceId, resolved.record],
  ));
  const credentialRevisionsByServiceId = new Map(Array.from(
    resolvedCredentials,
    ([serviceId, resolved]) => [serviceId, resolved.credentialRevision],
  ));
  const groupSelections = new Map(resolvedBindings.groupSelections);
  const maxPreflightAttempts = resolveMaxSpawnMaterializationAttempts(groupSelections);
  for (let attempt = 0; attempt < maxPreflightAttempts; attempt += 1) {
    const credentialBindings = buildCurrentSpawnCredentialBindings({ selections, groupSelections });
    try {
      await assertCredentialHealthAllowsSpawn({
        api: params.api,
        credentialBindings,
      });
      await applySpawnPreflightRefresh({
        recordsByServiceId,
        credentialRevisionsByServiceId,
        credentialBindings,
        refreshService: params.credentialRefreshService ?? null,
        nowMs,
        forceOauthRefresh: forceSpawnPreflightOauthRefresh,
      });
      break;
    } catch (error) {
      if (!(error instanceof ConnectedServiceSpawnCredentialRefreshError)) throw error;
      if (attempt >= maxPreflightAttempts - 1) throw error;
      const switched = await maybeSwitchGroupAfterSpawnPreflightRefreshFailure({
        error,
        groupSelections,
        recordsByServiceId,
        credentialRevisionsByServiceId,
        credentials: params.credentials,
        api: params.api,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
      });
      if (!switched) throw error;
    }
  }
  const maxMaterializationAttempts = resolveMaxSpawnMaterializationAttempts(groupSelections);
  for (let attempt = 0; attempt < maxMaterializationAttempts; attempt += 1) {
    const selectionsByServiceId = buildSelectionsByServiceIdForSpawn({
      selections,
      recordsByServiceId,
      credentialRevisionsByServiceId,
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
        connectedServiceMaterializationIdentityV1: params.connectedServiceMaterializationIdentityV1 ?? null,
        activeServerDir: params.activeServerDir,
        baseDir: params.baseDir,
        sessionDirectory: params.sessionDirectory ?? null,
        recordsByServiceId,
        credentialRevisionsByServiceId,
        selectionsByServiceId,
        accountSettings: params.accountSettings ?? null,
        processEnv: params.processEnv ?? process.env,
        refreshService: params.credentialRefreshService ?? null,
        forceOauthRefresh: forceSpawnPreflightOauthRefresh,
        nowMs,
        vendorResumeId: params.vendorResumeId ?? null,
        resumeReachabilityRequired: params.resumeReachabilityRequired ?? false,
        candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
        validateGroupMutationCurrentness: createConnectedServiceGroupMutationCurrentnessValidator({
          api: params.api,
          credentials: params.credentials,
        }),
      });
      if (materialized === null) return null;
      return {
        ...materialized,
        connectedServicesBindings,
        runtimeAccountIdentitySelections: buildRuntimeAccountIdentitySelectionsForSpawn(selectionsByServiceId),
      };
    } catch (error) {
      if (!(error instanceof ConnectedServiceSpawnMaterializationError)) throw error;
      if (attempt >= maxMaterializationAttempts - 1) throw error;
      const switched = await maybeSwitchGroupAfterSpawnMaterializationFailure({
        error,
        groupSelections,
        recordsByServiceId,
        credentialRevisionsByServiceId,
        credentials: params.credentials,
        api: params.api,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
        nowMs,
      });
      if (!switched) throw error;
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
