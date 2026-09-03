import {
  ConnectedServiceIdSchema,
  isConnectedServiceCredentialHealthStatusUsable,
  type ConnectedServiceAuthGroupRuntimeStatePatchRequestV1,
  type ConnectedServiceAuthGroupV1,
  openConnectedServiceCredentialCiphertext,
  openConnectedServiceQuotaSnapshotCiphertext,
  openProviderAccountUsageSnapshotCiphertext,
  projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1,
  sealProviderAccountUsageSnapshotCiphertext,
  type ConnectedServiceCredentialHealthV1,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceId,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
  type ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import {
  invalidateConnectedServiceAccountMode,
  resolveConnectedServiceAccountMode,
  type ConnectedServiceAccountMode,
} from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import {
  createKeyedBackoffTracker,
} from '@/api/connection/scheduling';
import {
  classifyDaemonServerWorkError,
  type DaemonServerWorkGate,
  type DaemonServerWorkGateResult,
  type DaemonServerWorkOutcome,
  type DaemonServerWorkScheduler,
} from '@/daemon/serverWork';

import {
  readConnectedServiceChildSelectionsFromEnv,
  type ConnectedServiceChildSelection,
} from '../../connectedServiceChildEnvironment';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  normalizeConnectedServiceAuthGroupPolicy,
} from '../../accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
  buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
  resolveAccountUsageSnapshotsByGroupProfile,
  type AccountUsageStoreForAuthGroupSwitchState,
  type ConnectedServiceUsageSourceRecordRef,
} from '../../accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import {
  hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason,
  isConnectedServiceAuthGroupSoftSwitchCandidateMeaningfullyBetter,
  resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence,
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupMemberRuntimeState,
} from '../../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { reconcileMemberRuntimeStateWithFreshQuotaEvidence } from '../../accountGroups/memberRuntimeState';
import type { ConnectedServiceQuotaCredentialRefreshOutcome } from '../../refresh/refreshTypes';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher } from '../types';
import {
  buildQuotaPersistenceKey,
  resolveQuotaPersistenceAccountScope,
  type QuotaPersistenceAccountScope,
} from '../quotaPersistenceKey';
import {
  computeQuotaSnapshotFingerprint,
  deriveQuotaSnapshotFingerprintHmacKey,
} from '../quotaSnapshotFingerprint';
import { shouldPersistQuotaSnapshot, type ShouldPersistQuotaSnapshotStatus } from '../shouldPersistQuotaSnapshot';
import {
  createConnectedServiceQuotaPersistenceScheduler,
  type ConnectedServiceQuotaPersistenceFlushResult as InProcessQuotaPersistenceFlushResult,
  type ConnectedServiceQuotaPersistenceScheduler,
} from '../createConnectedServiceQuotaPersistenceScheduler';
import {
  reconcileIndexedSameAccountFanoutCandidates,
} from '../identity/reconcileIndexedSameAccountFanoutCandidates';
import {
  resolveRuntimeAccountIdentityFanoutMatch,
} from '../identity/resolveRuntimeAccountIdentityFanoutMatch';
import { resolveSessionsSharingProviderAccount } from '../identity/resolveSessionsSharingProviderAccount';
import {
  requiresExactProviderAccountFanout,
  type ConnectedServiceSameAccountFanoutStrategy,
} from '../identity/providerFanoutStrategy';
import type {
  ReconciledRuntimeAccountIdentityEntry,
  RuntimeAccountIdentityEntry,
  RuntimeAccountIdentityProbeResult,
  RuntimeAccountIdentityRecordInput,
  RuntimeAccountIdentityRecordResult,
  RuntimeAccountIdentitySelectionInput,
  RuntimeAccountIdentitySource,
} from '../identity/runtimeAccountIdentityTypes';
import {
  resolveQuotaProbeFreshProof,
  type QuotaProbeFreshProofResult,
} from '../proof/quotaProbeFreshProof';
import type { ConnectedServiceRuntimeAuthApplyCapability } from '../../credentials/lifecycleTypes';
import { evaluateConnectedServiceSwitchApplyPolicy } from '../../accountGroups/switching/predictiveSoftSwitchPolicy';
import {
  ConnectedServiceRuntimeRegistry,
  type ConnectedServiceRuntimeQuotaTarget,
} from '../../runtimeRegistry/registry';
import type { ProviderAccountUsageStore } from '../../accountUsage/store';
import type { ProviderAccountUsagePersistenceScheduler } from '../../accountUsage/persistence';
import {
  evaluateConnectedServiceAuthGroupQuotaLifecycle,
  type ConnectedServiceAuthGroupQuotaLifecycleState,
} from '../../accountGroups/quotas/lifecycle';
import {
  buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation,
} from '../../accountUsage/fromConnectedServiceQuotaObservation';
import {
  authorizeProviderAccountUsageObservation,
  canRecordProviderAccountUsageSourceLinks,
} from '../../accountUsage/record';
import { computeProviderAccountUsageSnapshotFingerprint } from '../../accountUsage/fingerprint';

export const DEFAULT_QUOTA_PERSISTENCE_MIN_FRESHNESS_REFRESH_MS = 60_000;
export const ACCOUNT_MODE_UNKNOWN_RETRY_AFTER_MS = 30_000;
export const SAME_ACCOUNT_FANOUT_RESET_BUCKET_MS = 60_000;

export type ConnectedServicesBindingsV1Like = Readonly<{
  v?: unknown;
  bindingsByServiceId?: Record<string, unknown>;
}>;

export type QuotaApi = Readonly<{
  getAccountEncryptionMode?: () => Promise<ConnectedServiceAccountMode>;
  getAccountEncryptionModeUncached?: (options?: Readonly<{ signal?: AbortSignal }>) => Promise<ConnectedServiceAccountMode>;
  getConnectedServiceQuotaSnapshotSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string; signal?: AbortSignal }>) => Promise<
    | null
    | Readonly<{
        sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
        metadata: Readonly<{
          fetchedAt: number;
          staleAfterMs: number;
          status: 'ok' | 'unavailable' | 'estimated' | 'error';
          refreshRequestedAt?: number;
          materialFingerprint?: string;
        }>;
      }>
  >;
  getConnectedServiceQuotaSnapshotPlain?: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string; signal?: AbortSignal }>) => Promise<
    | null
    | Readonly<{
        content: Readonly<{ t: 'plain'; v: ConnectedServiceQuotaSnapshotV1 }>;
        metadata: Readonly<{
          fetchedAt: number;
          staleAfterMs: number;
          status: 'ok' | 'unavailable' | 'estimated' | 'error';
          refreshRequestedAt?: number;
          materialFingerprint?: string;
        }>;
      }>
  >;
  getConnectedServiceCredentialSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string; signal?: AbortSignal }>) => Promise<
    | null
    | Readonly<{
        sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
        metadata: Readonly<{ kind: string }>;
      }>
  >;
  getConnectedServiceCredentialPlain?: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string; signal?: AbortSignal }>) => Promise<
    | null
    | Readonly<{
        content: Readonly<{ t: 'plain'; v: ConnectedServiceCredentialRecordV1 }>;
      }>
  >;
  listConnectedServiceProfiles?: (args: Readonly<{ serviceId: ConnectedServiceId }>) => Promise<
    Readonly<{
      serviceId: ConnectedServiceId;
      profiles: ReadonlyArray<
        Readonly<{
          profileId: string;
          status: ConnectedServiceCredentialHealthStatusV1;
        }>
      >;
    }>
  >;
  registerProviderAccountUsageSnapshotSealed?: (args: Readonly<{
    recordId: string;
    recordKey: ProviderAccountUsageRecordKeyV1;
    source?: ConnectedServiceUsageSourceV1;
    sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
    metadata: Readonly<{ fetchedAt: number; staleAfterMs: number; status: 'ok' | 'unavailable' | 'estimated' | 'error'; materialFingerprint?: string }>;
  }>) => Promise<void>;
  registerProviderAccountUsageSnapshotPlain?: (args: Readonly<{
    recordId: string;
    source?: ConnectedServiceUsageSourceV1;
    content: Readonly<{ t: 'plain'; v: ProviderAccountUsageSnapshotV1 }>;
    metadata: Readonly<{ fetchedAt: number; staleAfterMs: number; status: 'ok' | 'unavailable' | 'estimated' | 'error'; materialFingerprint?: string }>;
  }>) => Promise<void>;
  acquireConnectedServiceRefreshLease?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    machineId: string;
    ownerId?: string;
    leaseMs: number;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ acquired: boolean; leaseUntil: number }>>;
  updateConnectedServiceCredentialHealth?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    health: ConnectedServiceCredentialHealthV1;
    expectedCredentialRevision?: string;
  }>) => Promise<unknown>;
  getConnectedServiceAuthGroup?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    signal?: AbortSignal;
  }>) => Promise<ConnectedServiceAuthGroupV1 | null>;
  updateConnectedServiceAuthGroupRuntimeState?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    expectedGeneration: number;
    expectedRuntimeStateRevision: number;
    memberStates: ReadonlyArray<Readonly<ConnectedServiceAuthGroupRuntimeStatePatchRequestV1['memberStates'][number]>>;
  }>) => Promise<ConnectedServiceAuthGroupV1>;
}>;

export type ExistingQuotaSnapshotResponse =
  | Awaited<ReturnType<QuotaApi['getConnectedServiceQuotaSnapshotSealed']>>
  | Awaited<ReturnType<NonNullable<QuotaApi['getConnectedServiceQuotaSnapshotPlain']>>>;

export type ResolvedQuotaStorageMode = 'e2ee' | 'plain';
export type ResolvedExistingQuotaSnapshot = Readonly<{
  storageMode: ResolvedQuotaStorageMode;
  existing: ExistingQuotaSnapshotResponse;
}>;
export type ConnectedServiceInBandQuotaSnapshotRecordResult =
  | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
  | Readonly<{ status: 'suppressed'; reason: string }>
  | Readonly<{ status: 'persisted' }>
  | Readonly<{ status: 'deferred_unknown_mode' }>;

export type ConnectedServiceQuotaPersistenceFlushResult = Readonly<{
  timedOut: boolean;
  inProcess: InProcessQuotaPersistenceFlushResult;
  serverWork: Readonly<{ timedOut: boolean }> | null;
}>;

export type InBandQuotaPersistencePayload = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  snapshot: ConnectedServiceQuotaSnapshotV1;
  materialFingerprint: string;
  status: ShouldPersistQuotaSnapshotStatus;
}>;

export type PersistedInBandQuotaState = Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1;
  fingerprint: string | null;
  status: ShouldPersistQuotaSnapshotStatus;
  fetchedAt: number;
  refreshRequestedAt?: number;
}>;

export type SpawnTarget = ConnectedServiceRuntimeQuotaTarget;

export type RuntimeAccountIdentityReader = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  expectedGroupGeneration: number | null;
}>) => Promise<RuntimeAccountIdentityProbeResult>;

export type ActiveSameAccountFanoutCandidate = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  groupGeneration: number | null;
}>;
export type ReconciledColdSameAccountFanoutCandidates = Readonly<{
  activeCandidateCount: number;
  candidates: ReadonlyArray<ReconciledRuntimeAccountIdentityEntry>;
}>;
export type GroupProfileAccountUsageEvidence = Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  source: ConnectedServiceUsageSourceV1;
  sourceRef: ConnectedServiceUsageSourceRecordRef | null;
}>;
export type GroupSwitchTargetEligibility =
  | Readonly<{
      status: 'unknown';
      reason: 'missing_group_reader' | 'group_resolution_failed' | 'selection_unknown' | 'source_account_usage_unavailable' | 'source_quota_unavailable';
      decisionTrace?: unknown;
    }>
  | Readonly<{
      status: 'eligible';
      sourceProfileId?: string | null;
      sourceRemainingPercent?: number;
      sourceThresholdPercent?: number;
      /** PS-1: true when the source only tripped the threshold via burn projection (preemptive), false when observed at/below it (reactive). */
      sourceProjected?: boolean;
      selectedProfileId?: string;
      selectedRemainingPercent?: number | null;
      decisionTrace?: unknown;
    }>
  | Readonly<{ status: 'no_eligible_target'; retryAfterMs: number | null; decisionTrace?: unknown }>
  | Readonly<{ status: 'no_meaningfully_better_target'; retryAfterMs: number | null; decisionTrace?: unknown }>;

export type ProfileHealthByServiceId = Map<ConnectedServiceId, Map<string, ConnectedServiceCredentialHealthStatusV1>>;
export type ActiveConnectedServiceBinding = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId?: string;
  groupGeneration?: number | null;
}>;
export type ActiveGroupQuotaSwitchTarget = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string;
  groupGeneration: number | null;
}>;
export type ConnectedServiceQuotaGroupContext = Readonly<{
  groupId: string;
  groupGeneration: number | null;
}>;
export type QuotaWorkPhase = 'tick' | 'hydrate_group' | 'probe_group' | 'soft_switch' | 'same_account_fanout';

export function trimConnectedServiceQuotaString(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeConnectedServiceQuotaGeneration(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

export function buildConnectedServiceUsageSourceKey(input: ConnectedServiceUsageSourceV1): string {
  return input.bindingKind === 'profile'
    ? ['profile', input.serviceId, input.profileId.trim()].join('\u0000')
    : [
      'group_member',
      input.serviceId,
      input.profileId.trim(),
      input.groupId.trim(),
      normalizeConnectedServiceQuotaGeneration(input.groupGeneration) ?? '',
    ].join('\u0000');
}

export type ConnectedServiceQuotaRecoveryCreditConsumeResult =
  | Readonly<{
      ok: true;
      snapshot: ConnectedServiceQuotaSnapshotV1 | null;
      receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1;
    }>
  | Readonly<{
      ok: false;
      errorCode: string;
      error: string;
      receipt?: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1;
    }>;
export type ConnectedServiceQuotaCoordinatorDiagnostic = Readonly<{
  event: 'quota_work_deferred' | 'quota_work_suppressed' | 'quota_work_requested';
  phase: QuotaWorkPhase;
  reason: string;
  retryAfterMs?: number;
  sessionId?: string;
  serviceId?: ConnectedServiceId;
  groupId?: string;
  activeProfileId?: string;
  eligibilityStatus?: GroupSwitchTargetEligibility['status'];
  sourceProfileId?: string | null;
  sourceRemainingPercent?: number;
  sourceThresholdPercent?: number;
  sourceProjected?: boolean;
  selectedProfileId?: string;
  selectedRemainingPercent?: number | null;
  targetCount?: number;
  completedTargetCount?: number;
  incompleteProfileIds?: ReadonlyArray<string>;
  allowedTargetCount?: number;
  durationMs?: number;
  probeOutcome?: 'complete' | 'incomplete';
  expectedProviderAccountId?: string | null;
  actualProviderAccountId?: string | null;
  expectedProfileId?: string;
  actualProfileId?: string | null;
  expectedGroupId?: string;
  actualGroupId?: string | null;
  expectedGroupGeneration?: number | null;
  actualGroupGeneration?: number | null;
  probeStatus?: RuntimeAccountIdentityProbeResult['status'];
  probeReason?: string | null;
  decisionTrace?: unknown;
}>;
export type SameAccountFanoutProofSource =
  | 'runtime_auth_failure_report'
  | 'runtime_identity_index'
  | 'runtime_identity_probe'
  | 'registry_binding'
  | 'persisted_materialization_identity';
export type SameAccountFanoutDecisionTrace = Readonly<{
  proofSource: SameAccountFanoutProofSource;
  sameAccountFanoutStrategy?: ConnectedServiceSameAccountFanoutStrategy;
  proofKind?: 'registry_binding' | 'runtime_exact' | 'runtime_identity_index' | 'runtime_auth_failure_report' | 'persisted_materialization_identity';
  sourceSessionId: string;
  sourceProfileId: string;
  expectedGroupGeneration: number | null;
  proofSourcesTried?: readonly SameAccountFanoutProofSource[];
}>;
export type AuthGroupSwitchCoordinator = Readonly<{
  switchBeforeTurn(input: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    observedProfileId?: string | null;
    deferUntilTurnBoundary?: boolean;
  }>): Promise<unknown>;
  applyCommittedGeneration?(input: Readonly<{
    sessionId: string;
    serviceId: string;
    groupId: string;
    activeProfileId: string;
    generation: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    reason: string;
    fromProfileId?: string | null;
  }>): Promise<Readonly<{
    status: string;
    activeProfileId?: string | null;
    generation: number;
    errorCode?: string;
  }>>;
}>;
export type ConnectedServiceSameAccountFanoutStrategyResolver = (input: Readonly<{
  sourceSessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
}>) => ConnectedServiceSameAccountFanoutStrategy | Promise<ConnectedServiceSameAccountFanoutStrategy>;
export type ConnectedServiceRuntimeAuthApplyCapabilityResolver = (input: Readonly<{
  sourceSessionId: string;
  targetSessionId?: string;
  serviceId: ConnectedServiceId;
  groupId: string;
}>) => ConnectedServiceRuntimeAuthApplyCapability | Promise<ConnectedServiceRuntimeAuthApplyCapability>;

/**
 * RD-QUO-13: edge-triggered quota lifecycle transition emitted by the coordinator.
 *
 * `blocked` fires once when fresh evidence shows a group has NO immediately eligible
 * member (every member limited/disabled) while group-bound sessions exist; `recovered`
 * fires once when a later eligibility pass frees a member (F7 fresh-quota clearing).
 * Producers built on this hook stay host-side and provider-agnostic.
 */
export type ConnectedServiceQuotaLifecycleTransition = Readonly<{
  phase: 'blocked' | 'recovered';
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string | null;
  sessionIds: ReadonlyArray<string>;
  cycleId: string;
  issueFingerprint: string;
  resetAtMs: number | null;
  reason: string;
}>;
export type ConnectedServiceQuotaLifecycleListener = (
  transition: ConnectedServiceQuotaLifecycleTransition,
) => void | Promise<void>;

export type SoftSwitchPolicyGuardResult =
  | Readonly<{ status: 'allow' }>
  | Readonly<{ status: 'suppress'; reason: string }>;
export type ConnectedServiceQuotaSoftSwitchPolicyGuard = (
  input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    reason: 'soft_threshold';
  }>,
) => SoftSwitchPolicyGuardResult | Promise<SoftSwitchPolicyGuardResult>;

export function buildResolvedSelectionProfilesByServiceId(
  env: Pick<NodeJS.ProcessEnv, string> | undefined,
): ReadonlyMap<ConnectedServiceId, ConnectedServiceChildSelection> {
  const selections = env ? readConnectedServiceChildSelectionsFromEnv(env) : [];
  return new Map(selections.map((selection) => [selection.serviceId, selection]));
}

export function resolveProfileIdFromSelection(input: Readonly<{
  binding: Record<string, unknown>;
  serviceId: ConnectedServiceId;
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceChildSelection>;
}>): string {
  const selection = input.selectionsByServiceId.get(input.serviceId);
  const explicitProfileId = typeof input.binding.profileId === 'string' ? String(input.binding.profileId).trim() : '';
  const groupId = typeof input.binding.groupId === 'string' ? String(input.binding.groupId).trim() : '';
  if (groupId) {
    if (!selection || selection.kind !== 'group') return explicitProfileId;
    if (selection.groupId !== groupId) return explicitProfileId;
    return selection.activeProfileId;
  }

  if (explicitProfileId) return explicitProfileId;
  if (!selection || selection.kind !== 'profile') return '';
  return selection.profileId;
}

export function extractActiveBindings(
  raw: ConnectedServicesBindingsV1Like,
  connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string>,
): ActiveConnectedServiceBinding[] {
  const out: ActiveConnectedServiceBinding[] = [];
  const selectionsByServiceId = buildResolvedSelectionProfilesByServiceId(connectedServiceSelectionsEnv);
  const bindings = raw?.bindingsByServiceId ?? {};
  for (const [serviceId, binding] of Object.entries(bindings)) {
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(serviceId);
    if (!parsedServiceId.success) continue;
    const bindingObj = binding && typeof binding === 'object' ? (binding as Record<string, unknown>) : null;
    const source = typeof bindingObj?.source === 'string' ? String(bindingObj.source) : '';
    if (source !== 'connected') continue;
    if (!bindingObj) continue;
    const profileId = resolveProfileIdFromSelection({
      binding: bindingObj,
      serviceId: parsedServiceId.data,
      selectionsByServiceId,
    });
    if (!profileId.trim()) continue;
    const selection = selectionsByServiceId.get(parsedServiceId.data);
    const groupId = selection?.kind === 'group' && selection.activeProfileId === profileId
      ? selection.groupId.trim()
      : '';
    out.push({
      serviceId: parsedServiceId.data,
      profileId,
      ...(groupId ? { groupId } : {}),
      ...(selection?.kind === 'group' && groupId ? { groupGeneration: selection.generation } : {}),
    });
  }
  return out;
}

export function activeBindingMatchesRuntimeIdentity(
  binding: ActiveConnectedServiceBinding,
  identity: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    groupId?: string | null;
    groupGeneration?: number | null;
    source?: RuntimeAccountIdentitySource;
  }>,
): boolean {
  if (binding.serviceId !== identity.serviceId) return false;

  const bindingGroupId = typeof binding.groupId === 'string' ? binding.groupId.trim() : '';
  const identityGroupId = typeof identity.groupId === 'string' ? identity.groupId.trim() : '';
  if (bindingGroupId !== identityGroupId) return false;
  if (!bindingGroupId) return binding.profileId === identity.profileId;

  const generationMatches = normalizeConnectedServiceQuotaGeneration(binding.groupGeneration)
    === normalizeConnectedServiceQuotaGeneration(identity.groupGeneration);
  if (!generationMatches) return false;
  if (binding.profileId === identity.profileId) return true;

  return identity.source === 'codex_live_auth_apply'
    || identity.source === 'group_switch_selection'
    || identity.source === 'runtime_identity_probe';
}

export function readCredentialAccountIdentity(record: ConnectedServiceCredentialRecordV1): Readonly<{
  providerAccountId: string;
  accountLabel: string | null;
}> | null {
  if (record.kind === 'oauth') {
    const providerAccountId = typeof record.oauth.providerAccountId === 'string'
      ? record.oauth.providerAccountId.trim()
      : '';
    if (!providerAccountId) return null;
    const accountLabel = typeof record.oauth.providerEmail === 'string' && record.oauth.providerEmail.trim()
      ? record.oauth.providerEmail.trim()
      : null;
    return { providerAccountId, accountLabel };
  }
  if (record.kind === 'token') {
    const providerAccountId = typeof record.token.providerAccountId === 'string'
      ? record.token.providerAccountId.trim()
      : '';
    if (!providerAccountId) return null;
    const accountLabel = typeof record.token.providerEmail === 'string' && record.token.providerEmail.trim()
      ? record.token.providerEmail.trim()
      : null;
    return { providerAccountId, accountLabel };
  }
  return null;
}

export type OAuthConnectedServiceCredentialRecord = Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }>;

export function buildCredentialRecordForQuotaFetcher(record: ConnectedServiceCredentialRecordV1): ConnectedServiceCredentialRecordV1 {
  if (record.kind !== 'oauth') return record;
  const view: OAuthConnectedServiceCredentialRecord = {
    ...record,
    oauth: {
      ...record.oauth,
      refreshToken: '',
    },
  };
  // Provider quota/account-usage fetchers use access-token/account metadata only. The
  // persisted credential schema carries refresh tokens, so remove that field at this boundary.
  delete (view.oauth as Partial<OAuthConnectedServiceCredentialRecord['oauth']>).refreshToken;
  return view;
}

export function deriveQuotaSnapshotStatus(snapshot: ConnectedServiceQuotaSnapshotV1): 'ok' | 'unavailable' | 'estimated' {
  const meters = Array.isArray(snapshot.meters) ? snapshot.meters : [];
  if (meters.length === 0) return 'ok';
  const statuses = meters.map((m: any) => (typeof m?.status === 'string' ? m.status : ''));
  if (statuses.every((s) => s === 'unavailable')) return 'unavailable';
  if (statuses.some((s) => s === 'estimated')) return 'estimated';
  return 'ok';
}

export type FailureState = Readonly<{
  consecutiveFailures: number;
  nextAllowedAt: number;
}>;

export type CredentialRefreshReason = 'near_expiry' | 'auth_failure';
export type RefreshConnectedServiceCredentialForQuota = (input: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  force: boolean;
  reason: CredentialRefreshReason;
}>) => Promise<ConnectedServiceQuotaCredentialRefreshOutcome | null>;

export type AccountUsageStoreForQuotaPolicy = Pick<
  ProviderAccountUsageStore,
  'recordSnapshot' | 'resolveRecordId'
> & AccountUsageStoreForAuthGroupSwitchState;

export const QUOTA_AUTH_FAILURE_REAUTH_CONSECUTIVE_FAILURES = 5;

export function readFiniteNonNegativeMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isQuotaAuthFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Readonly<{ quotaFetchErrorCode?: unknown; status?: unknown }>;
  if (record.status === 401 || record.status === 403) return true;
  return record.quotaFetchErrorCode === 'auth_failure' && record.status === undefined;
}

export function providerHttpStatusForHealth(status: unknown): number | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 100 && status <= 599 ? status : undefined;
}

export function quotaAuthFailureKindForHealth(error: unknown): ConnectedServiceCredentialHealthV1['lastRefreshFailureKind'] {
  if (!error || typeof error !== 'object') return 'unknown';
  const status = (error as Readonly<{ status?: unknown }>).status;
  if (status === 401) return 'provider_401';
  if (status === 403) return 'provider_403';
  return 'unknown';
}

export function providerErrorCodeForHealth(code: unknown): string | undefined {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

export function isTerminalQuotaAuthFailure(error: unknown): boolean {
  // Provider-owned classification: the quota fetcher constructs `reconnectRequired: true` only
  // when the failure provably cannot be fixed by retry/refresh (e.g. Claude missing the
  // Claude Code OAuth scope). Everything else stays retryable until a credential refresh probe
  // proves permanence (see persistCredentialHealthForQuotaFailure).
  return isRecord(error) && error.reconnectRequired === true;
}

export function shouldProbeCredentialRefreshForQuotaFailure(
  error: unknown,
  options: Readonly<{ consecutiveFailures: number }>,
): boolean {
  const record = isRecord(error) ? error : null;
  if (!record) return false;
  if (record.reconnectRequired === true) return true;
  if (record.status === 403) return true;
  if (record.status === 401 || record.quotaFetchErrorCode === 'auth_failure') {
    return options.consecutiveFailures >= QUOTA_AUTH_FAILURE_REAUTH_CONSECUTIVE_FAILURES;
  }
  return false;
}

export function buildQuotaAuthFailureCredentialHealth(
  error: unknown,
  now: number,
  options: Readonly<{ consecutiveFailuresBeforeCurrent: number }>,
): ConnectedServiceCredentialHealthV1 {
  const status = providerHttpStatusForHealth((error as Readonly<{ status?: unknown }> | null)?.status);
  const providerCode = providerErrorCodeForHealth((error as Readonly<{ providerCode?: unknown }> | null)?.providerCode);
  const consecutiveFailures = Math.max(1, Math.trunc(options.consecutiveFailuresBeforeCurrent) + 1);
  const reconnectRequired = isTerminalQuotaAuthFailure(error);
  return {
    v: 1,
    status: reconnectRequired ? 'needs_reauth' : 'refresh_failed_retryable',
    reconnectRequired,
    lastRefreshAttemptAt: now,
    lastRefreshFailureAt: now,
    lastRefreshFailureKind: quotaAuthFailureKindForHealth(error),
    ...(status !== undefined ? { providerHttpStatus: status } : {}),
    ...(providerCode !== undefined ? { providerErrorCode: providerCode } : {}),
  };
}

export function readQuotaRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  return readFiniteNonNegativeMs((error as Readonly<{ retryAfterMs?: unknown }>).retryAfterMs);
}

export function defaultSleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, Math.max(0, Math.trunc(ms)));
    (handle as unknown as { unref?: () => void })?.unref?.();
  });
}

/**
 * X8 — Stale-but-usable quota.
 *
 * Returns a copy of the snapshot with all meters annotated as stale_quota so
 * the UI can show "last known data (refresh failed)" rather than a blank.
 * The meter data (utilizationPct, resetsAt, etc.) is preserved.
 */
export function annotateSnapshotAsStale(snapshot: ConnectedServiceQuotaSnapshotV1): ConnectedServiceQuotaSnapshotV1 {
  return {
    ...snapshot,
    meters: snapshot.meters.map((meter) => ({
      ...meter,
      details: {
        ...meter.details,
        code: 'stale_quota',
      },
    })),
  };
}

export function isQuotaUnknownFallbackSnapshot(snapshot: ConnectedServiceQuotaSnapshotV1): boolean {
  const meters = Array.isArray(snapshot.meters) ? snapshot.meters : [];
  return meters.length > 0 && meters.every((meter) => (
    meter.status === 'unavailable'
    && isRecord(meter.details)
    && meter.details.code === 'quota_unknown'
  ));
}

export class UnknownAccountModeQuotaPersistenceError extends Error {
  public readonly code = 'HAPPIER_ACCOUNT_MODE_UNKNOWN';
  public readonly retryAfterMs = ACCOUNT_MODE_UNKNOWN_RETRY_AFTER_MS;

  public constructor() {
    super('Connected-service quota persistence deferred because account encryption mode is unknown');
    this.name = 'UnknownAccountModeQuotaPersistenceError';
  }
}

export class DaemonServerWorkQuotaPersistenceError extends Error {
  public readonly outcome: DaemonServerWorkOutcome;
  public readonly retryAfterMs?: number;

  public constructor(outcome: DaemonServerWorkOutcome) {
    super(`Connected-service quota persistence did not write: ${outcome.status}`);
    this.name = 'DaemonServerWorkQuotaPersistenceError';
    this.outcome = outcome;
    if (outcome.status === 'failed' && typeof outcome.classification.retryAfterMs === 'number') {
      this.retryAfterMs = outcome.classification.retryAfterMs;
    } else if (outcome.status === 'deferred' && typeof outcome.retryAfterMs === 'number') {
      this.retryAfterMs = outcome.retryAfterMs;
    }
  }
}
