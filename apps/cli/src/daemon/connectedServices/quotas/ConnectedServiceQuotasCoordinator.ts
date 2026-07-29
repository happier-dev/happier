import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  buildProviderAccountUsageRecordId,
  buildQualifiedPluginContributionKey,
  ConnectedServiceIdSchema,
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceUsageSourceV1Schema,
  isConnectedServiceCredentialHealthStatusUsable,
  openConnectedServiceCredentialCiphertext,
  openConnectedServiceQuotaSnapshotCiphertext,
  openQualifiedConnectedAccountQuotaResponseV4,
  parseBuiltInLegacyConnectedServiceQuotaSnapshotV1,
  projectBuiltInLegacyProviderAccountUsageSnapshotV1,
  ProviderAccountUsageSnapshotV1Schema,
  ConnectedServiceQuotaSnapshotV1Schema,
  sealProviderAccountUsageSnapshotCiphertext,
  type BuiltInLegacyConnectedAccountOperation,
  type ConnectedServiceAuthGroupMemberStateV1,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceCredentialHealthV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
  type ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
  type ConnectedServiceQuotaSnapshotV1,
  type ConnectedServiceUsageSourceV1,
  type ConnectedServiceLimitCategoryV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageQuotaScopeV1,
  type ProviderAccountUsageSnapshotV1,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type {
  PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/runtime';

import {
  createKeyedBackoffTracker,
  type KeyedBackoffTracker,
} from '@/api/connection/scheduling';
import type {
  ConnectedServiceRuntimeAuthApplyCapability,
} from '@/agent/catalog/types';
import type {
  ConnectedServiceCredentialPlainResponse,
  ConnectedServiceCredentialSealedResponse,
} from '@/api/client/connectedServiceCredentialApi';
import type { Credentials } from '@/persistence';
import { assertConnectedServiceCredentialRecordBinding } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
  invalidateConnectedServiceAccountMode,
  resolveConnectedServiceAccountMode,
  type ConnectedServiceAccountMode,
} from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import {
  createDaemonServerWorkBudget,
  createDaemonServerWorkScheduler,
  type DaemonServerWorkGate,
  type DaemonServerWorkGateResult,
  type DaemonServerWorkScheduler,
} from '@/daemon/serverWork';

import {
  readConnectedServiceChildSelectionsFromEnv,
} from '../connectedServiceChildEnvironment';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  evaluateConnectedServiceAuthGroupQuotaLifecycle,
  type ConnectedServiceAuthGroupQuotaLifecycleState,
} from '../accountGroups/quotas/lifecycle';
import {
  isProviderAccountUsageStoreMutationAccepted,
  type ProviderAccountUsageStore,
} from '../accountUsage/store';
import type { ProviderAccountUsagePersistenceScheduler } from '../accountUsage/persistence';
import { computeProviderAccountUsageSnapshotFingerprint } from '../accountUsage/fingerprint';
import { buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation } from '../accountUsage/fromConnectedServiceQuotaObservation';
import {
  resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence,
} from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import {
  buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
  resolveAccountUsageSnapshotsByGroupProfile,
  type AccountUsageStoreForAuthGroupSwitchState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import {
  buildQuotaPersistenceKey as buildQuotaPersistenceKeyValue,
  resolveQuotaPersistenceAccountScope,
  type QuotaPersistenceAccountScope,
} from './quotaPersistenceKey';
import {
  projectConnectedServiceQuotaSnapshotToAuthGroupQuotaEvidence,
  reconcileMemberRuntimeStateWithFreshQuotaEvidence,
} from '../accountGroups/state/memberRuntimeState';
import { updateConnectedServiceAuthGroupRuntimeStateWithRetry } from '../accountGroups/runtimeState/updateConnectedServiceAuthGroupRuntimeStateWithRetry';

type ConnectedServiceAccountUsageSwitchState = NonNullable<
  ReturnType<typeof buildConnectedServiceAuthGroupSwitchStateFromAccountUsage>
>['state'];
import {
  computeQuotaSnapshotFingerprint,
  deriveQuotaSnapshotFingerprintKey,
  type QuotaSnapshotFingerprintKey,
} from './quotaSnapshotFingerprint';
import {
  shouldPersistQuotaSnapshot,
  type QuotaPersistenceMaterialState,
} from './shouldPersistQuotaSnapshot';
import {
  createConnectedServiceQuotaPersistenceScheduler,
  type ConnectedServiceQuotaPersistenceScheduler,
} from './createConnectedServiceQuotaPersistenceScheduler';
import { STANDARD_OAUTH_TERMINAL_AUTH_PROVIDER_CODES, type ConnectedServiceQuotaFetcher } from './types';
import { RuntimeAccountIdentityIndex } from './identity/RuntimeAccountIdentityIndex';
import { resolveSessionsSharingProviderAccount } from './identity/resolveSessionsSharingProviderAccount';
import {
  evaluatePredictiveSoftSwitchPolicy,
  runtimeAuthApplyRequiresLiveIdentityProbe,
} from '../accountGroups/switching/predictiveSoftSwitchPolicy';
import {
  normalizeConnectedServiceSameAccountFanoutStrategy,
  type ConnectedServiceSameAccountFanoutStrategy,
} from './identity/providerFanoutStrategy';
import {
  resolveRuntimeAccountIdentityFanoutMatch,
  type RuntimeIdentityFanoutSuppressionDiagnostic,
} from './identity/resolveRuntimeAccountIdentityFanoutMatch';
import { persistedSessionAccountIdentityMatchesFailingAccount } from './identity/resolvePersistedMaterializationIdentityFanoutMatch';
import type {
  PersistedSessionAccountIdentityReader,
  RuntimeAccountIdentityEntry,
  RuntimeAccountIdentityFanoutProbeResult,
  RuntimeAccountIdentityFanoutReader,
  RuntimeAccountIdentityRecordInput,
  RuntimeAccountIdentityRecordResult,
} from './identity/runtimeAccountIdentityTypes';
import {
  resolveQuotaProbeFreshProof,
  type QuotaProbeAppliedIdentity,
  type QuotaProbeFreshProofResult,
} from './proof/quotaProbeFreshProof';
import {
  ConnectedServiceRuntimeRegistry,
  type ConnectedServiceRuntimeQuotaTarget,
} from '../runtimeRegistry/registry';
import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  buildConnectedServiceAuthGroupTargetEpochIdentity,
  type ConnectedServiceAuthGroupCommittedGenerationFact,
  type ConnectedServiceProviderAdoptedGenerationTarget,
} from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import type { ConnectedServiceAuthGroupGenerationConsumptionOutcome } from '../accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { hasExactConnectedServiceTargetAdoptionProof } from '../sessionAuthSwitch/resolveCommittedGenerationFromRuntimeAuthRecovery';
import {
  isBuiltInLegacyConnectedAccountPeerOperationSupported,
  readQualifiedConnectedAccountQuotaV4,
  writeQualifiedProviderAccountUsageV4,
  type QualifiedConnectedAccountPeerClass,
  type QualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type {
  QualifiedConnectedAccountV4Support,
} from '../qualifiedConnectedAccountV4Support';

const DEFAULT_QUOTA_PERSISTENCE_MIN_FRESHNESS_MS = 60_000;

type PluginConnectedAccountQuotaSnapshot = Awaited<
  ReturnType<NonNullable<PluginConnectedAccountRuntime['quota']>>
>;

export type QualifiedConnectedAccountQuotaRuntime = Readonly<{
  resolvePeerClass(): QualifiedConnectedAccountPeerClass;
  resolveOperationTransport?(input: Readonly<{
    service: QualifiedConnectedAccountRef['service'];
    operation: BuiltInLegacyConnectedAccountOperation;
  }>): QualifiedConnectedAccountPeerOperationTransport;
  establishedRuntimeOwner: Pick<
    QualifiedConnectedAccountEstablishedRuntimeOwner,
    'invokeWithReceipt'
  >;
  listScheduledAccounts(): Promise<
    readonly QualifiedConnectedAccountProfileV4[]
  >;
  readQuota?: typeof readQualifiedConnectedAccountQuotaV4;
  writeProviderAccountUsage?: typeof writeQualifiedProviderAccountUsageV4;
}>;

function qualifiedAccountQuotaKey(
  account: QualifiedConnectedAccountRef,
): string {
  return JSON.stringify([
    account.service.pluginId,
    account.service.localId,
    account.accountId,
  ]);
}

export function buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota(
  input: Readonly<{
    profile: QualifiedConnectedAccountProfileV4;
    quota: PluginConnectedAccountQuotaSnapshot;
    staleAfterMs: number;
  }>,
): ProviderAccountUsageSnapshotV1 {
  const providerId = buildQualifiedPluginContributionKey(
    input.profile.ref.service,
  );
  const providerAccountId =
    input.profile.providerIdentity?.accountId?.trim() ?? '';
  const accountSubjectId =
    providerAccountId || input.profile.ref.accountId;
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId,
    accountSubjectId,
    subjectKind: providerAccountId ? 'account' : 'unknown',
    quotaScope: 'account',
  };
  const recordId = buildProviderAccountUsageRecordId(recordKey);
  const observedAtMs = Math.trunc(input.quota.observedAtMs);
  const meters = input.quota.limits.map((limit) => {
    const used =
      typeof limit.used === 'number' && Number.isFinite(limit.used)
        ? limit.used
        : null;
    const remaining =
      typeof limit.remaining === 'number'
      && Number.isFinite(limit.remaining)
        ? limit.remaining
        : null;
    const total =
      used !== null && remaining !== null
        ? used + remaining
        : null;
    const hasPositiveTotal =
      total !== null && Number.isFinite(total) && total > 0;
    const usedPct = hasPositiveTotal && used !== null
      ? Math.min(100, Math.max(0, (used / total) * 100))
      : null;
    const remainingPct = hasPositiveTotal && remaining !== null
      ? Math.min(100, Math.max(0, (remaining / total) * 100))
      : null;
    const resetsAt =
      typeof limit.resetsAtMs === 'number'
      && Number.isInteger(limit.resetsAtMs)
      && limit.resetsAtMs >= 0
        ? limit.resetsAtMs
        : null;
    return {
      meterId: limit.id,
      label: limit.id,
      used,
      limit: total,
      remaining,
      remainingPct,
      usedPct,
      resetAtMs: resetsAt,
      resetSource: resetsAt === null ? 'unknown' as const : 'provider' as const,
      providerLimitId: limit.id,
      isExhausted: remaining !== null ? remaining <= 0 : false,
      unit: 'unknown' as const,
      utilizationPct: usedPct,
      resetsAt,
      status: used !== null || remaining !== null
        ? 'ok' as const
        : 'unavailable' as const,
      source: 'provider_api' as const,
      scope: 'unknown' as const,
      limitScope: 'account' as const,
      confidence: 'exact' as const,
      details: {
        providerLimitId: limit.id,
        remainingPct,
      },
    };
  });
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId,
    recordKey,
    providerId,
    accountSubject: providerAccountId
      ? { kind: 'providerSubject', id: accountSubjectId }
      : {
          kind: 'provisionalLocalSubject',
          id: accountSubjectId,
          mergeKey: qualifiedAccountQuotaKey(input.profile.ref),
        },
    observedAtMs,
    fetchedAtMs: observedAtMs,
    staleAfterMs: Math.max(1, Math.trunc(input.staleAfterMs)),
    source: 'providerHttp',
    confidence: 'confirmed',
    state: meters.length > 0 ? 'loaded_data' : 'loaded_empty',
    accountLabel: input.profile.displayName ?? null,
    meters,
  });
}

type ConnectedServicesBindingsV1Like = Readonly<{
  v?: unknown;
  bindingsByServiceId?: Record<string, unknown>;
}>;

type QuotaApi = Readonly<{
  getAccountEncryptionMode?: () => Promise<ConnectedServiceAccountMode>;
  getConnectedServiceQuotaSnapshotSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
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
  getConnectedServiceQuotaSnapshotPlain?: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
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
  getConnectedServiceCredentialSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
    ConnectedServiceCredentialSealedResponse | null
  >;
  getConnectedServiceCredentialPlain?: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
    ConnectedServiceCredentialPlainResponse | null
  >;
  listConnectedServiceProfiles?: (args: Readonly<{ serviceId: ConnectedServiceId }>) => Promise<
    Readonly<{
      serviceId: ConnectedServiceId;
      profiles: ReadonlyArray<
        Readonly<{
          profileId: string;
          status: 'connected' | 'refreshing' | 'needs_reauth' | 'refresh_failed_retryable';
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
  updateConnectedServiceCredentialHealth?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    health: ConnectedServiceCredentialHealthV1;
    expectedCredentialRevision: ReturnType<
      typeof ConnectedServiceCredentialRevisionV1Schema.parse
    >;
  }>) => Promise<void>;
  acquireConnectedServiceRefreshLease?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    machineId: string;
    ownerId?: string;
    leaseMs: number;
    expectedCredentialRevision: ReturnType<
      typeof ConnectedServiceCredentialRevisionV1Schema.parse
    >;
  }>) => Promise<Readonly<{ acquired: boolean; leaseUntil: number }>>;
  getConnectedServiceAuthGroup?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>) => Promise<ConnectedServiceAuthGroupV1 | null>;
  updateConnectedServiceAuthGroupRuntimeState?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    expectedGeneration?: number;
    expectedRuntimeStateRevision?: number;
    memberStates: Array<{
      profileId: string;
      state: ConnectedServiceAuthGroupMemberStateV1;
    }>;
  }>) => Promise<ConnectedServiceAuthGroupV1>;
}>;

type ExistingQuotaSnapshotResponse =
  | Awaited<ReturnType<QuotaApi['getConnectedServiceQuotaSnapshotSealed']>>
  | Awaited<ReturnType<NonNullable<QuotaApi['getConnectedServiceQuotaSnapshotPlain']>>>;

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

type SpawnTarget = ConnectedServiceRuntimeQuotaTarget;

type ActiveConnectedServiceBinding = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId?: string;
  groupGeneration?: number | null;
}>;
type ActiveGroupQuotaSwitchTarget = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string;
  groupGeneration: number | null;
}>;
type ConnectedServiceQuotaGroupContext = Readonly<{
  groupId: string;
  groupGeneration: number | null;
}>;
type ActiveSameAccountFanoutCandidate = ActiveGroupQuotaSwitchTarget & Readonly<{
  agentId?: string;
  groupGeneration: number | null;
}>;
type GroupSwitchTargetEligibility =
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
  | Readonly<{
    status: 'unknown';
    reason: 'missing_group_reader' | 'group_resolution_failed' | 'selection_unknown' | 'source_quota_unavailable' | 'source_account_usage_unavailable';
    decisionTrace?: unknown;
  }>
  | Readonly<{ status: 'no_eligible_target'; retryAfterMs: number | null; decisionTrace?: unknown }>
  | Readonly<{ status: 'no_meaningfully_better_target'; retryAfterMs: number | null; decisionTrace?: unknown }>;
type QuotaWorkPhase = 'tick' | 'hydrate_group' | 'probe_group' | 'soft_switch' | 'same_account_fanout';
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
  /** PS-1: distinguishes preemptive (burn-projected) soft-switches from reactive (observed) ones. */
  sourceProjected?: boolean;
  selectedProfileId?: string;
  selectedRemainingPercent?: number | null;
  decisionTrace?: unknown;
  targetCount?: number;
  allowedTargetCount?: number;
  expectedProviderAccountId?: string | null;
  actualProviderAccountId?: string | null;
  expectedProfileId?: string;
  actualProfileId?: string | null;
  expectedGroupId?: string;
  actualGroupId?: string | null;
  expectedGroupGeneration?: number | null;
  actualGroupGeneration?: number | null;
}>;
type QuotaCredentialOpenMaterial =
  | Readonly<{ type: 'legacy'; secret: Uint8Array }>
  | Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
type ResolvedQuotaFetchCredential = Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  credentialRevision: ReturnType<
    typeof ConnectedServiceCredentialRevisionV1Schema.parse
  >;
  credentialStorageMode: 'e2ee' | 'plain';
}>;
function readCredentialProviderAccountId(record: ConnectedServiceCredentialRecordV1): string {
  const value = record.kind === 'oauth'
    ? record.oauth.providerAccountId
    : record.kind === 'token'
      ? record.token.providerAccountId
      : null;
  return typeof value === 'string' ? value.trim() : '';
}
function canPersistUsageSourceLinkWithProviderIdentity(input: Readonly<{
  sourceProviderAccountId: string;
  recordKey: ProviderAccountUsageRecordKeyV1;
}>): boolean {
  return Boolean(input.sourceProviderAccountId)
    && input.recordKey.subjectKind === 'account'
    && Boolean(input.recordKey.accountSubjectId)
    && input.recordKey.accountSubjectId === input.sourceProviderAccountId;
}
type AuthGroupSwitchCoordinator = Readonly<{
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
    credentialRevision?: import('@happier-dev/protocol').ConnectedServiceCredentialRevisionV1 | null;
    reason: string;
  }>): Promise<Readonly<{
    status: string;
    activeProfileId?: string | null;
    generation: number;
    errorCode?: string;
  }>>;
}>;

export type ConsumeCommittedAuthGroupGeneration = (input: Readonly<{
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  switchReason: 'pre_turn_group_policy' | 'automatic_runtime_failure';
  sessions: ReadonlyArray<Readonly<{
    sessionId: string;
    activity: 'live';
    fromProfileId: string | null;
  }>>;
  executionAuthority: 'runtime_recovery';
}>) => Promise<Readonly<{ outcome: ConnectedServiceAuthGroupGenerationConsumptionOutcome }>>;
type SameAccountFanoutCandidateIdentity = Readonly<{
  candidate: ActiveSameAccountFanoutCandidate;
  accountLabel: string | null;
  observedProfileId: string;
  deferUntilTurnBoundary: boolean;
}>;
type SameAccountFanoutStrategyResolver = (
  input: Readonly<{
    agentId?: string | null;
    serviceId: ConnectedServiceId;
    sourceSessionId: string;
    groupId: string;
  }>,
) => ConnectedServiceSameAccountFanoutStrategy | Promise<ConnectedServiceSameAccountFanoutStrategy>;
type RuntimeAuthApplyCapabilityResolver = (
  input: Readonly<{
    sessionId: string;
    agentId?: string | null;
    serviceId: ConnectedServiceId;
    groupId: string;
    reason: 'same_provider_account_exhausted';
  }>,
) => ConnectedServiceRuntimeAuthApplyCapability | Promise<ConnectedServiceRuntimeAuthApplyCapability>;
type PredictiveSwitchGuardResult =
  | Readonly<{ status: 'allow' }>
  | Readonly<{ status: 'suppress' | 'fold'; reason: string }>;
export type ConnectedServiceQuotaPredictiveSwitchGuard = (
  input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    reason: 'soft_threshold';
  }>,
) => PredictiveSwitchGuardResult | Promise<PredictiveSwitchGuardResult>;
export type ConnectedServiceQuotaLifecycleTransition = Readonly<{
  phase: 'blocked' | 'recovered';
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string | null;
  sessionIds: ReadonlyArray<string>;
  cycleId?: string;
  issueFingerprint: string;
  resetAtMs: number | null;
  reason: string;
}>;
export type ConnectedServiceQuotaLifecycleListener = (
  transition: ConnectedServiceQuotaLifecycleTransition,
) => void | Promise<void>;

function buildResolvedSelectionProfilesByServiceId(
  env: Readonly<Record<string, string | undefined>> | undefined,
) {
  return env ? readConnectedServiceChildSelectionsFromEnv(env) : null;
}

function resolveProfileIdFromSelection(input: Readonly<{
  binding: Record<string, unknown>;
  serviceId: ConnectedServiceId;
  selectionsByServiceId: ReturnType<typeof buildResolvedSelectionProfilesByServiceId>;
}>): string {
  const explicitProfileId = typeof input.binding.profileId === 'string' ? String(input.binding.profileId).trim() : '';
  if (explicitProfileId) return explicitProfileId;

  const selection = input.selectionsByServiceId?.get(input.serviceId);
  if (!selection) return '';
  if (selection.kind === 'profile') return selection.profileId;

  const groupId = typeof input.binding.groupId === 'string' ? String(input.binding.groupId).trim() : '';
  if (groupId && selection.groupId !== groupId) return '';
  return selection.activeProfileId;
}

function extractActiveBindings(
  raw: ConnectedServicesBindingsV1Like,
  connectedServiceSelectionsEnv?: Readonly<Record<string, string | undefined>>,
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
    const selection = selectionsByServiceId?.get(parsedServiceId.data);
    const groupId = selection?.kind === 'group' && selection.activeProfileId === profileId
      ? selection.groupId.trim()
      : '';
    const groupGeneration = selection?.kind === 'group' && selection.activeProfileId === profileId
      ? normalizeNullableGeneration(selection.generation)
      : null;
    out.push({
      serviceId: parsedServiceId.data,
      profileId,
      ...(groupId ? { groupId } : {}),
      ...(groupId ? { groupGeneration } : {}),
    });
  }
  return out;
}

function activeBindingMatchesRuntimeIdentity(
  binding: ActiveConnectedServiceBinding,
  identity: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string | null;
    profileId: string;
    groupGeneration: number | null;
  }>,
): boolean {
  if (binding.serviceId !== identity.serviceId) return false;
  if (binding.profileId !== identity.profileId) return false;
  const bindingGroupId = typeof binding.groupId === 'string' ? binding.groupId.trim() : '';
  const identityGroupId = typeof identity.groupId === 'string' ? identity.groupId.trim() : '';
  if (bindingGroupId !== identityGroupId) return false;
  if (!bindingGroupId) return true;
  return normalizeNullableGeneration(binding.groupGeneration) === normalizeNullableGeneration(identity.groupGeneration);
}

function deriveQuotaSnapshotStatus(snapshot: ConnectedServiceQuotaSnapshotV1): 'ok' | 'unavailable' | 'estimated' {
  const meters = Array.isArray(snapshot.meters) ? snapshot.meters : [];
  if (meters.length === 0) return 'ok';
  const statuses = meters.map((m: any) => (typeof m?.status === 'string' ? m.status : ''));
  if (statuses.every((s) => s === 'unavailable')) return 'unavailable';
  if (statuses.some((s) => s === 'estimated')) return 'estimated';
  return 'ok';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isQuotaUnknownPlaceholderMeter(meter: unknown): boolean {
  const record = isRecord(meter) ? meter : null;
  const details = isRecord(record?.details) ? record.details : null;
  return record?.status === 'unavailable'
    && details?.code === 'quota_unknown'
    && record.utilizationPct === null
    && record.used === null
    && record.limit === null
    && record.resetsAt === null;
}

function isQuotaUnknownPlaceholderSnapshot(snapshot: ConnectedServiceQuotaSnapshotV1): boolean {
  return snapshot.meters.length > 0 && snapshot.meters.every(isQuotaUnknownPlaceholderMeter);
}

function hasUsefulQuotaSnapshotData(snapshot: ConnectedServiceQuotaSnapshotV1): boolean {
  if (typeof snapshot.planLabel === 'string' && snapshot.planLabel.trim()) return true;
  if (typeof snapshot.accountLabel === 'string' && snapshot.accountLabel.trim()) return true;
  if (typeof snapshot.activeAccountId === 'string' && snapshot.activeAccountId.trim()) return true;
  return snapshot.meters.some((meter) => !isQuotaUnknownPlaceholderMeter(meter) && (
    meter.status !== 'unavailable'
    || meter.utilizationPct !== null
    || meter.used !== null
    || meter.limit !== null
    || meter.resetsAt !== null
  ));
}

function defaultSleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, Math.max(0, Math.trunc(ms)));
    (handle as unknown as { unref?: () => void })?.unref?.();
  });
}

type FailureState = Readonly<{
  consecutiveFailures: number;
  nextAllowedAt: number;
}>;

type InBandQuotaPersistencePayload = Readonly<{
  key: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  snapshot: ConnectedServiceQuotaSnapshotV1;
  status: 'ok' | 'unavailable' | 'estimated';
  materialFingerprint: string;
  materialState: QuotaPersistenceMaterialState;
}>;

class InBandQuotaPersistenceRetryError extends Error {
  readonly reason: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(params: Readonly<{ reason: string; retryable: boolean; retryAfterMs?: number }>) {
    super(params.reason);
    this.name = 'InBandQuotaPersistenceRetryError';
    this.reason = params.reason;
    this.retryable = params.retryable;
    if (typeof params.retryAfterMs === 'number') this.retryAfterMs = params.retryAfterMs;
  }
}

function isRetryableQuotaPersistenceError(error: unknown): boolean {
  return error instanceof InBandQuotaPersistenceRetryError ? error.retryable : true;
}

function shouldPauseQuotaPersistenceAfterFailure(error: unknown): boolean {
  if (!(error instanceof InBandQuotaPersistenceRetryError)) return true;
  return error.reason !== 'account_mode_unknown'
    && error.reason !== 'offline'
    && error.reason !== 'auth_failed'
    && error.reason !== 'shutting_down';
}

function randomRatioFromBytes(randomBytes: (length: number) => Uint8Array): number {
  const bytes = randomBytes(4);
  const u32 =
    ((bytes[0] ?? 0) << 24) |
    ((bytes[1] ?? 0) << 16) |
    ((bytes[2] ?? 0) << 8) |
    (bytes[3] ?? 0);
  return (u32 >>> 0) / 0xffffffff;
}

function readFiniteNonNegativeMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

const QUOTA_AUTH_FAILURE_REAUTH_CONSECUTIVE_FAILURES = 5;

function resolveQuotaFetchFailureBackoffMs(input: Readonly<{
  error: unknown;
  now: number;
}>): number | null {
  const error = isRecord(input.error) ? input.error : null;
  const retryAfterMs = readFiniteNonNegativeMs(error?.retryAfterMs);
  if (retryAfterMs !== null) return Math.max(1, retryAfterMs);

  const resetAtMs = readFiniteNonNegativeMs(error?.resetAtMs);
  if (resetAtMs !== null) return Math.max(1, resetAtMs - input.now);

  return null;
}

function isQuotaAuthFailure(error: unknown): boolean {
  const record = isRecord(error) ? error : null;
  if (!record) return false;
  if (record.status === 401 || record.status === 403) return true;
  return record.quotaFetchErrorCode === 'auth_failure'
    && (record.status === null || record.status === undefined);
}

function providerHttpStatusForHealth(status: unknown): number | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 100 && status <= 599 ? status : undefined;
}

function quotaAuthFailureKindForHealth(error: unknown): ConnectedServiceCredentialHealthV1['lastRefreshFailureKind'] {
  const record = isRecord(error) ? error : null;
  const status = record?.status;
  if (status === 401) return 'provider_401';
  if (status === 403) return 'provider_403';
  return 'unknown';
}

function providerErrorCodeForHealth(code: unknown): string | undefined {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

function isTerminalQuotaAuthFailure(
  error: unknown,
  providerTerminalAuthFailureCodes: readonly string[] = [],
): boolean {
  const record = isRecord(error) ? error : null;
  if (!record) return false;
  const providerCode = providerErrorCodeForHealth(record.providerCode);
  if (!providerCode) return false;
  return (STANDARD_OAUTH_TERMINAL_AUTH_PROVIDER_CODES as readonly string[]).includes(providerCode)
    || providerTerminalAuthFailureCodes.includes(providerCode);
}

function buildQuotaAuthFailureCredentialHealth(
  error: unknown,
  now: number,
  options: Readonly<{
    consecutiveFailuresBeforeCurrent: number;
    providerTerminalAuthFailureCodes?: readonly string[];
  }>,
): ConnectedServiceCredentialHealthV1 {
  const record = isRecord(error) ? error : null;
  const status = providerHttpStatusForHealth(record?.status);
  const providerCode = providerErrorCodeForHealth(record?.providerCode);
  const consecutiveFailures = Math.max(1, Math.trunc(options.consecutiveFailuresBeforeCurrent) + 1);
  const reconnectRequired = isTerminalQuotaAuthFailure(error, options.providerTerminalAuthFailureCodes)
    || (
      status !== 403
      && consecutiveFailures >= QUOTA_AUTH_FAILURE_REAUTH_CONSECUTIVE_FAILURES
    );
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

function normalizeQuotaPersistenceAccountScopeInput(
  value: string | QuotaPersistenceAccountScope,
): QuotaPersistenceAccountScope {
  if (typeof value === 'object') return value;
  const normalized = value.trim();
  return normalized ? { kind: 'known', value: normalized } : { kind: 'unknown' };
}

function accountScopeFingerprintMaterial(scope: QuotaPersistenceAccountScope): string {
  return scope.kind === 'known' ? scope.value : 'unknown-account';
}

function isHotApplySwitchResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  return (result as Readonly<Record<string, unknown>>).mode === 'hot_apply';
}

function isDeferredFanoutSwitchResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  return (result as Readonly<Record<string, unknown>>).status === 'deferred';
}

function isGroupExhaustedNoEligibleMemberSwitchResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const record = result as Readonly<Record<string, unknown>>;
  return record.status === 'no_eligible_member' && record.groupExhausted === true;
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeNullableGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

export class ConnectedServiceQuotasCoordinator {
  private readonly api: QuotaApi;
  private readonly credentials: Credentials;
  private readonly quotaFetchersByServiceId: Map<ConnectedServiceId, ConnectedServiceQuotaFetcher>;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly fetchTimeoutMs: number;
  private readonly failureBackoffMinMs: number;
  private readonly failureBackoffMaxMs: number;
  private readonly failureBackoffJitterPct: number;
  private readonly discoveryEnabled: boolean;
  private readonly discoveryIntervalMs: number;
  private readonly runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  private readonly accountUsageStore: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId'> & AccountUsageStoreForAuthGroupSwitchState | null;
  private readonly accountUsagePersistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
  private readonly machineIdProvider: (() => string | null | undefined) | null;
  private readonly ownerIdProvider: (() => string | null | undefined) | null;
  private readonly quotaFetchLeaseMs: number;
  private readonly quotaFetchLeaseContentionWaitMaxMs: number;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly authGroupSwitchCoordinator: AuthGroupSwitchCoordinator | null;
  private readonly consumeCommittedAuthGroupGeneration: ConsumeCommittedAuthGroupGeneration | null;
  private readonly predictiveSwitchGuard: ConnectedServiceQuotaPredictiveSwitchGuard | null;
  private readonly sameAccountFanoutStrategyResolver: SameAccountFanoutStrategyResolver;
  private readonly runtimeAuthApplyCapabilityResolver: RuntimeAuthApplyCapabilityResolver | null;
  private readonly groupSwitchCheckMinIntervalMs: number;
  private readonly groupSwitchCheckJitterMs: number;
  private readonly sameAccountFanoutMinIntervalMs: number;
  private readonly sameAccountFanoutResetBucketMs: number;
  private readonly readRuntimeAccountIdentityForFanout: RuntimeAccountIdentityFanoutReader | null;
  private readonly readPersistedSessionAccountIdentity: PersistedSessionAccountIdentityReader | null;
  private readonly quotaWorkGate: DaemonServerWorkGate | null;
  private readonly recordDiagnostic: ((event: ConnectedServiceQuotaCoordinatorDiagnostic) => void) | null;
  private readonly serverWorkScheduler: DaemonServerWorkScheduler;
  private readonly inBandQuotaPersistenceBackoff: KeyedBackoffTracker;
  private readonly inBandQuotaPersistenceScheduler: ConnectedServiceQuotaPersistenceScheduler<string, InBandQuotaPersistencePayload>;
  private readonly quotaPersistenceStateByKey = new Map<string, QuotaPersistenceMaterialState>();
  private readonly quotaPersistenceServerScope: string;
  private quotaPersistenceAccountScope: QuotaPersistenceAccountScope;
  private readonly quotaPersistenceAccountScopeCanRefresh: boolean;
  private quotaSnapshotFingerprintKey: QuotaSnapshotFingerprintKey;
  private readonly quotaPersistenceMinFreshnessMs: number;
  private readonly quotaLifecycleFreshnessMs: number;
  private readonly runtimeRegistry: ConnectedServiceRuntimeRegistry;
  private readonly qualifiedConnectedAccountRuntime:
    QualifiedConnectedAccountQuotaRuntime | null;
  private readonly runtimeAccountIdentities: RuntimeAccountIdentityIndex;
  private readonly failureStateByBindingKey = new Map<string, FailureState>();
  private readonly groupSwitchCheckAtByKey = new Map<string, number>();
  private readonly sameAccountFanoutAtByKey = new Map<string, number>();
  private readonly liveIdentityProbeUnsupportedSessionIds = new Set<string>();
  private readonly quotaLifecycleStateByGroupKey = new Map<string, ConnectedServiceAuthGroupQuotaLifecycleState>();
  private readonly onQuotaLifecycleTransition: ConnectedServiceQuotaLifecycleListener | null;
  private readonly recoveryCreditConsumeResultsByKey = new Map<string, ConnectedServiceQuotaRecoveryCreditConsumeResult>();
  private readonly recoveryCreditConsumeInFlightByKey = new Map<string, Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult>>();
  private readonly startupCurrentSourceRefreshByKey = new Map<string, ConnectedServiceUsageSourceV1>();
  private lastDiscoveryAt = 0;

  public constructor(params: Readonly<{
    api: QuotaApi;
    credentials: Credentials;
    quotaFetchers: ReadonlyArray<ConnectedServiceQuotaFetcher>;
    now: () => number;
    randomBytes: (length: number) => Uint8Array;
    fetchTimeoutMs?: number;
    failureBackoffMinMs?: number;
    failureBackoffMaxMs?: number;
    failureBackoffJitterPct?: number;
    discoveryEnabled?: boolean;
    discoveryIntervalMs?: number;
    runtimeQuotaSnapshots?: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
    accountUsageStore?: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId'> & AccountUsageStoreForAuthGroupSwitchState | null;
    accountUsagePersistence?: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
    machineIdProvider?: () => string | null | undefined;
    ownerIdProvider?: () => string | null | undefined;
    quotaFetchLeaseMs?: number;
    quotaFetchLeaseContentionWaitMaxMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
    authGroupSwitchCoordinator?: AuthGroupSwitchCoordinator | null;
    consumeCommittedAuthGroupGeneration?: ConsumeCommittedAuthGroupGeneration | null;
    predictiveSwitchGuard?: ConnectedServiceQuotaPredictiveSwitchGuard | null;
    /** @deprecated Ignored. Generation fan-out is live-only and never persists offline work. */
    recordPendingAuthGroupGeneration?: ((input: Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      groupId: string;
      activeProfileId: string;
      generation: number;
      credentialRevision?: import('@happier-dev/protocol').ConnectedServiceCredentialRevisionV1 | null;
      disposition: 'superseded_after_apply' | 'deferred_restart' | 'failed';
      errorCode: string | null;
    }>) => Promise<void>) | null;
    /** @deprecated Ignored. Exact current provider proof is runtime-owned and not persisted here. */
    clearAdoptedAuthGroupGeneration?: ((input: Readonly<{
      sessionId: string;
      providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget;
    }>) => Promise<void>) | null;
    sameAccountFanoutStrategyResolver?: SameAccountFanoutStrategyResolver;
    runtimeAuthApplyCapabilityResolver?: RuntimeAuthApplyCapabilityResolver | null;
    readRuntimeAccountIdentityForFanout?: RuntimeAccountIdentityFanoutReader | null;
    /**
     * Durable same-account fanout fallback proof source. When the live probe is UNAVAILABLE or INEXACT
     * (never on a VERIFIED mismatch), the candidate's persisted materialization identity can supply the
     * fanout proof — surviving the daemon restart that wipes the in-memory runtime identity index.
     */
    readPersistedSessionAccountIdentity?: PersistedSessionAccountIdentityReader | null;
    sameAccountFanoutMinIntervalMs?: number;
    sameAccountFanoutResetBucketMs?: number;
    runtimeAccountIdentityTtlMs?: number;
    groupSwitchCheckMinIntervalMs?: number;
    groupSwitchCheckJitterMs?: number;
    quotaWorkGate?: DaemonServerWorkGate | null;
    recordDiagnostic?: (event: ConnectedServiceQuotaCoordinatorDiagnostic) => void;
    serverWorkScheduler?: DaemonServerWorkScheduler;
    quotaPersistenceServerScope?: string;
    quotaPersistenceAccountScope?: string | QuotaPersistenceAccountScope;
    quotaPersistenceMinIntervalMs?: number;
    quotaPersistenceMinFreshnessMs?: number;
    quotaPersistenceMaxConcurrent?: number;
    quotaPersistenceMaxKeys?: number;
    quotaPersistenceMaxKeyAgeMs?: number;
    quotaPersistenceMaxPendingPayloadAgeMs?: number;
    quotaPersistenceFailureBackoffBaseMs?: number;
    quotaPersistenceFailureBackoffMaxMs?: number;
    quotaPersistenceFailureBackoffJitterRatio?: number;
    quotaPersistenceMaxConsecutiveFailures?: number;
    quotaLifecycleFreshnessMs?: number;
    onQuotaLifecycleTransition?: ConnectedServiceQuotaLifecycleListener | null;
    runtimeRegistry?: ConnectedServiceRuntimeRegistry;
    qualifiedConnectedAccountRuntime?:
      QualifiedConnectedAccountQuotaRuntime | null;
  }>) {
    this.api = params.api;
    this.credentials = params.credentials;
    this.now = params.now;
    this.randomBytes = params.randomBytes;
    this.quotaFetchersByServiceId = new Map(params.quotaFetchers.map((f) => [f.serviceId, f]));
    this.fetchTimeoutMs =
      typeof params.fetchTimeoutMs === 'number' && Number.isFinite(params.fetchTimeoutMs)
        ? Math.max(1, Math.trunc(params.fetchTimeoutMs))
        : 15_000;
    this.failureBackoffMinMs =
      typeof params.failureBackoffMinMs === 'number' && Number.isFinite(params.failureBackoffMinMs)
        ? Math.max(1, Math.trunc(params.failureBackoffMinMs))
        : 30_000;
    this.failureBackoffMaxMs =
      typeof params.failureBackoffMaxMs === 'number' && Number.isFinite(params.failureBackoffMaxMs)
        ? Math.max(this.failureBackoffMinMs, Math.trunc(params.failureBackoffMaxMs))
        : 10 * 60_000;
    this.failureBackoffJitterPct =
      typeof params.failureBackoffJitterPct === 'number' && Number.isFinite(params.failureBackoffJitterPct)
        ? Math.min(1, Math.max(0, params.failureBackoffJitterPct))
        : 0.2;
    this.discoveryEnabled = typeof params.discoveryEnabled === 'boolean' ? params.discoveryEnabled : true;
    this.discoveryIntervalMs =
      typeof params.discoveryIntervalMs === 'number' && Number.isFinite(params.discoveryIntervalMs)
        ? Math.max(1, Math.trunc(params.discoveryIntervalMs))
        : 60_000;
    this.runtimeQuotaSnapshots = params.runtimeQuotaSnapshots ?? null;
    this.accountUsageStore = params.accountUsageStore ?? null;
    this.accountUsagePersistence = params.accountUsagePersistence ?? null;
    this.machineIdProvider = typeof params.machineIdProvider === 'function' ? params.machineIdProvider : null;
    this.ownerIdProvider = typeof params.ownerIdProvider === 'function' ? params.ownerIdProvider : null;
    this.quotaFetchLeaseMs =
      typeof params.quotaFetchLeaseMs === 'number' && Number.isFinite(params.quotaFetchLeaseMs)
        ? Math.max(1, Math.trunc(params.quotaFetchLeaseMs))
        : 30_000;
    this.quotaFetchLeaseContentionWaitMaxMs =
      typeof params.quotaFetchLeaseContentionWaitMaxMs === 'number' && Number.isFinite(params.quotaFetchLeaseContentionWaitMaxMs)
        ? Math.max(0, Math.trunc(params.quotaFetchLeaseContentionWaitMaxMs))
        : 5_000;
    this.sleepMs = params.sleepMs ?? defaultSleepMs;
    this.authGroupSwitchCoordinator = params.authGroupSwitchCoordinator ?? null;
    this.consumeCommittedAuthGroupGeneration = params.consumeCommittedAuthGroupGeneration ?? null;
    this.predictiveSwitchGuard = params.predictiveSwitchGuard ?? null;
    this.sameAccountFanoutStrategyResolver = params.sameAccountFanoutStrategyResolver
      ?? (() => 'none');
    this.runtimeAuthApplyCapabilityResolver = params.runtimeAuthApplyCapabilityResolver ?? null;
    this.readRuntimeAccountIdentityForFanout = params.readRuntimeAccountIdentityForFanout ?? null;
    this.readPersistedSessionAccountIdentity = params.readPersistedSessionAccountIdentity ?? null;
    this.groupSwitchCheckMinIntervalMs =
      typeof params.groupSwitchCheckMinIntervalMs === 'number' && Number.isFinite(params.groupSwitchCheckMinIntervalMs)
        ? Math.max(0, Math.trunc(params.groupSwitchCheckMinIntervalMs))
        : 60_000;
    this.groupSwitchCheckJitterMs =
      typeof params.groupSwitchCheckJitterMs === 'number' && Number.isFinite(params.groupSwitchCheckJitterMs)
        ? Math.max(0, Math.trunc(params.groupSwitchCheckJitterMs))
        : 5_000;
    this.sameAccountFanoutMinIntervalMs =
      typeof params.sameAccountFanoutMinIntervalMs === 'number' && Number.isFinite(params.sameAccountFanoutMinIntervalMs)
        ? Math.max(0, Math.trunc(params.sameAccountFanoutMinIntervalMs))
        : 60_000;
    this.sameAccountFanoutResetBucketMs =
      typeof params.sameAccountFanoutResetBucketMs === 'number' && Number.isFinite(params.sameAccountFanoutResetBucketMs)
        ? Math.max(1, Math.trunc(params.sameAccountFanoutResetBucketMs))
        : 60_000;
    this.quotaWorkGate = params.quotaWorkGate ?? null;
    this.recordDiagnostic = params.recordDiagnostic ?? null;
    this.runtimeAccountIdentities = new RuntimeAccountIdentityIndex({
      nowMs: this.now,
      ...(typeof params.runtimeAccountIdentityTtlMs === 'number' ? { ttlMs: params.runtimeAccountIdentityTtlMs } : {}),
    });
    this.quotaPersistenceServerScope = String(params.quotaPersistenceServerScope ?? 'active-server').trim() || 'active-server';
    this.quotaPersistenceAccountScope =
      params.quotaPersistenceAccountScope === undefined
        ? resolveQuotaPersistenceAccountScope(params.credentials)
        : normalizeQuotaPersistenceAccountScopeInput(params.quotaPersistenceAccountScope);
    this.quotaPersistenceAccountScopeCanRefresh = params.quotaPersistenceAccountScope === undefined;
    this.quotaSnapshotFingerprintKey = deriveQuotaSnapshotFingerprintKey({
      credentials: params.credentials,
      serverScope: this.quotaPersistenceServerScope,
      accountScope: accountScopeFingerprintMaterial(this.quotaPersistenceAccountScope),
    });
    const quotaPersistenceMaxConcurrent =
      typeof params.quotaPersistenceMaxConcurrent === 'number' && Number.isFinite(params.quotaPersistenceMaxConcurrent)
        ? Math.max(1, Math.trunc(params.quotaPersistenceMaxConcurrent))
        : 1;
    this.serverWorkScheduler = params.serverWorkScheduler ?? createDaemonServerWorkScheduler({
      budget: createDaemonServerWorkBudget({ maxConcurrentWrites: quotaPersistenceMaxConcurrent }),
    });
    this.quotaPersistenceMinFreshnessMs =
      typeof params.quotaPersistenceMinFreshnessMs === 'number' && Number.isFinite(params.quotaPersistenceMinFreshnessMs)
        ? Math.max(0, Math.trunc(params.quotaPersistenceMinFreshnessMs))
        : DEFAULT_QUOTA_PERSISTENCE_MIN_FRESHNESS_MS;
    this.quotaLifecycleFreshnessMs =
      typeof params.quotaLifecycleFreshnessMs === 'number' && Number.isFinite(params.quotaLifecycleFreshnessMs)
        ? Math.max(0, Math.trunc(params.quotaLifecycleFreshnessMs))
        : this.quotaPersistenceMinFreshnessMs;
    this.onQuotaLifecycleTransition = params.onQuotaLifecycleTransition ?? null;
    this.runtimeRegistry = params.runtimeRegistry ?? new ConnectedServiceRuntimeRegistry();
    this.qualifiedConnectedAccountRuntime =
      params.qualifiedConnectedAccountRuntime ?? null;
    this.inBandQuotaPersistenceBackoff = createKeyedBackoffTracker({
      baseDelayMs:
        typeof params.quotaPersistenceFailureBackoffBaseMs === 'number' && Number.isFinite(params.quotaPersistenceFailureBackoffBaseMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceFailureBackoffBaseMs))
          : 1_000,
      maxDelayMs:
        typeof params.quotaPersistenceFailureBackoffMaxMs === 'number' && Number.isFinite(params.quotaPersistenceFailureBackoffMaxMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceFailureBackoffMaxMs))
          : 60_000,
      jitterRatio:
        typeof params.quotaPersistenceFailureBackoffJitterRatio === 'number' && Number.isFinite(params.quotaPersistenceFailureBackoffJitterRatio)
          ? Math.min(1, Math.max(0, params.quotaPersistenceFailureBackoffJitterRatio))
          : 0.2,
      now: this.now,
      random: () => randomRatioFromBytes(this.randomBytes),
    });
    this.inBandQuotaPersistenceScheduler = createConnectedServiceQuotaPersistenceScheduler({
      run: async (_key, payload) => {
        await this.flushInBandQuotaPersistencePayload(payload);
      },
      maxConcurrent: quotaPersistenceMaxConcurrent,
      minKeyIntervalMs:
        typeof params.quotaPersistenceMinIntervalMs === 'number' && Number.isFinite(params.quotaPersistenceMinIntervalMs)
          ? Math.max(0, Math.trunc(params.quotaPersistenceMinIntervalMs))
          : 5_000,
      maxKeys:
        typeof params.quotaPersistenceMaxKeys === 'number' && Number.isFinite(params.quotaPersistenceMaxKeys)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxKeys))
          : 1_024,
      maxKeyAgeMs:
        typeof params.quotaPersistenceMaxKeyAgeMs === 'number' && Number.isFinite(params.quotaPersistenceMaxKeyAgeMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxKeyAgeMs))
          : 60 * 60_000,
      maxPendingPayloadAgeMs:
        typeof params.quotaPersistenceMaxPendingPayloadAgeMs === 'number' && Number.isFinite(params.quotaPersistenceMaxPendingPayloadAgeMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxPendingPayloadAgeMs))
          : 5 * 60_000,
      maxConsecutiveFailures:
        typeof params.quotaPersistenceMaxConsecutiveFailures === 'number' && Number.isFinite(params.quotaPersistenceMaxConsecutiveFailures)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxConsecutiveFailures))
          : 5,
      now: this.now,
      backoff: this.inBandQuotaPersistenceBackoff,
      shouldRetry: isRetryableQuotaPersistenceError,
      shouldPauseAfterFailure: shouldPauseQuotaPersistenceAfterFailure,
      onEvent: (event) => {
        if (event.type === 'coalesced' || event.type === 'suppressed' || event.type === 'deferred') {
          this.serverWorkScheduler.recordEvent({
            purpose: 'connectedServiceQuotaPersistence',
            key: event.key,
            type: event.type,
          });
        }
      },
    });
  }

  public registerSpawnTarget(params: Readonly<{
    pid: number;
    sessionId?: string;
    agentId?: string;
    connectedServicesBindingsRaw: ConnectedServicesBindingsV1Like;
    connectedServiceSelectionsEnv?: Readonly<Record<string, string | undefined>>;
  }>): void {
    const pid = Math.trunc(Number(params.pid));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : '';
    if (sessionId) {
      this.runtimeAccountIdentities.invalidateSession(sessionId);
      this.liveIdentityProbeUnsupportedSessionIds.delete(sessionId);
    }
    this.runtimeRegistry.registerTarget({
      pid,
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw ?? {},
      ...(params.connectedServiceSelectionsEnv ? { connectedServiceSelectionsEnv: params.connectedServiceSelectionsEnv } : {}),
    });
  }

  public updateSpawnTargetSessionId(params: Readonly<{
    pid: number;
    sessionId?: string;
  }>): void {
    const pid = Math.trunc(Number(params.pid));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const target = this.runtimeRegistry.getByPid(pid);
    if (!target) return;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    if (!sessionId) return;
    if (target.sessionId === sessionId) return;
    if (target.sessionId) {
      this.runtimeAccountIdentities.invalidateSession(target.sessionId);
      this.liveIdentityProbeUnsupportedSessionIds.delete(target.sessionId);
    }
    this.runtimeAccountIdentities.invalidateSession(sessionId);
    this.liveIdentityProbeUnsupportedSessionIds.delete(sessionId);
    this.runtimeRegistry.adoptSessionId({ pid, sessionId });
  }

  public unregisterPid(pidRaw: number): void {
    const pid = Math.trunc(Number(pidRaw));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const target = this.runtimeRegistry.getByPid(pid);
    if (target?.sessionId) {
      this.runtimeAccountIdentities.invalidateSession(target.sessionId);
      this.liveIdentityProbeUnsupportedSessionIds.delete(target.sessionId);
    }
    this.runtimeRegistry.unregisterPid(pid);
  }

  public transferPid(fromPidRaw: number, toPidRaw: number): void {
    const fromPid = Math.trunc(Number(fromPidRaw));
    const toPid = Math.trunc(Number(toPidRaw));
    if (!Number.isFinite(fromPid) || fromPid <= 0 || !Number.isFinite(toPid) || toPid <= 0) return;
    const target = this.runtimeRegistry.getByPid(fromPid);
    if (!target) return;
    if (target.sessionId) this.liveIdentityProbeUnsupportedSessionIds.delete(target.sessionId);
    this.runtimeRegistry.transferPid(fromPid, toPid);
  }

  private makeBindingKey(params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>): string {
    return `${params.serviceId}\u0000${params.profileId}`;
  }

  public recordRequestAuthProviderBackoff(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    groupId: string | null;
    groupGeneration: number | null;
    limitCategory: ConnectedServiceLimitCategoryV1;
    quotaScope: ProviderAccountUsageQuotaScopeV1;
    retryAfterMs: number | null;
    resetAtMs: number | null;
    providerCode: string | null;
  }>): Readonly<{
    status: 'recorded';
    consecutiveFailures: number;
    nextAllowedAtMs: number;
  }> {
    const now = this.now();
    const key = this.makeBindingKey(input);
    this.applyFailureBackoff({
      now,
      key,
      error: {
        retryAfterMs: input.retryAfterMs,
        resetAtMs: input.resetAtMs,
      },
    });
    const state = this.failureStateByBindingKey.get(key);
    if (!state) {
      throw new Error('Connected Service request-auth backoff was not recorded');
    }
    const retryAfterMs = Math.max(0, state.nextAllowedAt - now);
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'probe_group',
      reason: 'request_auth_provider_backoff',
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
      serviceId: input.serviceId,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      activeProfileId: input.profileId,
      decisionTrace: {
        groupGeneration: input.groupGeneration,
        limitCategory: input.limitCategory,
        quotaScope: input.quotaScope,
        providerCode: input.providerCode,
        nextAllowedAtMs: state.nextAllowedAt,
      },
    });
    return {
      status: 'recorded',
      consecutiveFailures: state.consecutiveFailures,
      nextAllowedAtMs: state.nextAllowedAt,
    };
  }

  private refreshQuotaPersistenceAccountScope(): void {
    if (!this.quotaPersistenceAccountScopeCanRefresh) return;
    const nextScope = resolveQuotaPersistenceAccountScope(this.credentials);
    if (nextScope.kind !== 'known') return;
    if (
      this.quotaPersistenceAccountScope.kind === 'known'
      && this.quotaPersistenceAccountScope.value === nextScope.value
    ) {
      return;
    }
    this.quotaPersistenceAccountScope = nextScope;
    this.quotaSnapshotFingerprintKey = deriveQuotaSnapshotFingerprintKey({
      credentials: this.credentials,
      serverScope: this.quotaPersistenceServerScope,
      accountScope: accountScopeFingerprintMaterial(this.quotaPersistenceAccountScope),
    });
  }

  private buildQuotaPersistenceKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): string {
    this.refreshQuotaPersistenceAccountScope();
    return buildQuotaPersistenceKeyValue({
      serverScope: this.quotaPersistenceServerScope,
      accountScope: this.quotaPersistenceAccountScope,
      serviceId: input.serviceId,
      profileId: input.profileId,
    });
  }

  private computeQuotaMaterialFingerprint(snapshot: ConnectedServiceQuotaSnapshotV1): string {
    this.refreshQuotaPersistenceAccountScope();
    return computeQuotaSnapshotFingerprint(snapshot, this.quotaSnapshotFingerprintKey);
  }

  private recordQuotaPersistenceStateFromExisting(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    existing: ExistingQuotaSnapshotResponse;
  }>): void {
    const metadata = input.existing?.metadata;
    if (!metadata) return;
    const materialFingerprint =
      typeof metadata.materialFingerprint === 'string' && metadata.materialFingerprint.trim()
        ? metadata.materialFingerprint
        : this.computeQuotaMaterialFingerprint(input.snapshot);
    const fetchedAt = readFiniteNonNegativeMs(metadata.fetchedAt) ?? input.snapshot.fetchedAt;
    const staleAfterMs = readFiniteNonNegativeMs(metadata.staleAfterMs) ?? input.snapshot.staleAfterMs;
    const refreshRequestedAt = readFiniteNonNegativeMs(metadata.refreshRequestedAt);
    this.quotaPersistenceStateByKey.set(this.buildQuotaPersistenceKey(input), {
      fingerprint: materialFingerprint,
      fetchedAt,
      staleAfterMs,
      status: metadata.status ?? deriveQuotaSnapshotStatus(input.snapshot),
      ...(refreshRequestedAt === null ? {} : { refreshRequestedAt }),
    });
  }

  private recordRuntimeProfileSnapshot(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>): void {
    this.runtimeQuotaSnapshots?.recordProfileSnapshot(input);
  }

  private async clearPersistedMemberRuntimeBlockersWithQuotaEvidence(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    now: number;
    authenticatedProbe?: boolean;
    groupContexts?: ReadonlyArray<ConnectedServiceQuotaGroupContext> | null;
    groupTargets?: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | null;
  }>): Promise<void> {
    if (
      typeof this.api.getConnectedServiceAuthGroup !== 'function'
      || typeof this.api.updateConnectedServiceAuthGroupRuntimeState !== 'function'
    ) {
      return;
    }

    const profileId = input.profileId.trim();
    if (!profileId) return;

    const contexts: ConnectedServiceQuotaGroupContext[] = [
      ...(input.groupContexts ?? []),
      ...(input.groupTargets ?? []).map((target) => ({
        groupId: target.groupId,
        groupGeneration: target.groupGeneration,
      })),
    ];
    const quotaEvidence = projectConnectedServiceQuotaSnapshotToAuthGroupQuotaEvidence(input.snapshot);
    const visited = new Set<string>();

    for (const context of contexts) {
      const groupId = context.groupId.trim();
      const expectedGeneration = normalizeNullableGeneration(context.groupGeneration);
      if (!groupId || expectedGeneration === null) continue;
      const visitKey = `${groupId}\u0000${expectedGeneration}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      await updateConnectedServiceAuthGroupRuntimeStateWithRetry({
        serviceId: input.serviceId,
        groupId,
        expectedGeneration,
        loadGroup: async () => {
          if (!this.shouldRunLegacyQuotaFetcher(
            input.serviceId,
            this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
            'provider_account_usage_write',
          )) {
            return null;
          }
          return await this.api.getConnectedServiceAuthGroup!({
            serviceId: input.serviceId,
            groupId,
          });
        },
        buildPatch: (group) => {
          const member = group.members.find((candidate) => candidate.profileId.trim() === profileId) ?? null;
          if (!member) return null;
          const reconciled = reconcileMemberRuntimeStateWithFreshQuotaEvidence({
            state: member.state,
            quotaSnapshot: quotaEvidence,
            nowMs: input.now,
            authenticatedProbe:
              input.authenticatedProbe,
          });
          if (!reconciled || reconciled === member.state) return null;
          return {
            memberStates: [{
              profileId,
              state: reconciled,
            }],
          };
        },
        update: async (patch) => {
          if (!this.shouldRunLegacyQuotaFetcher(
            input.serviceId,
            this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
            'provider_account_usage_write',
          )) {
            throw new Error(
              'Connected-service group runtime update is unsupported by the current peer',
            );
          }
          return await this.api.updateConnectedServiceAuthGroupRuntimeState!({
            ...patch,
            memberStates: [...patch.memberStates],
          });
        },
      }).catch(() => null);
    }
  }

  private async recordFetchedQuotaSnapshotAsAccountUsage(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    now: number;
    sourceProviderAccountId?: string | null;
    groupId?: string | null;
    authenticatedProbe?: boolean;
    groupContexts?: ReadonlyArray<ConnectedServiceQuotaGroupContext> | null;
    groupTargets?: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | null;
  }>): Promise<ProviderAccountUsageSnapshotV1 | null> {
    const store = this.accountUsageStore;
    if (
      !store
      || !this.shouldRunLegacyQuotaFetcher(
        input.serviceId,
        this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
        'provider_account_usage_write',
      )
    ) {
      return null;
    }

    const groupGenerationsById = new Map<string, Set<number>>();
    const displayOnlyGroupIds = new Set<string>();
    const explicitGroupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    if (explicitGroupId) displayOnlyGroupIds.add(explicitGroupId);
    for (const context of input.groupContexts ?? []) {
      const contextGroupId = context.groupId.trim();
      if (!contextGroupId) continue;
      if (context.groupGeneration === null) {
        displayOnlyGroupIds.add(contextGroupId);
        continue;
      }
      const existing = groupGenerationsById.get(contextGroupId) ?? new Set<number>();
      existing.add(context.groupGeneration);
      groupGenerationsById.set(contextGroupId, existing);
    }
    for (const target of input.groupTargets ?? []) {
      const targetGroupId = target.groupId.trim();
      if (!targetGroupId) continue;
      if (target.groupGeneration === null) {
        displayOnlyGroupIds.add(targetGroupId);
        continue;
      }
      const existing = groupGenerationsById.get(targetGroupId) ?? new Set<number>();
      existing.add(target.groupGeneration);
      groupGenerationsById.set(targetGroupId, existing);
    }

    let latest: ProviderAccountUsageSnapshotV1 | null = null;
    let effectiveMutationRecorded = false;
    let persistenceObservationRecorded = false;
    const persistenceSourcesByKey = new Map<string, ConnectedServiceUsageSourceV1>();
    const rememberPersistenceSource = (source: ConnectedServiceUsageSourceV1): ConnectedServiceUsageSourceV1 => {
      const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
      const key = parsed.bindingKind === 'group_member'
        ? JSON.stringify(['group_member', parsed.serviceId, parsed.profileId, parsed.groupId ?? '', parsed.groupGeneration ?? null])
        : JSON.stringify(['profile', parsed.serviceId, parsed.profileId]);
      persistenceSourcesByKey.set(key, parsed);
      return parsed;
    };
    const profileSnapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: input.snapshot,
      observedAtMs: input.now,
      sourceProviderAccountId: input.sourceProviderAccountId,
    });
    const sourceProviderAccountId = typeof input.sourceProviderAccountId === 'string'
      ? input.sourceProviderAccountId.trim()
      : '';
    const canPersistSourceLinks = canPersistUsageSourceLinkWithProviderIdentity({
      sourceProviderAccountId,
      recordKey: profileSnapshot.recordKey,
    });
    const profileRecord = store.recordSnapshot(profileSnapshot, {
      sources: canPersistSourceLinks
        ? [rememberPersistenceSource({
          serviceId: input.serviceId,
          profileId: input.profileId,
          bindingKind: 'profile',
        })]
        : [],
    });
    effectiveMutationRecorded ||= isProviderAccountUsageStoreMutationAccepted(profileRecord);
    persistenceObservationRecorded ||= profileRecord.status !== 'older';
    latest = store.resolveRecordId(profileRecord.recordId) ?? profileSnapshot;

    for (const groupId of displayOnlyGroupIds) {
      const groupSnapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
        snapshot: input.snapshot,
        observedAtMs: input.now,
        sourceProviderAccountId: input.sourceProviderAccountId,
      });
      const groupRecord = store.recordSnapshot(groupSnapshot, {
        sources: canPersistSourceLinks
          ? [rememberPersistenceSource({
            serviceId: input.serviceId,
            profileId: input.profileId,
            bindingKind: 'group_member',
            groupId,
          })]
          : [],
      });
      effectiveMutationRecorded ||= isProviderAccountUsageStoreMutationAccepted(groupRecord);
      persistenceObservationRecorded ||= groupRecord.status !== 'older';
      latest = store.resolveRecordId(groupRecord.recordId) ?? groupSnapshot;
    }
    for (const [groupId, groupGenerations] of groupGenerationsById.entries()) {
      for (const groupGeneration of groupGenerations) {
        const groupSnapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
          snapshot: input.snapshot,
          observedAtMs: input.now,
          sourceProviderAccountId: input.sourceProviderAccountId,
        });
        const groupRecord = store.recordSnapshot(groupSnapshot, {
          sources: canPersistSourceLinks
            ? [rememberPersistenceSource({
              serviceId: input.serviceId,
              profileId: input.profileId,
              bindingKind: 'group_member',
              groupId,
              groupGeneration,
            })]
            : [],
        });
        effectiveMutationRecorded ||= isProviderAccountUsageStoreMutationAccepted(groupRecord);
        persistenceObservationRecorded ||= groupRecord.status !== 'older';
        latest = store.resolveRecordId(groupRecord.recordId) ?? groupSnapshot;
      }
    }

    if (effectiveMutationRecorded) {
      await this.clearPersistedMemberRuntimeBlockersWithQuotaEvidence({
        serviceId: input.serviceId,
        profileId: input.profileId,
        snapshot: input.snapshot,
        now: input.now,
        authenticatedProbe:
          input.authenticatedProbe,
        groupContexts: input.groupContexts,
        groupTargets: input.groupTargets,
      });
    }

    if (
      latest
      && persistenceObservationRecorded
      && this.accountUsagePersistence
    ) {
      await this.accountUsagePersistence.recordInBandSnapshot(latest, {
        sources: [...persistenceSourcesByKey.values()],
      }).catch(() => null);
    }

    if (latest && effectiveMutationRecorded) {
      const notifiedTargets = new Set<string>();
      for (const target of input.groupTargets ?? []) {
        if (target.groupGeneration === null) continue;
        const key = `${target.sessionId}\u0000${target.serviceId}\u0000${target.groupId}\u0000${target.groupGeneration}`;
        if (notifiedTargets.has(key)) continue;
        notifiedTargets.add(key);
        await this.handleAccountUsageChanged({
          sessionId: target.sessionId,
          serviceId: target.serviceId,
          groupId: target.groupId,
          profileId: input.profileId,
          groupGeneration: target.groupGeneration,
          recordId: latest.recordId,
          snapshot: latest,
          // The poll performs its OWN soft-switch check for these targets; suppress the reactive
          // burn-projected re-check here so a fetch does not double-request the switch. Only genuine
          // in-band snapshot deliveries (outside the poll) drive the reactive preemptive path.
          source: 'poll',
        });
      }
    }

    return latest;
  }

  private resolveCredentialOpenMaterial(): QuotaCredentialOpenMaterial {
    const encryption = this.credentials.encryption;
    return encryption.type === 'legacy'
      ? ({ type: 'legacy' as const, secret: encryption.secret })
      : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });
  }

  private openExistingQuotaSnapshot(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    existing: ExistingQuotaSnapshotResponse;
    material: QuotaCredentialOpenMaterial;
  }>): ConnectedServiceQuotaSnapshotV1 | null {
    if (!input.existing) return null;
    if (
      input.accountMode !== 'e2ee'
      && 'content' in input.existing
      && input.existing.content?.t === 'plain'
    ) {
      try {
        return parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(
          input.existing.content.v,
        );
      } catch {
        return null;
      }
    }
    if (!('sealed' in input.existing) || !input.existing.sealed?.ciphertext) return null;
    const opened = openConnectedServiceQuotaSnapshotCiphertext({
      material: input.material,
      ciphertext: input.existing.sealed.ciphertext,
    });
    try {
      return parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(
        opened?.value,
      );
    } catch {
      return null;
    }
  }

  private async readFreshExistingQuotaSnapshot(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    serviceId: ConnectedServiceId;
    profileId: string;
    now: number;
    leaseUntil?: number;
    material: QuotaCredentialOpenMaterial;
  }>): Promise<ConnectedServiceQuotaSnapshotV1 | null> {
    if (typeof input.leaseUntil === 'number' && Number.isFinite(input.leaseUntil)) {
      const waitMs = Math.min(
        this.quotaFetchLeaseContentionWaitMaxMs,
        Math.max(0, Math.trunc(input.leaseUntil - input.now)),
      );
      if (waitMs > 0) await this.sleepMs(waitMs);
    }
    const observed = await this.readExistingQuotaSnapshot(input).catch(() => null);
    if (!this.isExistingQuotaSnapshotFresh({
      existing: observed,
      now: this.now(),
      forcedRefresh: this.shouldForceQuotaRefresh(observed),
    })) {
      return null;
    }
    return this.openExistingQuotaSnapshot({
      accountMode: input.accountMode,
      existing: observed,
      material: input.material,
    });
  }

  public scheduleCurrentSourceRefresh(
    sources: readonly ConnectedServiceUsageSourceV1[],
  ): Readonly<{ accepted: number; ignored: number }> {
    let accepted = 0;
    let ignored = 0;
    const qualifiedPeerClass =
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null;
    for (const candidate of sources) {
      const parsed = ConnectedServiceUsageSourceV1Schema.safeParse(candidate);
      if (
        !parsed.success
        || !this.quotaFetchersByServiceId.has(parsed.data.serviceId)
        || !this.shouldRunLegacyQuotaFetcher(
          parsed.data.serviceId,
          qualifiedPeerClass,
        )
      ) {
        ignored += 1;
        continue;
      }
      const key = parsed.data.bindingKind === 'profile'
        ? JSON.stringify([parsed.data.serviceId, parsed.data.profileId, 'profile'])
        : JSON.stringify([
          parsed.data.serviceId,
          parsed.data.profileId,
          'group_member',
          parsed.data.groupId,
          parsed.data.groupGeneration ?? null,
        ]);
      if (this.startupCurrentSourceRefreshByKey.has(key) || this.startupCurrentSourceRefreshByKey.size >= 256) {
        ignored += 1;
        continue;
      }
      this.startupCurrentSourceRefreshByKey.set(key, parsed.data);
      accepted += 1;
    }
    return { accepted, ignored };
  }

  private hasScheduledCurrentSourceRefreshForBinding(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): boolean {
    return [...this.startupCurrentSourceRefreshByKey.values()].some((source) => (
      source.serviceId === input.serviceId && source.profileId === input.profileId
    ));
  }

  private async readCredentialRecordForQuotaFetch(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    material: QuotaCredentialOpenMaterial;
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<ResolvedQuotaFetchCredential | null> {
    if (!this.shouldRunLegacyQuotaFetcher(
      input.serviceId,
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
      'credential_read',
    )) {
      return null;
    }
    let record: ConnectedServiceCredentialRecordV1 | null = null;
    let credentialRevision: ReturnType<
      typeof ConnectedServiceCredentialRevisionV1Schema.parse
    > | null = null;
    let credentialStorageMode: 'e2ee' | 'plain' = 'e2ee';

    if (input.accountMode !== 'e2ee') {
      if (typeof this.api.getConnectedServiceCredentialPlain === 'function') {
        const plainCred = await this.api.getConnectedServiceCredentialPlain({
          serviceId: input.serviceId,
          profileId: input.profileId,
        }).catch(() => null);
        if (
          plainCred
          && plainCred.revisionSemantics !== 'revisioned'
        ) {
          return null;
        }
        if (plainCred?.content?.t === 'plain') {
          credentialRevision =
            ConnectedServiceCredentialRevisionV1Schema.parse(
              plainCred.credentialRevision,
            );
          record = assertConnectedServiceCredentialRecordBinding({
            binding: input,
            record: ConnectedServiceCredentialRecordV1Schema.parse(plainCred.content.v),
          });
          credentialStorageMode = 'plain';
        }
      }
      if (!record && input.accountMode === 'plain') return null;
    }

    if (!record) {
      const sealedCred = await this.api.getConnectedServiceCredentialSealed({
        serviceId: input.serviceId,
        profileId: input.profileId,
      });
      if (!sealedCred?.sealed?.ciphertext) return null;
      if (sealedCred.revisionSemantics !== 'revisioned') return null;
      credentialRevision =
        ConnectedServiceCredentialRevisionV1Schema.parse(
          sealedCred.credentialRevision,
        );

      const opened = openConnectedServiceCredentialCiphertext({
        material: input.material,
        ciphertext: sealedCred.sealed.ciphertext,
      });
      record = opened?.value
        ? assertConnectedServiceCredentialRecordBinding({
            binding: input,
            record: ConnectedServiceCredentialRecordV1Schema.parse(opened.value),
          })
        : null;
    }
    if (!record || !credentialRevision) return null;
    return { record, credentialRevision, credentialStorageMode };
  }

  private async fetchQuotaSnapshotForProfile(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    material: QuotaCredentialOpenMaterial;
    fetcher: ConnectedServiceQuotaFetcher;
    serviceId: ConnectedServiceId;
    profileId: string;
    credential?: ResolvedQuotaFetchCredential;
  }>): Promise<Readonly<{
    snapshot: ConnectedServiceQuotaSnapshotV1;
    credentialStorageMode: 'e2ee' | 'plain';
    sourceProviderAccountId: string;
  }> | null> {
    const credential =
      input.credential
      ?? await this.readCredentialRecordForQuotaFetch(input);
    if (!credential) return null;
    if (!this.shouldRunLegacyQuotaFetcher(
      input.serviceId,
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
      'quota_poll',
    )) {
      return null;
    }

    const controller = new AbortController();
    const timeoutMs = this.fetchTimeoutMs;
    const fetchPromise = input.fetcher.loadQuota({
      record: credential.record,
      now: this.now(),
      signal: controller.signal,
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<{ type: 'timeout' }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        try {
          controller.abort('quota-fetch-timeout');
        } catch {
          // ignore
        }
        resolve({ type: 'timeout' });
      }, timeoutMs);
      (timeoutHandle as unknown as { unref?: () => void })?.unref?.();
    });

    const raced = await Promise.race([
      fetchPromise.then(
        (snapshot) => ({ type: 'result' as const, snapshot }),
        (error) => ({ type: 'error' as const, error }),
      ),
      timeoutPromise,
    ]);

    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = null;

    if (raced.type === 'timeout') return null;
    if (raced.type === 'error') throw raced.error;
    if (!raced.snapshot) return null;

    return {
      snapshot: raced.snapshot,
      credentialStorageMode: credential.credentialStorageMode,
      sourceProviderAccountId: readCredentialProviderAccountId(credential.record),
    };
  }

  private async consumeRecoveryCreditWithTimeout(input: Readonly<{
    fetcher: ConnectedServiceQuotaFetcher;
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    idempotencyKey: string;
    providerCreditId?: string;
  }>): Promise<
    | Readonly<{ type: 'ok'; receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 }>
    | Readonly<{ type: 'timeout' }>
  > {
    if (!input.fetcher.consumeRecoveryCredit) return { type: 'timeout' };

    const controller = new AbortController();
    const timeoutMs = this.fetchTimeoutMs;
    const consumePromise = input.fetcher.consumeRecoveryCredit({
      record: input.record,
      now: input.now,
      idempotencyKey: input.idempotencyKey,
      ...(input.providerCreditId ? { providerCreditId: input.providerCreditId } : {}),
      signal: controller.signal,
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<{ type: 'timeout' }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        try {
          controller.abort('quota-recovery-credit-consume-timeout');
        } catch {
          // ignore
        }
        resolve({ type: 'timeout' });
      }, timeoutMs);
      (timeoutHandle as unknown as { unref?: () => void })?.unref?.();
    });

    const raced = await Promise.race([
      consumePromise.then(
        (receipt) => ({ type: 'result' as const, receipt }),
        (error) => ({ type: 'error' as const, error }),
      ),
      timeoutPromise,
    ]);

    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = null;

    if (raced.type === 'timeout') return raced;
    if (raced.type === 'error') throw raced.error;
    if (
      raced.receipt !== 'consumed'
      && raced.receipt !== 'already_consumed'
      && raced.receipt !== 'not_available'
      && raced.receipt !== 'nothing_to_reset'
    ) {
      throw new Error('connected_service_quota_recovery_credit_invalid_outcome');
    }
    return {
      type: 'ok',
      receipt: this.buildRecoveryCreditConsumeReceipt({
        idempotencyKey: input.idempotencyKey,
        ...(input.providerCreditId ? { providerCreditId: input.providerCreditId } : {}),
        status: raced.receipt,
      }),
    };
  }

  private buildRecoveryCreditConsumeReceipt(input: Readonly<{
    idempotencyKey: string;
    providerCreditId?: string;
    status: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1['status'];
  }>): ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 {
    return {
      idempotencyKey: input.idempotencyKey,
      ...(input.providerCreditId ? { providerCreditId: input.providerCreditId } : {}),
      status: input.status,
    };
  }

  private buildRecoveryCreditConsumeLedgerKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    idempotencyKey: string;
    providerCreditId?: string;
  }>): string {
    return [
      input.serviceId,
      input.profileId,
      input.providerCreditId ?? '',
      input.idempotencyKey,
    ].join('\u0000');
  }

  public async consumeRecoveryCreditForProfile(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    idempotencyKey: string;
    providerCreditId?: string;
  }>): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult> {
    const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
    const profileId = readNonEmptyString(input.profileId);
    if (!profileId) {
      return {
        ok: false,
        errorCode: 'connected_service_quota_recovery_credit_invalid_profile',
        error: 'connected_service_quota_recovery_credit_invalid_profile',
      };
    }
    const idempotencyKey = readNonEmptyString(input.idempotencyKey);
    if (!idempotencyKey) {
      return {
        ok: false,
        errorCode: 'connected_service_quota_recovery_credit_idempotency_key_required',
        error: 'connected_service_quota_recovery_credit_idempotency_key_required',
      };
    }
    const providerCreditId = readNonEmptyString(input.providerCreditId);
    const ledgerKey = this.buildRecoveryCreditConsumeLedgerKey({
      serviceId,
      profileId,
      idempotencyKey,
      ...(providerCreditId ? { providerCreditId } : {}),
    });
    const completed = this.recoveryCreditConsumeResultsByKey.get(ledgerKey);
    if (completed) return completed;
    const inFlight = this.recoveryCreditConsumeInFlightByKey.get(ledgerKey);
    if (inFlight) return await inFlight;

    const consumePromise = this.consumeRecoveryCreditForProfileOnce({
      serviceId,
      profileId,
      idempotencyKey,
      ...(providerCreditId ? { providerCreditId } : {}),
    });
    this.recoveryCreditConsumeInFlightByKey.set(ledgerKey, consumePromise);
    try {
      const result = await consumePromise;
      if (result.receipt) {
        this.recoveryCreditConsumeResultsByKey.set(ledgerKey, result);
      }
      return result;
    } finally {
      this.recoveryCreditConsumeInFlightByKey.delete(ledgerKey);
    }
  }

  private async consumeRecoveryCreditForProfileOnce(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    idempotencyKey: string;
    providerCreditId?: string;
  }>): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult> {
    const { serviceId, profileId, idempotencyKey, providerCreditId } = input;
    let consumedReceipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 | null = null;

    const qualifiedPeerClass =
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null;
    if (!this.shouldRunLegacyQuotaFetcher(
      serviceId,
      qualifiedPeerClass,
      'recovery_credit_consume',
    )) {
      return {
        ok: false,
        errorCode: 'connected_service_quota_recovery_credit_unavailable',
        error: 'connected_service_quota_recovery_credit_unavailable',
      };
    }
    const fetcher = this.quotaFetchersByServiceId.get(serviceId);
    if (!fetcher?.consumeRecoveryCredit) {
      return {
        ok: false,
        errorCode: 'connected_service_quota_recovery_credit_unavailable',
        error: 'connected_service_quota_recovery_credit_unavailable',
      };
    }

    try {
      const accountMode = await resolveConnectedServiceAccountMode(this.api);
      if (accountMode === 'unknown') {
        return {
          ok: false,
          errorCode: 'connected_service_quota_recovery_credit_account_mode_unknown',
          error: 'connected_service_quota_recovery_credit_account_mode_unknown',
        };
      }

      const material = this.resolveCredentialOpenMaterial();
      const credential = await this.readCredentialRecordForQuotaFetch({
        accountMode,
        material,
        serviceId,
        profileId,
      });
      if (!credential) {
        return {
          ok: false,
          errorCode: 'connected_service_quota_recovery_credit_credential_unavailable',
          error: 'connected_service_quota_recovery_credit_credential_unavailable',
        };
      }
      if (!this.shouldRunLegacyQuotaFetcher(
        serviceId,
        this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
        'recovery_credit_consume',
      )) {
        return {
          ok: false,
          errorCode:
            'connected_service_quota_recovery_credit_unavailable',
          error:
            'connected_service_quota_recovery_credit_unavailable',
        };
      }

      const consumed = await this.consumeRecoveryCreditWithTimeout({
        fetcher,
        record: credential.record,
        now: this.now(),
        idempotencyKey,
        ...(providerCreditId ? { providerCreditId } : {}),
      });
      if (consumed.type === 'timeout') {
        return {
          ok: false,
          errorCode: 'connected_service_quota_recovery_credit_timeout',
          error: 'connected_service_quota_recovery_credit_timeout',
          receipt: this.buildRecoveryCreditConsumeReceipt({
            idempotencyKey,
            ...(providerCreditId ? { providerCreditId } : {}),
            status: 'unknown_after_timeout',
          }),
        };
      }
      consumedReceipt = consumed.receipt;

      const fetched = await this.fetchQuotaSnapshotForProfile({
        accountMode,
        material,
        fetcher,
        serviceId,
        profileId,
        credential,
      });
      if (!fetched) {
        return {
          ok: false,
          errorCode: 'connected_service_quota_recovery_credit_refresh_unavailable',
          error: 'connected_service_quota_recovery_credit_refresh_unavailable',
          receipt: consumed.receipt,
        };
      }

      this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: fetched.snapshot });
      const recordedAccountUsage = await this.recordFetchedQuotaSnapshotAsAccountUsage({
        serviceId,
        profileId,
        snapshot: fetched.snapshot,
        now: this.now(),
        sourceProviderAccountId: fetched.sourceProviderAccountId,
      });
      if (!recordedAccountUsage) {
        await this.persistQuotaSnapshotWithServerWork({
          accountMode: fetched.credentialStorageMode,
          serviceId,
          profileId,
          snapshot: fetched.snapshot,
          sourceProviderAccountId: fetched.sourceProviderAccountId,
          materialFingerprint: this.computeQuotaMaterialFingerprint(fetched.snapshot),
        });
      }
      return {
        ok: true,
        snapshot: fetched.snapshot,
        receipt: consumed.receipt,
      };
    } catch (error) {
      return {
        ok: false,
          errorCode: 'connected_service_quota_recovery_credit_failed',
          error: error instanceof Error ? error.message : 'connected_service_quota_recovery_credit_failed',
          ...(consumedReceipt ? { receipt: consumedReceipt } : {}),
      };
    }
  }

  private makeGroupSwitchCheckKey(input: ActiveGroupQuotaSwitchTarget): string {
    return `${input.serviceId}\u0000${input.groupId}`;
  }

  private computeBoundedJitterMs(maxMs: number): number {
    const capped = Math.max(0, Math.trunc(maxMs));
    if (capped <= 0) return 0;
    const bytes = this.randomBytes(4);
    const u32 =
      ((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0);
    const normalized = (u32 >>> 0) / 0xffffffff;
    return Math.trunc(normalized * capped);
  }

  private findSpawnTargetForSession(sessionIdRaw: string): SpawnTarget | null {
    const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
    if (!sessionId) return null;
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      if (target.sessionId === sessionId) return target;
    }
    return null;
  }

  private async resolveSameAccountFanoutStrategy(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceSameAccountFanoutStrategy> {
    const sourceTarget = this.findSpawnTargetForSession(input.sourceSessionId);
    return normalizeConnectedServiceSameAccountFanoutStrategy(await this.sameAccountFanoutStrategyResolver({
      agentId: sourceTarget?.agentId ?? null,
      serviceId: input.serviceId,
      sourceSessionId: input.sourceSessionId,
      groupId: input.groupId,
    }));
  }

  private resolveGroupGenerationForSession(input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): number | null {
    const target = this.findSpawnTargetForSession(input.sessionId);
    if (!target) return null;
    const selection = readConnectedServiceChildSelectionsFromEnv(target.connectedServiceSelectionsEnv ?? {})
      ?.get(input.serviceId);
    if (!selection || selection.kind !== 'group' || selection.groupId !== input.groupId) return null;
    return normalizeNullableGeneration(selection.generation);
  }

  private buildCurrentGroupGenerationBySessionId(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Map<string, number | null> {
    const generations = new Map<string, number | null>();
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
      if (!sessionId) continue;
      const selection = readConnectedServiceChildSelectionsFromEnv(target.connectedServiceSelectionsEnv ?? {})
        ?.get(input.serviceId);
      generations.set(
        sessionId,
        selection?.kind === 'group' && selection.groupId === input.groupId
          ? normalizeNullableGeneration(selection.generation)
          : null,
      );
    }
    return generations;
  }

  private hasActiveSpawnTargetForIdentity(entry: RuntimeAccountIdentityEntry): boolean {
    const target = this.findSpawnTargetForSession(entry.sessionId);
    if (!target) return false;
    const bindings = extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv);
    return bindings.some((binding) => activeBindingMatchesRuntimeIdentity(binding, entry));
  }

  private buildSameAccountFanoutCandidateFromIdentity(
    entry: RuntimeAccountIdentityEntry,
    groupId: string,
  ): SameAccountFanoutCandidateIdentity | null {
    if (!this.hasActiveSpawnTargetForIdentity(entry)) return null;
    const target = this.findSpawnTargetForSession(entry.sessionId);
    return {
      candidate: {
        sessionId: entry.sessionId,
        serviceId: entry.serviceId,
        groupId: entry.groupId ?? groupId,
        activeProfileId: entry.profileId,
        groupGeneration: entry.groupGeneration,
        ...(target?.agentId ? { agentId: target.agentId } : {}),
      },
      accountLabel: entry.accountLabel,
      observedProfileId: entry.profileId,
      deferUntilTurnBoundary: false,
    };
  }

  private recordSameAccountFanoutDiagnostic(
    reason: string,
    event: ConnectedServiceQuotaCoordinatorDiagnostic['event'] = 'quota_work_suppressed',
    retryAfterMs?: number,
    diagnostic?: RuntimeIdentityFanoutSuppressionDiagnostic,
    decisionTrace?: unknown,
  ): void {
    this.recordDiagnostic?.({
      event,
      phase: 'same_account_fanout',
      reason,
      ...(decisionTrace === undefined ? {} : { decisionTrace }),
      ...(diagnostic?.sessionId ? { sessionId: diagnostic.sessionId } : {}),
      ...(diagnostic?.expectedProviderAccountId === undefined
        ? {}
        : { expectedProviderAccountId: diagnostic.expectedProviderAccountId }),
      ...(diagnostic?.actualProviderAccountId === undefined
        ? {}
        : { actualProviderAccountId: diagnostic.actualProviderAccountId }),
      ...(diagnostic?.expectedProfileId === undefined ? {} : { expectedProfileId: diagnostic.expectedProfileId }),
      ...(diagnostic?.actualProfileId === undefined ? {} : { actualProfileId: diagnostic.actualProfileId }),
      ...(diagnostic?.expectedGroupId === undefined ? {} : { expectedGroupId: diagnostic.expectedGroupId }),
      ...(diagnostic?.actualGroupId === undefined ? {} : { actualGroupId: diagnostic.actualGroupId }),
      ...(diagnostic?.expectedGroupGeneration === undefined
        ? {}
        : { expectedGroupGeneration: normalizeNullableGeneration(diagnostic.expectedGroupGeneration) }),
      ...(diagnostic?.actualGroupGeneration === undefined
        ? {}
        : { actualGroupGeneration: normalizeNullableGeneration(diagnostic.actualGroupGeneration) }),
      ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
        ? { retryAfterMs: Math.max(0, Math.trunc(retryAfterMs)) }
        : {}),
    });
  }

  private listActiveSameGroupFanoutCandidates(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): ActiveSameAccountFanoutCandidate[] {
    const candidates: ActiveSameAccountFanoutCandidate[] = [];
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = readNonEmptyString(target.sessionId);
      if (!sessionId || sessionId === input.sourceSessionId) continue;
      const selection = readConnectedServiceChildSelectionsFromEnv(target.connectedServiceSelectionsEnv ?? {})
        ?.get(input.serviceId);
      if (!selection || selection.kind !== 'group') continue;
      if (selection.groupId !== input.groupId) continue;
      const activeProfileId = readNonEmptyString(selection.activeProfileId);
      if (!activeProfileId) continue;
      const bindings = extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv);
      const hasActiveBinding = bindings.some((binding) =>
        binding.serviceId === input.serviceId
        && binding.groupId === input.groupId
        && binding.profileId === activeProfileId
      );
      if (!hasActiveBinding) continue;
      candidates.push({
        sessionId,
        serviceId: input.serviceId,
        groupId: input.groupId,
        activeProfileId,
        ...(target.agentId ? { agentId: target.agentId } : {}),
        groupGeneration: normalizeNullableGeneration(selection.generation),
      });
    }
    return candidates.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  private probeDiagnosticReason(result: Exclude<RuntimeAccountIdentityFanoutProbeResult, Readonly<{ status: 'exact' }>>): string {
    const explicit = readNonEmptyString(result.reason);
    if (explicit) return explicit;
    switch (result.status) {
      case 'generation_mismatch':
        return 'same_account_fanout_candidate_stale_generation';
      case 'inexact':
        return 'same_account_fanout_runtime_identity_probe_inexact';
      case 'failed':
        return 'same_account_fanout_runtime_identity_probe_failed';
      case 'missing':
      case 'unavailable':
        return 'same_account_fanout_no_live_identity';
    }
  }

  private async shouldDeferBusySameAccountFanoutCandidate(input: Readonly<{
    candidate: ActiveSameAccountFanoutCandidate;
    result: Extract<RuntimeAccountIdentityFanoutProbeResult, Readonly<{ status: 'exact' }>>;
  }>): Promise<boolean> {
    if (input.result.inProviderTurn !== true) return false;

    const runtimeAuthApply = await this.resolveRuntimeAuthApplyCapabilityForFanoutCandidate(input.candidate);

    const policy = evaluatePredictiveSoftSwitchPolicy({
      reason: 'same_provider_account_exhausted',
      predictiveSoftSwitchMode: 'supported',
      turnState: { inFlight: true },
      runtimeAuthApply,
    });
    return policy.status !== 'allow';
  }

  private async resolveRuntimeAuthApplyCapabilityForFanoutCandidate(
    candidate: ActiveSameAccountFanoutCandidate,
  ): Promise<ConnectedServiceRuntimeAuthApplyCapability> {
    if (!this.runtimeAuthApplyCapabilityResolver) {
      return { directLiveHotAuth: 'unsupported' };
    }
    try {
      return await this.runtimeAuthApplyCapabilityResolver({
        sessionId: candidate.sessionId,
        agentId: candidate.agentId ?? null,
        serviceId: candidate.serviceId,
        groupId: candidate.groupId,
        reason: 'same_provider_account_exhausted',
      });
    } catch {
      return { directLiveHotAuth: 'unsupported' };
    }
  }

  /**
   * Diagnostic trace for a dual-source suppression: BOTH the live runtime-identity probe and the
   * durable persisted-materialization-identity fallback failed to prove same-account membership.
   * Only recorded when a persisted reader is configured (otherwise only the probe was tried).
   */
  private buildDualProofFanoutDecisionTrace(): unknown {
    if (!this.readPersistedSessionAccountIdentity) return undefined;
    return {
      proofSource: 'runtime_identity_probe',
      proofSourcesTried: ['runtime_identity_probe', 'persisted_materialization_identity'] as const,
    };
  }

  /**
   * Durable same-account fanout fallback (`provider_account_id` strategy / codex): when the live
   * runtime-identity probe cannot VERIFY a sibling's account (unavailable/inexact — never a verified
   * mismatch), prove same-account membership from the candidate's PERSISTED materialization identity +
   * persisted credential provider-account id. On a match the retained entry is recorded into the
   * runtime identity index so the (cold, post-restart) index re-warms, and the sibling is routed to
   * the switch. Returns null when no durable proof is available.
   */
  private async attemptColdPersistedFanoutFallback(input: Readonly<{
    candidate: ActiveSameAccountFanoutCandidate;
    strategy: ConnectedServiceSameAccountFanoutStrategy;
    providerAccountId?: string | null;
  }>): Promise<SameAccountFanoutCandidateIdentity | null> {
    if (input.strategy !== 'provider_account_id') return null;
    const providerAccountId = readNonEmptyString(input.providerAccountId);
    if (!providerAccountId) return null;
    const reader = this.readPersistedSessionAccountIdentity;
    if (!reader) return null;
    let identity: Awaited<ReturnType<PersistedSessionAccountIdentityReader>>;
    try {
      identity = await reader({
        sessionId: input.candidate.sessionId,
        serviceId: input.candidate.serviceId,
        groupId: input.candidate.groupId,
        profileId: input.candidate.activeProfileId,
        expectedGroupGeneration: input.candidate.groupGeneration,
      });
    } catch {
      return null;
    }
    if (!identity) return null;
    const matched = persistedSessionAccountIdentityMatchesFailingAccount({
      identity,
      serviceId: input.candidate.serviceId,
      groupId: input.candidate.groupId,
      providerAccountId,
      candidate: {
        serviceId: input.candidate.serviceId,
        groupId: input.candidate.groupId,
        groupGeneration: input.candidate.groupGeneration,
      },
    });
    if (!matched) return null;
    const retained: RuntimeAccountIdentityRecordInput = {
      sessionId: input.candidate.sessionId,
      serviceId: input.candidate.serviceId,
      groupId: input.candidate.groupId,
      profileId: input.candidate.activeProfileId,
      providerAccountId,
      accountLabel: null,
      observedAtMs: this.now(),
      source: 'persisted_materialization_identity',
      proofStrength: 'exact',
      groupGeneration: input.candidate.groupGeneration,
    };
    this.runtimeAccountIdentities.record(retained);
    this.recordSameAccountFanoutDiagnostic(
      'same_account_fanout_retained_via_persisted_materialization_identity',
      'quota_work_deferred',
      undefined,
      {
        sessionId: input.candidate.sessionId,
        expectedProviderAccountId: providerAccountId,
        expectedProfileId: input.candidate.activeProfileId,
        expectedGroupId: input.candidate.groupId,
        expectedGroupGeneration: input.candidate.groupGeneration,
      },
      { proofSource: 'persisted_materialization_identity' },
    );
    return {
      candidate: input.candidate,
      accountLabel: null,
      observedProfileId: input.candidate.activeProfileId,
      deferUntilTurnBoundary: false,
    };
  }

  private async probeSameAccountFanoutCandidate(input: Readonly<{
    candidate: ActiveSameAccountFanoutCandidate;
    strategy: ConnectedServiceSameAccountFanoutStrategy;
    providerAccountId?: string | null;
  }>): Promise<SameAccountFanoutCandidateIdentity | null> {
    const reader = this.readRuntimeAccountIdentityForFanout;
    if (!reader) {
      this.recordSameAccountFanoutDiagnostic('same_account_fanout_no_live_identity');
      return null;
    }
    this.recordSameAccountFanoutDiagnostic('same_account_fanout_identity_index_cold');
    let result: RuntimeAccountIdentityFanoutProbeResult;
    try {
      result = await reader({
        sessionId: input.candidate.sessionId,
        agentId: input.candidate.agentId ?? null,
        serviceId: input.candidate.serviceId,
        groupId: input.candidate.groupId,
        expectedProfileId: input.candidate.activeProfileId,
        expectedGroupGeneration: input.candidate.groupGeneration,
        reason: 'same_provider_account_exhausted',
      });
    } catch {
      // The live probe threw (unavailable) — NOT a verified mismatch, so the durable persisted
      // materialization identity may still prove same-account membership.
      const fallback = await this.attemptColdPersistedFanoutFallback(input);
      if (fallback) return fallback;
      this.recordSameAccountFanoutDiagnostic(
        'same_account_fanout_runtime_identity_probe_failed',
        'quota_work_suppressed',
        undefined,
        undefined,
        this.buildDualProofFanoutDecisionTrace(),
      );
      return null;
    }
    if (result.status !== 'exact') {
      if (result.status === 'unavailable' && result.reason === 'unsupported_session_runtime_method') {
        this.liveIdentityProbeUnsupportedSessionIds.add(input.candidate.sessionId);
      }
      // Unverifiable probe (unavailable/inexact/missing/failed/generation_mismatch) — never a VERIFIED
      // account mismatch (that only comes from an `exact` probe below and is an authoritative veto).
      // Attempt the durable persisted-identity fallback before suppressing.
      const fallback = await this.attemptColdPersistedFanoutFallback(input);
      if (fallback) return fallback;
      this.recordSameAccountFanoutDiagnostic(
        this.probeDiagnosticReason(result),
        'quota_work_suppressed',
        undefined,
        undefined,
        this.buildDualProofFanoutDecisionTrace(),
      );
      return null;
    }

    const match = resolveRuntimeAccountIdentityFanoutMatch({
      strategy: input.strategy,
      providerAccountId: input.providerAccountId,
      candidate: {
        sessionId: input.candidate.sessionId,
        serviceId: input.candidate.serviceId,
        groupId: input.candidate.groupId,
        profileId: input.candidate.activeProfileId,
        groupGeneration: input.candidate.groupGeneration,
      },
      result,
      observedAtMs: this.now(),
    });
    if (match.status === 'suppressed') {
      this.recordSameAccountFanoutDiagnostic(match.reason, 'quota_work_suppressed', undefined, match.diagnostic);
      return null;
    }
    if (input.strategy === 'provider_account_id') {
      this.runtimeAccountIdentities.record(match.entry);
    }
    const deferUntilTurnBoundary = await this.shouldDeferBusySameAccountFanoutCandidate({
      candidate: input.candidate,
      result,
    });
    return {
      candidate: input.candidate,
      accountLabel: match.accountLabel,
      observedProfileId: match.observedProfileId,
      deferUntilTurnBoundary,
    };
  }

  private async resolveSameAccountFanoutCandidates(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    strategy: ConnectedServiceSameAccountFanoutStrategy;
    providerAccountId?: string | null;
  }>): Promise<SameAccountFanoutCandidateIdentity[]> {
    const currentGroupGenerationBySessionId = this.buildCurrentGroupGenerationBySessionId({
      serviceId: input.serviceId,
      groupId: input.groupId,
    });
    const indexedCandidates = input.strategy === 'provider_account_id'
      ? resolveSessionsSharingProviderAccount(this.runtimeAccountIdentities, {
        serviceId: input.serviceId,
        groupId: input.groupId,
        providerAccountId: input.providerAccountId ?? '',
        excludeSessionId: input.sourceSessionId,
        currentGroupGenerationBySessionId,
      }).filter((entry) => this.hasActiveSpawnTargetForIdentity(entry))
      : [];
    const indexedSessionIds = new Set(indexedCandidates.map((entry) => entry.sessionId));
    const activeCandidates = this.listActiveSameGroupFanoutCandidates({
      sourceSessionId: input.sourceSessionId,
      serviceId: input.serviceId,
      groupId: input.groupId,
    }).filter((candidate) => !indexedSessionIds.has(candidate.sessionId));
    if (activeCandidates.length === 0 && indexedCandidates.length === 0) {
      this.recordSameAccountFanoutDiagnostic('same_account_fanout_no_matching_sessions');
      return [];
    }

    const matches: SameAccountFanoutCandidateIdentity[] = [];
    for (const indexed of indexedCandidates) {
      const candidate = this.buildSameAccountFanoutCandidateFromIdentity(indexed, input.groupId);
      if (!candidate) continue;
      if (!this.readRuntimeAccountIdentityForFanout) {
        matches.push(candidate);
        continue;
      }
      const runtimeAuthApply = await this.resolveRuntimeAuthApplyCapabilityForFanoutCandidate(candidate.candidate);
      if (!runtimeAuthApplyRequiresLiveIdentityProbe(runtimeAuthApply)) {
        matches.push(candidate);
        continue;
      }
      if (this.liveIdentityProbeUnsupportedSessionIds.has(candidate.candidate.sessionId)) {
        this.runtimeAccountIdentities.invalidateSession(candidate.candidate.sessionId);
        continue;
      }
      const probed = await this.probeSameAccountFanoutCandidate({
        candidate: candidate.candidate,
        strategy: input.strategy,
        providerAccountId: input.providerAccountId,
      });
      if (probed) matches.push(probed);
    }
    if (!this.readRuntimeAccountIdentityForFanout && matches.length > 0) {
      return matches;
    }
    for (const candidate of activeCandidates) {
      const probed = await this.probeSameAccountFanoutCandidate({
        candidate,
        strategy: input.strategy,
        providerAccountId: input.providerAccountId,
      });
      if (probed) matches.push(probed);
    }
    if (matches.length === 0) {
      this.recordSameAccountFanoutDiagnostic('same_account_fanout_no_matching_sessions');
    }
    return matches;
  }

  private makeSameAccountFanoutKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    providerAccountId: string;
    resetAtMs: number | null;
  }>): string {
    const groupId = input.groupId.trim();
    const resetBucket = typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs)
      ? String(Math.trunc(input.resetAtMs / this.sameAccountFanoutResetBucketMs))
      : 'none';
    return `${input.serviceId}\u0000${groupId}\u0000${input.providerAccountId}\u0000${resetBucket}`;
  }

  private shouldCoalesceSameAccountFanout(input: Readonly<{
    key: string;
    now: number;
  }>): boolean {
    const previousAt = this.sameAccountFanoutAtByKey.get(input.key);
    if (
      typeof previousAt === 'number'
      && Number.isFinite(previousAt)
      && input.now - previousAt < this.sameAccountFanoutMinIntervalMs
    ) {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'same_account_fanout',
        reason: 'same_provider_account_exhaustion_coalesced',
      });
      return true;
    }
    this.sameAccountFanoutAtByKey.set(input.key, input.now);
    return false;
  }

  private checkQuotaWorkGate(phase: QuotaWorkPhase): DaemonServerWorkGateResult {
    const result = this.quotaWorkGate?.() ?? { status: 'open' as const };
    if (result.status === 'open') return result;
    const reason = result.reason.trim() || result.status;
    this.recordDiagnostic?.({
      event: result.status === 'suppressed' ? 'quota_work_suppressed' : 'quota_work_deferred',
      phase,
      reason,
      ...('retryAfterMs' in result && typeof result.retryAfterMs === 'number'
        ? { retryAfterMs: Math.max(0, Math.trunc(result.retryAfterMs)) }
        : {}),
    });
    return result;
  }

  public recordRuntimeAccountIdentityFromSnapshot(
    input: RuntimeAccountIdentityRecordInput,
  ): RuntimeAccountIdentityRecordResult {
    return this.runtimeAccountIdentities.record(input);
  }

  public invalidateRuntimeAccountIdentityForSession(sessionId: string): void {
    this.runtimeAccountIdentities.invalidateSession(sessionId);
  }

  public async recordAccountExhaustionAndFanout(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    exhaustedProfileId: string;
    providerAccountId: string;
    resetAtMs: number | null;
    reason: 'usage_limit';
    committedGeneration?: ConnectedServiceAuthGroupCommittedGenerationFact | null;
    sourceRequiresConvergence?: boolean;
    resolvedFanoutStrategy?: ConnectedServiceSameAccountFanoutStrategy;
  }>): Promise<Readonly<{
    status: 'recorded';
    fanoutCandidates: number;
    fanoutRequests: number;
  }>> {
    const authGroupSwitchCoordinator = this.authGroupSwitchCoordinator;
    if (!authGroupSwitchCoordinator) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const sourceSessionId = typeof input.sourceSessionId === 'string' ? input.sourceSessionId.trim() : '';
    const groupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    const providerAccountId = typeof input.providerAccountId === 'string' ? input.providerAccountId.trim() : '';
    if (!sourceSessionId || !groupId) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const committedGeneration = input.committedGeneration ?? null;
    if (
      committedGeneration?.decisionCommittedTarget.serviceId !== input.serviceId
      || committedGeneration.decisionCommittedTarget.groupId !== groupId
    ) {
      this.recordSameAccountFanoutDiagnostic('hard_limit_committed_generation_missing');
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const strategy = input.resolvedFanoutStrategy ?? await this.resolveSameAccountFanoutStrategy({
      sourceSessionId,
      serviceId: input.serviceId,
      groupId,
    });
    if (strategy === 'none') {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    if (strategy === 'provider_account_id' && !providerAccountId) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }

    const candidates = await this.resolveSameAccountFanoutCandidates({
      sourceSessionId,
      serviceId: input.serviceId,
      groupId,
      strategy,
      providerAccountId,
    });
    if (candidates.length === 0) {
      if (input.sourceRequiresConvergence === true) {
        const fanoutRequests = await this.applyCommittedAuthGroupGeneration({
          committedGeneration,
          reason: 'same_provider_account_exhausted',
          targets: [{
            sessionId: sourceSessionId,
            serviceId: input.serviceId,
            groupId,
            fromProfileId: input.exhaustedProfileId,
          }],
        });
        return { status: 'recorded', fanoutCandidates: 0, fanoutRequests };
      }
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }

    const now = Math.max(0, Math.trunc(this.now()));
    const fanoutKey = this.makeSameAccountFanoutKey({
      serviceId: input.serviceId,
      groupId,
      providerAccountId: strategy === 'provider_account_id'
        ? providerAccountId
        : `shared_group_auth_surface:${groupId}`,
      resetAtMs: input.resetAtMs,
    });
    if (this.shouldCoalesceSameAccountFanout({ key: fanoutKey, now })) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }

    const generationTargets: Array<Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      groupId: string;
      fromProfileId: string;
      deferUntilTurnBoundary?: boolean;
    }>> = [];
    for (const { candidate, observedProfileId, deferUntilTurnBoundary } of candidates) {
      this.runtimeAccountIdentities.invalidateSession(candidate.sessionId);
      if (deferUntilTurnBoundary) {
        this.recordSameAccountFanoutDiagnostic(
          'same_account_fanout_candidate_deferred_until_turn_boundary',
          'quota_work_deferred',
        );
      }
      generationTargets.push({
        sessionId: candidate.sessionId,
        serviceId: candidate.serviceId,
        groupId: candidate.groupId,
        fromProfileId: observedProfileId,
        ...(deferUntilTurnBoundary ? { deferUntilTurnBoundary: true } : {}),
      });
    }
    if (input.sourceRequiresConvergence !== false) {
      generationTargets.push({
        sessionId: sourceSessionId,
        serviceId: input.serviceId,
        groupId,
        fromProfileId: input.exhaustedProfileId,
      });
    }
    const fanoutRequests = await this.applyCommittedAuthGroupGeneration({
      committedGeneration,
      reason: 'same_provider_account_exhausted',
      targets: generationTargets,
    });
    return {
      status: 'recorded',
      fanoutCandidates: candidates.length,
      fanoutRequests,
    };
  }

  private async decideAndApplyAuthGroupGeneration(input: Readonly<{
    reason: 'soft_threshold';
    observedProfileId: string;
    targets: ReadonlyArray<Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      groupId: string;
      fromProfileId: string;
      deferUntilTurnBoundary?: boolean;
    }>>;
  }>): Promise<number> {
    const coordinator = this.authGroupSwitchCoordinator;
    const decisionTarget = input.targets[0];
    if (!coordinator || !decisionTarget) return 0;
    const rawDecision = await coordinator.switchBeforeTurn({
      sessionId: decisionTarget.sessionId,
      serviceId: decisionTarget.serviceId,
      groupId: decisionTarget.groupId,
      reason: input.reason,
      observedProfileId: input.observedProfileId,
      ...(decisionTarget.deferUntilTurnBoundary ? { deferUntilTurnBoundary: true } : {}),
    }).catch(() => null);
    if (!rawDecision || typeof rawDecision !== 'object' || Array.isArray(rawDecision)) return 0;
    const decision = rawDecision as Readonly<Record<string, unknown>>;
    if (isGroupExhaustedNoEligibleMemberSwitchResult(decision)) {
      return 0;
    }
    const activeProfileId = readNonEmptyString(decision.activeProfileId);
    const generation = normalizeNullableGeneration(decision.generation);
    const credentialRevisionParsed = ConnectedServiceCredentialRevisionV1Schema.safeParse(decision.credentialRevision);
    const status = readNonEmptyString(decision.status);
    if (!activeProfileId || generation === null || ![
      'switched',
      'observed_generation',
      'superseded_after_apply',
    ].includes(status)) {
      if (!isHotApplySwitchResult(decision) && !isDeferredFanoutSwitchResult(decision)) {
        this.recordSameAccountFanoutDiagnostic('same_provider_account_exhaustion_restart_required');
      }
      return isHotApplySwitchResult(decision) || isDeferredFanoutSwitchResult(decision) ? 1 : 0;
    }

    const decisionCommittedTarget = {
      serviceId: decisionTarget.serviceId,
      groupId: decisionTarget.groupId,
      profileId: activeProfileId,
      generation,
      credentialRevision: credentialRevisionParsed.success ? credentialRevisionParsed.data : null,
    } as const;
    const committedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: buildConnectedServiceAuthGroupTargetEpochIdentity(decisionCommittedTarget),
      provenance: 'soft_threshold',
      decisionCommittedTarget,
    });
    return await this.applyCommittedAuthGroupGeneration({
      committedGeneration,
      reason: input.reason,
      targets: input.targets,
      ...(hasExactConnectedServiceTargetAdoptionProof({
        serviceId: decisionTarget.serviceId,
        target: decisionCommittedTarget,
        outcome: decision,
      }) ? { skipInitialSessionId: decisionTarget.sessionId } : {}),
    });
  }

  private async applyCommittedAuthGroupGeneration(input: Readonly<{
    committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
    reason: 'soft_threshold' | 'same_provider_account_exhausted';
    targets: ReadonlyArray<Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      groupId: string;
      fromProfileId: string;
      deferUntilTurnBoundary?: boolean;
    }>>;
    skipInitialSessionId?: string;
  }>): Promise<number> {
    const coordinator = this.authGroupSwitchCoordinator;
    if (!coordinator || input.targets.length === 0) return 0;
    const committedTarget = input.committedGeneration.decisionCommittedTarget;
    const recipients = input.targets.filter((recipient) => recipient.sessionId !== input.skipInitialSessionId);
    if (recipients.length === 0) return 0;
    if (this.consumeCommittedAuthGroupGeneration) {
      const consumption = await this.consumeCommittedAuthGroupGeneration({
        committedGeneration: input.committedGeneration,
        switchReason: input.reason === 'soft_threshold' ? 'pre_turn_group_policy' : 'automatic_runtime_failure',
        executionAuthority: 'runtime_recovery',
        sessions: recipients.map((recipient) => ({
          sessionId: recipient.sessionId,
          activity: 'live',
          fromProfileId: recipient.fromProfileId,
        })),
      });
      if (consumption.outcome === 'adopted_current') return recipients.length;
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'same_account_fanout',
        reason: `committed_generation_${consumption.outcome}`,
      });
      return 0;
    }
    if (!coordinator.applyCommittedGeneration) {
      this.recordSameAccountFanoutDiagnostic('committed_generation_apply_unavailable');
      return 0;
    }
    this.recordSameAccountFanoutDiagnostic('durable_generation_consumer_unavailable');
    return 0;
  }

  public async recordRuntimeUsageLimitExhaustionAndFanout(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string | null;
    exhaustedProfileId: string | null;
    resetAtMs: number | null;
    sourceProviderAccountId?: string | null;
    sourceAccountLabel?: string | null;
    sourceGroupGeneration?: number | null;
    committedGeneration?: ConnectedServiceAuthGroupCommittedGenerationFact | null;
    sourceRequiresConvergence?: boolean;
  }>): Promise<Readonly<{
    status: 'recorded';
    fanoutCandidates: number;
    fanoutRequests: number;
  }>> {
    const sourceSessionId = typeof input.sourceSessionId === 'string' ? input.sourceSessionId.trim() : '';
    const groupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    const exhaustedProfileId = typeof input.exhaustedProfileId === 'string' ? input.exhaustedProfileId.trim() : '';
    if (!sourceSessionId || !groupId || !exhaustedProfileId) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }

    const strategy = await this.resolveSameAccountFanoutStrategy({
      sourceSessionId,
      serviceId: input.serviceId,
      groupId,
    });
    if (strategy === 'none') {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    if (strategy === 'shared_group_auth_surface') {
      return await this.recordAccountExhaustionAndFanout({
        sourceSessionId,
        serviceId: input.serviceId,
        groupId,
        exhaustedProfileId,
        providerAccountId: '',
        resetAtMs: input.resetAtMs,
        reason: 'usage_limit',
        committedGeneration: input.committedGeneration,
        sourceRequiresConvergence: input.sourceRequiresConvergence,
        resolvedFanoutStrategy: strategy,
      });
    }

    const sourceProviderAccountId = typeof input.sourceProviderAccountId === 'string'
      ? input.sourceProviderAccountId.trim()
      : '';
    if (!sourceProviderAccountId) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const sourceGroupGeneration = normalizeNullableGeneration(input.sourceGroupGeneration)
      ?? this.resolveGroupGenerationForSession({
        sessionId: sourceSessionId,
        serviceId: input.serviceId,
        groupId,
      });
    this.runtimeAccountIdentities.record({
      sessionId: sourceSessionId,
      serviceId: input.serviceId,
      groupId,
      profileId: exhaustedProfileId,
      providerAccountId: sourceProviderAccountId,
      accountLabel: typeof input.sourceAccountLabel === 'string' && input.sourceAccountLabel.trim()
        ? input.sourceAccountLabel.trim()
        : null,
      observedAtMs: Math.max(0, Math.trunc(this.now())),
      source: 'runtime_auth_failure_report',
      proofStrength: 'exact',
      groupGeneration: sourceGroupGeneration,
    });
    return await this.recordAccountExhaustionAndFanout({
      sourceSessionId,
      serviceId: input.serviceId,
      groupId,
      exhaustedProfileId,
      providerAccountId: sourceProviderAccountId,
      resetAtMs: input.resetAtMs,
      reason: 'usage_limit',
      committedGeneration: input.committedGeneration,
      sourceRequiresConvergence: input.sourceRequiresConvergence,
      resolvedFanoutStrategy: strategy,
    });
  }

  public resolveQuotaProbeFreshProof(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    expectedAppliedIdentity: QuotaProbeAppliedIdentity | null;
    snapshotAppliedIdentity: QuotaProbeAppliedIdentity | null;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    maxAgeMs?: number;
  }>): QuotaProbeFreshProofResult {
    return resolveQuotaProbeFreshProof({
      nowMs: this.now(),
      maxAgeMs: input.maxAgeMs ?? this.quotaLifecycleFreshnessMs,
      serviceId: input.serviceId,
      profileId: input.profileId,
      expectedAppliedIdentity: input.expectedAppliedIdentity,
      snapshotAppliedIdentity: input.snapshotAppliedIdentity,
      snapshot: input.snapshot,
    });
  }

  public computeQuotaSnapshotMaterialFingerprint(snapshot: ConnectedServiceQuotaSnapshotV1): string {
    return this.computeQuotaMaterialFingerprint(snapshot);
  }

  private recordNoEligibleSoftSwitchTarget(
    targetEligibility: Extract<GroupSwitchTargetEligibility, { status: 'no_eligible_target' }>,
  ): void {
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'group_exhausted_no_eligible_target',
      ...(targetEligibility.retryAfterMs === null ? {} : { retryAfterMs: targetEligibility.retryAfterMs }),
      ...(targetEligibility.decisionTrace === undefined ? {} : { decisionTrace: targetEligibility.decisionTrace }),
    });
  }

  private recordNoMeaningfullyBetterSoftSwitchTarget(
    targetEligibility: Extract<GroupSwitchTargetEligibility, { status: 'no_meaningfully_better_target' }>,
  ): void {
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'soft_switch_no_meaningfully_better_target',
      ...(targetEligibility.retryAfterMs === null ? {} : { retryAfterMs: targetEligibility.retryAfterMs }),
      ...(targetEligibility.decisionTrace === undefined ? {} : { decisionTrace: targetEligibility.decisionTrace }),
    });
  }

  private recordUnknownSoftSwitchTargetEligibility(targetEligibility?: Extract<GroupSwitchTargetEligibility, { status: 'unknown' }>): void {
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'soft_switch_target_eligibility_unknown',
      ...(targetEligibility?.decisionTrace === undefined ? {} : { decisionTrace: targetEligibility.decisionTrace }),
    });
  }

  private buildSwitchStateFromAccountUsage(input: Readonly<{
    group: ConnectedServiceAuthGroupV1;
  }>): ConnectedServiceAccountUsageSwitchState | null {
    if (!this.accountUsageStore) return null;
    return buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group: input.group,
      accountUsageStore: this.accountUsageStore,
    })?.state ?? null;
  }

  private async resolveSoftSwitchTargetEligibility(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<GroupSwitchTargetEligibility> {
    if (typeof this.api.getConnectedServiceAuthGroup !== 'function') {
      return { status: 'unknown', reason: 'missing_group_reader' };
    }
    const group = await this.api.getConnectedServiceAuthGroup({
      serviceId: input.serviceId,
      groupId: input.groupId,
    }).catch(() => null);
    if (!group) return { status: 'unknown', reason: 'group_resolution_failed' };

    const now = this.now();
    const switchState = this.accountUsageStore
      ? this.buildSwitchStateFromAccountUsage({ group })
      : null;
    if (!switchState) {
      return { status: 'unknown', reason: 'source_account_usage_unavailable' };
    }
    const activeProfileId = switchState.activeProfileId;
      // Preemptive burn projection: the poll-driven soft-switch cannot see a session burning from
      // healthy to exhausted inside one poll window. Feed the recent consumption velocity (from the
      // in-band runtime snapshots) so a projected-below-threshold active member triggers the
      // soft-switch BEFORE the hard limit. Horizon reuses the existing `probeIfSnapshotOlderThanMs`
      // (the next check window) — no new policy knob.
      const burnHorizonMs = switchState.policy.probeIfSnapshotOlderThanMs;
      const activeQuotaSnapshot = activeProfileId
        ? switchState.memberStatesByProfileId.get(activeProfileId)?.quotaSnapshot ?? null
        : null;
      const recentBurn = activeProfileId
        && typeof burnHorizonMs === 'number'
        && Number.isFinite(burnHorizonMs)
        && burnHorizonMs > 0
        ? this.runtimeQuotaSnapshots?.getRecentBurn({
          serviceId: input.serviceId,
          groupId: input.groupId,
          profileId: activeProfileId,
          groupGeneration: group.generation,
          nowMs: now,
          maxAgeMs: burnHorizonMs,
          currentQuotaSnapshot: activeQuotaSnapshot,
        }) ?? null
        : null;
      const sourceEvidence = resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
        activeProfileId,
        policy: switchState.policy,
        memberStatesByProfileId: switchState.memberStatesByProfileId,
        nowMs: now,
        quotaFreshnessMs: this.quotaPersistenceMinFreshnessMs,
        burnProjection: recentBurn && typeof burnHorizonMs === 'number' && Number.isFinite(burnHorizonMs) && burnHorizonMs > 0
          ? { remainingPercentPerMs: recentBurn.remainingPercentPerMs, horizonMs: burnHorizonMs }
          : null,
      });
      if (sourceEvidence.status === 'unknown') {
        return {
          status: 'unknown',
          reason: 'source_quota_unavailable',
          decisionTrace: {
            activeProfileId,
            reason: 'source_quota_unavailable',
          },
        };
      }
      if (sourceEvidence.status === 'above_threshold') {
        return {
          status: 'no_meaningfully_better_target',
          retryAfterMs: null,
          decisionTrace: {
            activeProfileId,
            reason: 'source_above_threshold',
          },
        };
      }
      return {
        status: 'eligible',
        sourceProfileId: activeProfileId,
        sourceRemainingPercent: sourceEvidence.remainingPercent,
        sourceThresholdPercent: sourceEvidence.thresholdPercent,
        sourceProjected: sourceEvidence.projected === true,
        decisionTrace: {
          activeProfileId,
          reason: 'source_at_or_below_threshold',
        },
      };
  }

  private async shouldRunSoftSwitchForTarget(target: ActiveGroupQuotaSwitchTarget): Promise<boolean> {
    const guard = this.predictiveSwitchGuard;
    if (!guard) return true;
    let result: PredictiveSwitchGuardResult;
    try {
      result = await guard({
        sessionId: target.sessionId,
        serviceId: target.serviceId,
        groupId: target.groupId,
        activeProfileId: target.activeProfileId,
        reason: 'soft_threshold',
      });
    } catch {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'soft_switch',
        reason: 'quota_predictive_switch_policy_failed',
      });
      return false;
    }
    if (result.status === 'allow') return true;
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: result.reason.trim() || 'quota_predictive_switch_suppressed',
    });
    return false;
  }

  private resolveActiveSessionIdsForGroup(serviceId: ConnectedServiceId, groupId: string): string[] {
    const sessionIds: string[] = [];
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
      if (!sessionId || sessionIds.includes(sessionId)) continue;
      for (const entry of extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv)) {
        if (entry.serviceId !== serviceId) continue;
        if ((entry.groupId ?? '') !== groupId) continue;
        sessionIds.push(sessionId);
        break;
      }
    }
    return sessionIds;
  }

  private async evaluateGroupQuotaLifecycle(input: Readonly<{
    group: ConnectedServiceAuthGroupV1;
    changedProfileId?: string;
    now: number;
  }>): Promise<void> {
    const evaluation = this.evaluateGroupQuotaLifecycleFromAccountUsage({
      mode: 'cold_reconstruction',
      group: input.group,
      changedProfileId: input.changedProfileId ?? input.group.activeProfileId ?? '',
      changedGroupGeneration: input.group.generation,
      now: input.now,
    });
    this.recordQuotaLifecycleEvaluationState({
      serviceId: input.group.serviceId,
      groupId: input.group.groupId,
      nextState: evaluation.nextState,
    });
  }

  private async evaluateGroupQuotaLifecycleForGroup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    changedProfileId?: string;
    now: number;
  }>): Promise<void> {
    if (!this.onQuotaLifecycleTransition) return;
    if (typeof this.api.getConnectedServiceAuthGroup !== 'function') return;
    const group = await this.api.getConnectedServiceAuthGroup({
      serviceId: input.serviceId,
      groupId: input.groupId,
    }).catch(() => null);
    if (!group) return;
    await this.evaluateGroupQuotaLifecycle({
      group,
      ...(input.changedProfileId ? { changedProfileId: input.changedProfileId } : {}),
      now: input.now,
    });
  }

  private async evaluateGroupQuotaLifecycleForTargets(input: Readonly<{
    now: number;
    targets: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | undefined;
  }>): Promise<void> {
    if (!input.targets || input.targets.length === 0) return;
    const targetsByGroupKey = new Map<string, ActiveGroupQuotaSwitchTarget>();
    for (const target of input.targets) {
      targetsByGroupKey.set(`${target.serviceId}\u0000${target.groupId}`, target);
    }
    await Promise.all(Array.from(targetsByGroupKey.values()).map((target) =>
      this.evaluateGroupQuotaLifecycleForGroup({
        serviceId: target.serviceId,
        groupId: target.groupId,
        now: input.now,
      }),
    ));
  }

  private makeQuotaLifecycleGroupKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): string {
    return `${input.serviceId}\u0000${input.groupId}`;
  }

  private readQuotaLifecycleState(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): ConnectedServiceAuthGroupQuotaLifecycleState {
    return this.quotaLifecycleStateByGroupKey.get(this.makeQuotaLifecycleGroupKey(input)) ?? { status: 'unblocked' };
  }

  private recordQuotaLifecycleEvaluationState(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    nextState: ConnectedServiceAuthGroupQuotaLifecycleState;
  }>): void {
    const key = this.makeQuotaLifecycleGroupKey(input);
    if (input.nextState.status === 'unblocked') {
      this.quotaLifecycleStateByGroupKey.delete(key);
      return;
    }
    this.quotaLifecycleStateByGroupKey.set(key, input.nextState);
  }

  private buildAccountUsageSnapshotsByGroupProfile(input: Readonly<{
    group: ConnectedServiceAuthGroupV1;
    changedProfileId?: string | null;
    changedSnapshot?: ProviderAccountUsageSnapshotV1 | null;
    changedGroupGeneration?: number | null;
  }>): Map<string, ProviderAccountUsageSnapshotV1> {
    if (!this.accountUsageStore) return new Map();
    return resolveAccountUsageSnapshotsByGroupProfile({
      ...input,
      accountUsageStore: this.accountUsageStore,
    });
  }

  private evaluateGroupQuotaLifecycleFromAccountUsage(input: Readonly<{
    mode: 'live_account_usage_change' | 'cold_reconstruction';
    group: ConnectedServiceAuthGroupV1;
    changedProfileId: string;
    changedGroupGeneration: number;
    changedSnapshot?: ProviderAccountUsageSnapshotV1 | null;
    now: number;
  }>) {
    const snapshotsByProfileId = this.buildAccountUsageSnapshotsByGroupProfile({
      group: input.group,
      changedProfileId: input.changedProfileId,
      changedSnapshot: input.changedSnapshot ?? null,
    });
    return evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: input.mode,
      group: input.group,
      changedProfileId: input.changedProfileId,
      changedGroupGeneration: input.changedGroupGeneration,
      previousState: this.readQuotaLifecycleState({
        serviceId: input.group.serviceId,
        groupId: input.group.groupId,
      }),
      snapshotsByProfileId,
      activeSessionIds: this.resolveActiveSessionIdsForGroup(input.group.serviceId, input.group.groupId),
      nowMs: input.now,
      quotaFreshnessMs: this.quotaLifecycleFreshnessMs,
    });
  }

  private async maybeRequestActiveGroupSwitchForSnapshot(input: Readonly<{
    now: number;
    targets: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | undefined;
  }>): Promise<void> {
    await this.evaluateGroupQuotaLifecycleForTargets(input);

    const authGroupSwitchCoordinator = this.authGroupSwitchCoordinator;
    if (!authGroupSwitchCoordinator || !input.targets || input.targets.length === 0) return;
    if (this.checkQuotaWorkGate('soft_switch').status !== 'open') return;
    const targetsByKey = new Map<string, ActiveGroupQuotaSwitchTarget[]>();
    for (const target of input.targets) {
      const key = this.makeGroupSwitchCheckKey(target);
      const existingTargets = targetsByKey.get(key);
      if (existingTargets) {
        existingTargets.push(target);
      } else {
        targetsByKey.set(key, [target]);
      }
    }
    for (const [key, targets] of targetsByKey.entries()) {
      const nextCheckAt = this.groupSwitchCheckAtByKey.get(key);
      if (typeof nextCheckAt === 'number' && input.now < nextCheckAt) {
        continue;
      }
      this.groupSwitchCheckAtByKey.set(
        key,
        input.now + this.groupSwitchCheckMinIntervalMs + this.computeBoundedJitterMs(this.groupSwitchCheckJitterMs),
      );
      const firstTarget = targets[0];
      if (!firstTarget) continue;
      const targetEligibility = await this.resolveSoftSwitchTargetEligibility({
        serviceId: firstTarget.serviceId,
        groupId: firstTarget.groupId,
      });
      if (targetEligibility.status === 'no_eligible_target') {
        this.recordNoEligibleSoftSwitchTarget(targetEligibility);
        if (targetEligibility.retryAfterMs !== null) {
          this.groupSwitchCheckAtByKey.set(key, input.now + targetEligibility.retryAfterMs);
        }
        continue;
      }
      if (targetEligibility.status === 'no_meaningfully_better_target') {
        this.recordNoMeaningfullyBetterSoftSwitchTarget(targetEligibility);
        if (targetEligibility.retryAfterMs !== null) {
          this.groupSwitchCheckAtByKey.set(key, input.now + targetEligibility.retryAfterMs);
        }
        continue;
      }
      if (targetEligibility.status === 'unknown') {
        this.recordUnknownSoftSwitchTargetEligibility(targetEligibility);
        continue;
      }
      const observedProfileId = targetEligibility.sourceProfileId?.trim() ?? '';
      if (!observedProfileId) {
        this.recordUnknownSoftSwitchTargetEligibility({
          status: 'unknown',
          reason: 'selection_unknown',
        });
        continue;
      }
      const allowedTargets: ActiveGroupQuotaSwitchTarget[] = [];
      for (const target of targets) {
        if (await this.shouldRunSoftSwitchForTarget(target)) {
          allowedTargets.push(target);
        }
      }
      for (const target of allowedTargets) {
        this.recordDiagnostic?.({
          event: 'quota_work_requested',
          phase: 'soft_switch',
          reason: 'soft_switch_requested',
          sessionId: target.sessionId,
          serviceId: target.serviceId,
          groupId: target.groupId,
          activeProfileId: target.activeProfileId,
          eligibilityStatus: targetEligibility.status,
          ...(targetEligibility.sourceProfileId === undefined
            ? {}
            : { sourceProfileId: targetEligibility.sourceProfileId }),
          ...(targetEligibility.sourceRemainingPercent === undefined
            ? {}
            : { sourceRemainingPercent: targetEligibility.sourceRemainingPercent }),
          ...(targetEligibility.sourceThresholdPercent === undefined
            ? {}
            : { sourceThresholdPercent: targetEligibility.sourceThresholdPercent }),
          ...(targetEligibility.sourceProjected === undefined
            ? {}
            : { sourceProjected: targetEligibility.sourceProjected }),
          ...(targetEligibility.selectedProfileId === undefined
            ? {}
            : { selectedProfileId: targetEligibility.selectedProfileId }),
          ...(targetEligibility.selectedRemainingPercent === undefined
            ? {}
            : { selectedRemainingPercent: targetEligibility.selectedRemainingPercent }),
          targetCount: targets.length,
          allowedTargetCount: allowedTargets.length,
        });
      }
      await this.decideAndApplyAuthGroupGeneration({
        reason: 'soft_threshold',
        observedProfileId,
        targets: allowedTargets.map((target) => ({
          sessionId: target.sessionId,
          serviceId: target.serviceId,
          groupId: target.groupId,
          fromProfileId: target.activeProfileId,
        })),
      });
    }
  }

  private async readCurrentQuotaGroupForContext(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceAuthGroupV1 | null> {
    if (typeof this.api.getConnectedServiceAuthGroup !== 'function') return null;
    const group = await this.api.getConnectedServiceAuthGroup({
      serviceId: input.serviceId,
      groupId: input.groupId,
    }).catch(() => null);
    if (!group) return null;
    if (group.serviceId !== input.serviceId || group.groupId !== input.groupId) return null;
    return group;
  }

  private buildQuotaGroupContextsForProfile(input: Readonly<{
    group: ConnectedServiceAuthGroupV1 | null;
    profileId: string;
  }>): ReadonlyArray<ConnectedServiceQuotaGroupContext> | undefined {
    if (!input.group) return undefined;
    const profileId = input.profileId.trim();
    if (!profileId) return undefined;
    const isCurrentMember = input.group.members.some((member) => member.profileId.trim() === profileId);
    return isCurrentMember
      ? [{ groupId: input.group.groupId, groupGeneration: input.group.generation }]
      : undefined;
  }

  private computeJitteredBackoffMs(baseMs: number): number {
    const jitterPct = this.failureBackoffJitterPct;
    if (jitterPct <= 0) return Math.max(1, Math.trunc(baseMs));
    const bytes = this.randomBytes(4);
    const u32 =
      ((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0);
    const normalized = (u32 >>> 0) / 0xffffffff;
    const factor = (1 - jitterPct) + normalized * (2 * jitterPct);
    return Math.max(1, Math.trunc(baseMs * factor));
  }

  private applyFailureBackoff(params: Readonly<{ now: number; key: string; error?: unknown }>): void {
    const existing = this.failureStateByBindingKey.get(params.key);
    const consecutiveFailures = Math.min((existing?.consecutiveFailures ?? 0) + 1, 30);
    const providerRetryMs = resolveQuotaFetchFailureBackoffMs({
      error: params.error,
      now: params.now,
    });
    const expMs = this.failureBackoffMinMs * Math.pow(2, consecutiveFailures - 1);
    const cappedMs = providerRetryMs ?? Math.min(expMs, this.failureBackoffMaxMs);
    const jitteredMs = providerRetryMs ?? this.computeJitteredBackoffMs(cappedMs);
    this.failureStateByBindingKey.set(params.key, {
      consecutiveFailures,
      nextAllowedAt: params.now + jitteredMs,
    });
  }

  private async persistCredentialHealthForQuotaFailure(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    error: unknown;
    now: number;
    expectedCredentialRevision: ResolvedQuotaFetchCredential[
      'credentialRevision'
    ];
  }>): Promise<ConnectedServiceCredentialHealthV1['status'] | null> {
    if (!isQuotaAuthFailure(input.error)) return null;
    if (!this.shouldRunLegacyQuotaFetcher(
      input.serviceId,
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
      'credential_health',
    )) {
      return null;
    }
    const updateHealth = this.api.updateConnectedServiceCredentialHealth;
    if (typeof updateHealth !== 'function') return null;
    const bindingKey = this.makeBindingKey({ serviceId: input.serviceId, profileId: input.profileId });
    const health = buildQuotaAuthFailureCredentialHealth(input.error, input.now, {
      consecutiveFailuresBeforeCurrent: this.failureStateByBindingKey.get(bindingKey)?.consecutiveFailures ?? 0,
      providerTerminalAuthFailureCodes:
        this.quotaFetchersByServiceId.get(input.serviceId)?.terminalAuthFailureProviderCodes,
    });
    await updateHealth.call(this.api, {
      serviceId: input.serviceId,
      profileId: input.profileId,
      health,
      expectedCredentialRevision: input.expectedCredentialRevision,
    });
    return health.status;
  }

  public async recordInBandQuotaSnapshot(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>): Promise<
    | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
    | Readonly<{ status: 'suppressed'; reason: string }>
  > {
    if (input.snapshot.serviceId !== input.serviceId) {
      return { status: 'suppressed', reason: 'service_id_mismatch' };
    }

    this.recordRuntimeProfileSnapshot(input);
    const status = deriveQuotaSnapshotStatus(input.snapshot);
    const key = this.buildQuotaPersistenceKey(input);
    const materialFingerprint = this.computeQuotaMaterialFingerprint(input.snapshot);
    const materialState: QuotaPersistenceMaterialState = {
      fingerprint: materialFingerprint,
      fetchedAt: input.snapshot.fetchedAt,
      staleAfterMs: input.snapshot.staleAfterMs,
      status,
    };
    const decision = shouldPersistQuotaSnapshot({
      previous: this.quotaPersistenceStateByKey.get(key) ?? null,
      next: materialState,
      nowMs: Math.max(0, Math.trunc(this.now())),
      minFreshnessMs: this.quotaPersistenceMinFreshnessMs,
    });
    if (!decision.persist) return { status: 'suppressed', reason: decision.reason };

    const enqueue = this.inBandQuotaPersistenceScheduler.enqueue(key, {
      key,
      serviceId: input.serviceId,
      profileId: input.profileId,
      snapshot: input.snapshot,
      status,
      materialFingerprint,
      materialState,
    });
    if (enqueue.type === 'suppressed') return { status: 'suppressed', reason: enqueue.reason };
    return { status: 'enqueued', enqueue: enqueue.type };
  }

  public async flushInBandQuotaPersistence(timeoutMs: number): Promise<void> {
    await this.inBandQuotaPersistenceScheduler.flushAll(timeoutMs);
  }

  public async handleAccountUsageChanged(input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    profileId: string;
    groupId: string;
    groupGeneration: number;
    recordId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
    source?: 'poll' | 'in_band' | 'evidence_only';
  }>): Promise<void> {
    void input.recordId;
    const listener = this.onQuotaLifecycleTransition;
    if (!this.accountUsageStore || typeof this.api.getConnectedServiceAuthGroup !== 'function') return;
    const groupId = input.groupId.trim();
    if (!groupId) return;
    const group = await this.api.getConnectedServiceAuthGroup({
      serviceId: input.serviceId,
      groupId,
    }).catch(() => null);
    if (!group) return;

    // Lifecycle emission FIRST (mirrors the poll ordering: record → lifecycle edge → soft-switch). The
    // reactive soft-switch below runs the shared `maybeRequestActiveGroupSwitchForSnapshot`, whose own
    // `evaluateGroupQuotaLifecycleForTargets` would otherwise consume the lifecycle edge before this
    // account-usage evaluation could emit it.
    if (listener) {
      const evaluation = this.evaluateGroupQuotaLifecycleFromAccountUsage({
        mode: 'live_account_usage_change',
        group,
        changedProfileId: input.profileId,
        changedGroupGeneration: input.groupGeneration,
        changedSnapshot: input.snapshot,
        now: this.now(),
      });
      this.recordQuotaLifecycleEvaluationState({
        serviceId: input.serviceId,
        groupId,
        nextState: evaluation.nextState,
      });
      if (evaluation.edge.phase !== 'no_edge') {
        try {
          await listener(evaluation.edge);
        } catch {
          // Lifecycle notifications are best-effort; account usage remains canonical.
        }
      }
    }

    // Reactive preemption: a genuine in-band usage change (delivered outside the poll) is the freshest
    // per-session consumption signal. Re-evaluate the burn-projected soft-switch NOW (through the
    // existing, fully flap-guarded `maybeRequestActiveGroupSwitchForSnapshot`) instead of waiting for
    // the next quota poll — the whole point of catching a fast burn before the hard limit. The poll
    // performs its OWN soft-switch check right after recording (`source: 'poll'`), while
    // `evidence_only` is a follow-up read for an already-surfaced hard failure whose recovery owner
    // is already active. Admit only the explicit in-band source so omitted or future source kinds
    // cannot acquire predictive switching authority. Best-effort; the poll remains the backstop.
    const changedProfileId = input.profileId.trim();
    const changedSessionId = input.sessionId.trim();
    if (input.source === 'evidence_only') {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'soft_switch',
        reason: 'post_hard_limit_snapshot_evidence_only',
        sessionId: changedSessionId,
        serviceId: input.serviceId,
        groupId,
        activeProfileId: changedProfileId,
      });
    }
    if (
      input.source === 'in_band'
      && changedProfileId
      && changedSessionId
    ) {
      await this.maybeRequestActiveGroupSwitchForSnapshot({
        now: this.now(),
        targets: [{
          sessionId: changedSessionId,
          serviceId: input.serviceId,
          groupId,
          activeProfileId: changedProfileId,
          groupGeneration: input.groupGeneration,
        }],
      }).catch(() => undefined);
    }
  }

  public disposeInBandQuotaPersistence(): void {
    this.inBandQuotaPersistenceScheduler.dispose();
    this.runtimeAccountIdentities.clear();
    this.sameAccountFanoutAtByKey.clear();
  }

  private async flushInBandQuotaPersistencePayload(payload: InBandQuotaPersistencePayload): Promise<void> {
    const accountMode = await resolveConnectedServiceAccountMode(this.api, { refresh: true });
    if (accountMode === 'unknown') {
      invalidateConnectedServiceAccountMode(this.api);
      throw new InBandQuotaPersistenceRetryError({
        reason: 'account_mode_unknown',
        retryable: false,
        retryAfterMs: 1_000,
      });
    }
    await this.persistQuotaSnapshotWithServerWork({
      accountMode,
      serviceId: payload.serviceId,
      profileId: payload.profileId,
      snapshot: payload.snapshot,
      materialFingerprint: payload.materialFingerprint,
    });
    this.quotaPersistenceStateByKey.set(payload.key, payload.materialState);
  }

  private async persistQuotaSnapshotWithServerWork(input: Readonly<{
    accountMode: 'e2ee' | 'plain';
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    materialFingerprint?: string;
    sourceProviderAccountId?: string | null;
  }>): Promise<void> {
    if (!this.shouldRunLegacyQuotaFetcher(
      input.serviceId,
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
      'provider_account_usage_write',
    )) {
      throw new Error(
        'Connected-service provider account usage persistence is unsupported by the current peer',
      );
    }
    const key = this.buildQuotaPersistenceKey(input);
    const outcome = await this.serverWorkScheduler.enqueue({
      key,
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      payload: input,
      payloadBytes: Buffer.byteLength(JSON.stringify(input.snapshot), 'utf8'),
      run: async (work) => {
        await this.persistQuotaSnapshot(work);
        return { status: 'written' };
      },
    });
    if (outcome.status === 'written') {
      return;
    }
    if (outcome.status === 'suppressed') return;
    if (outcome.status === 'deferred') {
      throw new InBandQuotaPersistenceRetryError({
        reason: outcome.reason,
        retryable: true,
        retryAfterMs: outcome.retryAfterMs,
      });
    }
    throw new InBandQuotaPersistenceRetryError({
      reason: outcome.classification.kind,
      retryable: outcome.classification.retryable,
      retryAfterMs: outcome.classification.retryAfterMs,
    });
  }

  private async persistQuotaSnapshot(input: Readonly<{
    accountMode: 'e2ee' | 'plain';
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    materialFingerprint?: string;
    sourceProviderAccountId?: string | null;
  }>): Promise<void> {
    const providerAccountUsageSnapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: input.snapshot,
      observedAtMs: input.snapshot.fetchedAtMs ?? input.snapshot.fetchedAt,
      sourceProviderAccountId: input.sourceProviderAccountId,
    });
    const status = deriveQuotaSnapshotStatus(input.snapshot);
    const materialFingerprint = input.materialFingerprint
      ?? computeProviderAccountUsageSnapshotFingerprint(providerAccountUsageSnapshot, this.quotaSnapshotFingerprintKey);
    const sourceProviderAccountId = typeof input.sourceProviderAccountId === 'string'
      ? input.sourceProviderAccountId.trim()
      : '';
    const canPersistSourceLink = canPersistUsageSourceLinkWithProviderIdentity({
      sourceProviderAccountId,
      recordKey: providerAccountUsageSnapshot.recordKey,
    });
    if (input.accountMode === 'plain') {
      if (typeof this.api.registerProviderAccountUsageSnapshotPlain !== 'function') {
        throw new Error('Provider account usage plaintext persistence route unavailable');
      }
      if (!this.shouldRunLegacyQuotaFetcher(
        input.serviceId,
        this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
        'provider_account_usage_write',
      )) {
        throw new Error(
          'Connected-service provider account usage persistence is unsupported by the current peer',
        );
      }
      await this.api.registerProviderAccountUsageSnapshotPlain({
        recordId: providerAccountUsageSnapshot.recordId,
        ...(canPersistSourceLink ? {
          source: {
            serviceId: input.serviceId,
            profileId: input.profileId,
            bindingKind: 'profile' as const,
          },
        } : {}),
        content: { t: 'plain', v: providerAccountUsageSnapshot },
        metadata: {
          fetchedAt: providerAccountUsageSnapshot.fetchedAtMs,
          staleAfterMs: providerAccountUsageSnapshot.staleAfterMs,
          status,
          materialFingerprint,
        },
      });
      return;
    }

    const encryption = this.credentials.encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });
    const compatibility =
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
        input.serviceId
      ];
    const sealed = sealProviderAccountUsageSnapshotCiphertext({
      material,
      payload:
        compatibility?.exactV0_2_1ReaderQuotaProjection === true
          ? projectBuiltInLegacyProviderAccountUsageSnapshotV1(
              providerAccountUsageSnapshot,
            )
          : providerAccountUsageSnapshot,
      randomBytes: this.randomBytes,
    });
    if (typeof this.api.registerProviderAccountUsageSnapshotSealed !== 'function') {
      throw new Error('Provider account usage sealed persistence route unavailable');
    }
    if (!this.shouldRunLegacyQuotaFetcher(
      input.serviceId,
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
      'provider_account_usage_write',
    )) {
      throw new Error(
        'Connected-service provider account usage persistence is unsupported by the current peer',
      );
    }
    await this.api.registerProviderAccountUsageSnapshotSealed({
      recordId: providerAccountUsageSnapshot.recordId,
      recordKey: providerAccountUsageSnapshot.recordKey,
      ...(canPersistSourceLink ? {
        source: {
          serviceId: input.serviceId,
          profileId: input.profileId,
          bindingKind: 'profile' as const,
        },
      } : {}),
      sealed: { format: 'account_scoped_v1', ciphertext: sealed },
      metadata: {
        fetchedAt: providerAccountUsageSnapshot.fetchedAtMs,
        staleAfterMs: providerAccountUsageSnapshot.staleAfterMs,
        status,
        materialFingerprint,
      },
    });
  }

  private async readExistingQuotaSnapshot(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<ExistingQuotaSnapshotResponse> {
    if (!this.shouldRunLegacyQuotaFetcher(
      input.serviceId,
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
      'quota_read',
    )) {
      return null;
    }
    if (input.accountMode !== 'e2ee' && typeof this.api.getConnectedServiceQuotaSnapshotPlain === 'function') {
      const plain = await this.api.getConnectedServiceQuotaSnapshotPlain({
        serviceId: input.serviceId,
        profileId: input.profileId,
      });
      if (plain || input.accountMode === 'plain') {
        return plain;
      }
    }
    return await this.api.getConnectedServiceQuotaSnapshotSealed({ serviceId: input.serviceId, profileId: input.profileId });
  }

  private shouldForceQuotaRefresh(existing: ExistingQuotaSnapshotResponse): boolean {
    const fetchedAt = Number(existing?.metadata?.fetchedAt ?? 0);
    const refreshRequestedAt = Number(existing?.metadata?.refreshRequestedAt ?? 0);
    return Number.isFinite(refreshRequestedAt) && refreshRequestedAt > 0 && refreshRequestedAt > fetchedAt;
  }

  private isExistingQuotaSnapshotFresh(input: Readonly<{
    existing: ExistingQuotaSnapshotResponse;
    now: number;
    forcedRefresh: boolean;
  }>): boolean {
    if (!input.existing?.metadata) return false;
    const fetchedAt = Number(input.existing.metadata.fetchedAt ?? 0);
    const staleAfterMs = Number(input.existing.metadata.staleAfterMs ?? 0);
    if (!Number.isFinite(fetchedAt) || !Number.isFinite(staleAfterMs) || fetchedAt <= 0 || staleAfterMs <= 0) return false;
    return !input.forcedRefresh && input.now < fetchedAt + staleAfterMs;
  }

  private async acquireQuotaFetchLease(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    expectedCredentialRevision: ResolvedQuotaFetchCredential[
      'credentialRevision'
    ];
  }>): Promise<Readonly<
    | { type: 'acquired' }
    | { type: 'contended'; leaseUntil: number }
    | { type: 'unavailable' }
  >> {
    if (!this.shouldRunLegacyQuotaFetcher(
      input.serviceId,
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
      'refresh_lease',
    )) {
      return { type: 'unavailable' };
    }
    if (typeof this.api.acquireConnectedServiceRefreshLease !== 'function' || !this.machineIdProvider) {
      return { type: 'acquired' };
    }
    const machineId = String(this.machineIdProvider() ?? '').trim();
    if (!machineId) return { type: 'acquired' };
    const ownerIdRaw = this.ownerIdProvider ? String(this.ownerIdProvider() ?? '').trim() : '';
    const lease = await this.api.acquireConnectedServiceRefreshLease({
      serviceId: input.serviceId,
      profileId: input.profileId,
      machineId,
      ...(ownerIdRaw ? { ownerId: ownerIdRaw } : {}),
      leaseMs: this.quotaFetchLeaseMs,
      expectedCredentialRevision: input.expectedCredentialRevision,
    });
    if (lease.acquired) return { type: 'acquired' };
    return { type: 'contended', leaseUntil: Number(lease.leaseUntil ?? 0) };
  }

  public async probeGroupQuotaSnapshots(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileIds: ReadonlyArray<string>;
  }>): Promise<void> {
    const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
    const groupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    if (!groupId) return;
    const qualifiedPeerClass =
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null;
    if (qualifiedPeerClass === 'advertised_v4') {
      const accountMode = await resolveConnectedServiceAccountMode(this.api);
      if (accountMode === 'unknown') return;
      await this.pollQualifiedConnectedAccountQuotas({
        accountMode,
        now: Math.max(0, Math.trunc(this.now())),
        v4Support: 'advertised',
      });
      return;
    }
    if (!this.shouldRunLegacyQuotaFetcher(serviceId, qualifiedPeerClass)) {
      return;
    }
    const fetcher = this.quotaFetchersByServiceId.get(serviceId);
    if (!fetcher) return;
    const profileIds = Array.from(new Set(input.profileIds
      .map((profileId) => String(profileId ?? '').trim())
      .filter((profileId) => profileId.length > 0)));
    if (profileIds.length === 0) return;

    const now = Math.max(0, Math.trunc(this.now()));
    const accountMode = await resolveConnectedServiceAccountMode(this.api);
    if (accountMode === 'unknown') return;
    const material = this.resolveCredentialOpenMaterial();

    for (const profileId of profileIds) {
      let expectedCredentialRevision:
        ResolvedQuotaFetchCredential['credentialRevision'] | null = null;
      try {
        const bindingKey = this.makeBindingKey({ serviceId, profileId });
        const failureState = this.failureStateByBindingKey.get(bindingKey);
        if (failureState && now < failureState.nextAllowedAt) continue;

        const credential = await this.readCredentialRecordForQuotaFetch({
          accountMode,
          material,
          serviceId,
          profileId,
        });
        if (!credential) continue;
        expectedCredentialRevision = credential.credentialRevision;
        const group = await this.readCurrentQuotaGroupForContext({
          serviceId,
          groupId,
        });

        const lease = await this.acquireQuotaFetchLease({
          serviceId,
          profileId,
          expectedCredentialRevision: credential.credentialRevision,
        });
        if (lease.type === 'unavailable') continue;
        if (lease.type === 'contended') {
          const observed = await this.readFreshExistingQuotaSnapshot({
            accountMode,
            serviceId,
            profileId,
            now,
            leaseUntil: lease.leaseUntil,
            material,
          });
          if (observed) {
            this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: observed });
            await this.recordFetchedQuotaSnapshotAsAccountUsage({
              serviceId,
              profileId,
              groupId,
              groupContexts: this.buildQuotaGroupContextsForProfile({ group, profileId }),
              snapshot: observed,
              now,
            });
            this.failureStateByBindingKey.delete(bindingKey);
          }
          continue;
        }

        const fetched = await this.fetchQuotaSnapshotForProfile({
          accountMode,
          material,
          fetcher,
          serviceId,
          profileId,
          credential,
        });
        if (!fetched) continue;
        this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: fetched.snapshot });
        const recordedAccountUsage = await this.recordFetchedQuotaSnapshotAsAccountUsage({
          serviceId,
          profileId,
          groupId,
          groupContexts: this.buildQuotaGroupContextsForProfile({ group, profileId }),
          snapshot: fetched.snapshot,
          now,
          authenticatedProbe: true,
          sourceProviderAccountId: fetched.sourceProviderAccountId,
        });
        if (!recordedAccountUsage) {
          await this.persistQuotaSnapshotWithServerWork({
            accountMode: fetched.credentialStorageMode,
            serviceId,
            profileId,
            snapshot: fetched.snapshot,
            sourceProviderAccountId: fetched.sourceProviderAccountId,
            materialFingerprint: this.computeQuotaMaterialFingerprint(fetched.snapshot),
          });
        }
        this.failureStateByBindingKey.delete(bindingKey);
      } catch (error) {
        const bindingKey = this.makeBindingKey({ serviceId, profileId });
        if (expectedCredentialRevision) {
          await this.persistCredentialHealthForQuotaFailure({
            serviceId,
            profileId,
            error,
            now,
            expectedCredentialRevision,
          }).catch(() => false);
        }
        this.applyFailureBackoff({ now, key: bindingKey, error });
      }
    }

    await this.evaluateGroupQuotaLifecycleForGroup({
      serviceId,
      groupId,
      now,
    });
  }

  private shouldRunLegacyQuotaFetcher(
    serviceId: ConnectedServiceId,
    peerClass: QualifiedConnectedAccountPeerClass | null,
    operation: BuiltInLegacyConnectedAccountOperation = 'quota_poll',
  ): boolean {
    const compatibility =
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
        serviceId
      ];
    const resolveOperationTransport =
      this.qualifiedConnectedAccountRuntime?.resolveOperationTransport;
    if (resolveOperationTransport) {
      try {
        const transport = resolveOperationTransport({
          service: compatibility.service,
          operation,
        });
        return transport.kind === 'legacy'
          && transport.serviceId === serviceId;
      } catch {
        return false;
      }
    }
    if (peerClass !== null && peerClass !== 'revisioned_v2_v3') {
      return false;
    }
    return isBuiltInLegacyConnectedAccountPeerOperationSupported({
      serviceId,
      peerClass: 'revisioned_v2_v3',
      operation,
    });
  }

  private shouldRunQualifiedQuotaOperation(
    profile: QualifiedConnectedAccountProfileV4,
    operation: BuiltInLegacyConnectedAccountOperation,
  ): boolean {
    const runtime = this.qualifiedConnectedAccountRuntime;
    if (!runtime) return false;
    if (!runtime.resolveOperationTransport) {
      return runtime.resolvePeerClass() === 'advertised_v4';
    }
    try {
      return runtime.resolveOperationTransport({
        service: profile.ref.service,
        operation,
      }).kind === 'v4';
    } catch {
      return false;
    }
  }

  private async persistQualifiedConnectedAccountQuota(input: Readonly<{
    accountMode: 'e2ee' | 'plain';
    profile: QualifiedConnectedAccountProfileV4;
    snapshot: ProviderAccountUsageSnapshotV1;
    basis: Awaited<
      ReturnType<
        QualifiedConnectedAccountEstablishedRuntimeOwner['invokeWithReceipt']
      >
    >['basis'];
  }>): Promise<boolean> {
    const runtime = this.qualifiedConnectedAccountRuntime;
    if (
      !runtime
      || !input.basis.isCurrent()
      || !this.shouldRunQualifiedQuotaOperation(
        input.profile,
        'provider_account_usage_write',
      )
    ) {
      return false;
    }
    const expectedConfigurationRevision =
      input.basis.credentialConfigurationRevision;
    const materialFingerprint =
      computeProviderAccountUsageSnapshotFingerprint(
        input.snapshot,
        this.quotaSnapshotFingerprintKey,
      );
    const write = {
      source: {
        ref: input.profile.ref,
        bindingKind: 'account' as const,
      },
      expectedCredentialRevision: input.basis.credentialRevision,
      expectedConfigurationRevision,
      recordId: input.snapshot.recordId,
      recordKey: input.snapshot.recordKey,
      payloadMode: input.accountMode === 'plain'
        ? 'plain_json_v1' as const
        : 'sealed_account_scoped_v1' as const,
      status: input.snapshot.meters.length > 0
        && input.snapshot.meters.every(
          (meter) => meter.status === 'unavailable',
        )
        ? 'unavailable' as const
        : 'ok' as const,
      ...(input.accountMode === 'plain'
        ? { snapshot: input.snapshot }
        : {
            sealedPayload: {
              format: 'account_scoped_v1' as const,
              ciphertext: sealProviderAccountUsageSnapshotCiphertext({
                material: this.credentials.encryption.type === 'legacy'
                  ? {
                      type: 'legacy' as const,
                      secret: this.credentials.encryption.secret,
                    }
                  : {
                      type: 'dataKey' as const,
                      machineKey:
                        this.credentials.encryption.machineKey,
                    },
                payload: input.snapshot,
                randomBytes: this.randomBytes,
              }),
            },
          }),
      fetchedAt: input.snapshot.fetchedAtMs,
      staleAfterMs: input.snapshot.staleAfterMs,
      metadata: { materialFingerprint },
    };
    const writeProviderAccountUsage =
      runtime.writeProviderAccountUsage
      ?? writeQualifiedProviderAccountUsageV4;
    const outcome = await this.serverWorkScheduler.enqueue({
      key:
        `qualified-connected-account-quota:${qualifiedAccountQuotaKey(
          input.profile.ref,
        )}`,
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      payload: write,
      payloadBytes: Buffer.byteLength(JSON.stringify(write), 'utf8'),
      run: async (payload) => {
        if (!input.basis.isCurrent()) {
          throw new Error(
            'Qualified Connected Account quota basis is no longer current',
          );
        }
        await writeProviderAccountUsage({
          token: this.credentials.token,
          write: payload,
        });
        if (!input.basis.isCurrent()) {
          throw new Error(
            'Qualified Connected Account quota generation changed during persistence',
          );
        }
        return { status: 'written' as const };
      },
    });
    return outcome.status === 'written';
  }

  private async pollQualifiedConnectedAccountQuotas(input: Readonly<{
    accountMode: 'e2ee' | 'plain';
    now: number;
    v4Support: QualifiedConnectedAccountV4Support;
  }>): Promise<void> {
    const runtime = this.qualifiedConnectedAccountRuntime;
    if (!runtime || input.v4Support !== 'advertised') return;
    let profiles: readonly QualifiedConnectedAccountProfileV4[];
    try {
      profiles = await runtime.listScheduledAccounts();
    } catch {
      return;
    }
    const readQuota = runtime.readQuota
      ?? readQualifiedConnectedAccountQuotaV4;
    for (const profile of profiles) {
      if (!isConnectedServiceCredentialHealthStatusUsable(profile.status)) {
        continue;
      }
      const key =
        `qualified:${qualifiedAccountQuotaKey(profile.ref)}`;
      const failureState = this.failureStateByBindingKey.get(key);
      if (failureState && input.now < failureState.nextAllowedAt) continue;
      try {
        if (!this.shouldRunQualifiedQuotaOperation(
          profile,
          'quota_read',
        )) {
          continue;
        }
        const existing = await readQuota({
          token: this.credentials.token,
          ref: profile.ref,
        });
        const existingSnapshot = existing
          ? openQualifiedConnectedAccountQuotaResponseV4({
              response: existing,
              expectedRef: profile.ref,
              material: this.credentials.encryption.type === 'legacy'
                ? {
                    type: 'legacy',
                    secret: this.credentials.encryption.secret,
                  }
                : {
                    type: 'dataKey',
                    machineKey:
                      this.credentials.encryption.machineKey,
                  },
            })
          : null;
        if (
          existing
          && existingSnapshot
          && existing.metadata.fetchedAt
            + existing.metadata.staleAfterMs > input.now
          && (
            existing.metadata.refreshRequestedAt === undefined
            || existing.metadata.refreshRequestedAt
              <= existing.metadata.fetchedAt
          )
        ) {
          this.failureStateByBindingKey.delete(key);
          continue;
        }
        if (!this.shouldRunQualifiedQuotaOperation(
          profile,
          'quota_poll',
        )) {
          continue;
        }
        const invocation =
          await runtime.establishedRuntimeOwner.invokeWithReceipt({
            account: profile.ref,
            operation: Object.freeze({ kind: 'quota' as const }),
          });
        if (!invocation.result || !invocation.basis.isCurrent()) continue;
        const snapshot =
          buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota({
            profile,
            quota: invocation.result,
            staleAfterMs: this.quotaPersistenceMinFreshnessMs,
          });
        const written = await this.persistQualifiedConnectedAccountQuota({
          accountMode: input.accountMode,
          profile,
          snapshot,
          basis: invocation.basis,
        });
        if (!written) continue;
        this.accountUsageStore?.recordSnapshot(snapshot);
        this.failureStateByBindingKey.delete(key);
      } catch (error) {
        this.applyFailureBackoff({
          now: input.now,
          key,
          error,
        });
      }
    }
  }

  public async tickOnce(): Promise<void> {
    const now = Math.max(0, Math.trunc(this.now()));
    const accountMode = await resolveConnectedServiceAccountMode(this.api);
    if (accountMode === 'unknown') return;
    const material = this.resolveCredentialOpenMaterial();
    const qualifiedPeerClass =
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null;

    const bindingsByServiceId = new Map<ConnectedServiceId, Set<string>>();
    const groupSwitchTargetsByBindingKey = new Map<string, ActiveGroupQuotaSwitchTarget[]>();
    const activeGroupTargetsByServiceId = new Map<ConnectedServiceId, ActiveGroupQuotaSwitchTarget[]>();
    const authGroupByKey = new Map<string, Promise<ConnectedServiceAuthGroupV1 | null>>();
    const readAuthGroupForTarget = (target: ActiveGroupQuotaSwitchTarget): Promise<ConnectedServiceAuthGroupV1 | null> => {
      const key = `${target.serviceId}\u0000${target.groupId}`;
      const existing = authGroupByKey.get(key);
      if (existing) return existing;
      const promise = typeof this.api.getConnectedServiceAuthGroup === 'function'
        ? this.api.getConnectedServiceAuthGroup({
          serviceId: target.serviceId,
          groupId: target.groupId,
        }).catch(() => null)
        : Promise.resolve(null);
      authGroupByKey.set(key, promise);
      return promise;
    };
    const resolveGroupContextsForFetchedProfile = async (input: Readonly<{
      serviceId: ConnectedServiceId;
      profileId: string;
      directTargets?: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | null;
    }>): Promise<ConnectedServiceQuotaGroupContext[]> => {
      const out: ConnectedServiceQuotaGroupContext[] = [];
      const seen = new Set<string>();
      const addContext = (context: ConnectedServiceQuotaGroupContext): void => {
        const groupId = context.groupId.trim();
        if (!groupId) return;
        const key = `${groupId}\u0000${context.groupGeneration ?? ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ groupId, groupGeneration: context.groupGeneration });
      };
      for (const target of input.directTargets ?? []) {
        addContext({ groupId: target.groupId, groupGeneration: target.groupGeneration });
      }
      for (const target of activeGroupTargetsByServiceId.get(input.serviceId) ?? []) {
        if (target.groupGeneration === null) continue;
        const group = await readAuthGroupForTarget(target);
        if (!group || group.generation !== target.groupGeneration) continue;
        const isMember = group.members.some((member) => member.profileId.trim() === input.profileId);
        if (!isMember) continue;
        addContext({ groupId: target.groupId, groupGeneration: target.groupGeneration });
      }
      return out;
    };

    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      for (const entry of extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv)) {
        const profileId = String(entry.profileId ?? '').trim();
        if (!profileId) continue;
        const existing = bindingsByServiceId.get(entry.serviceId);
        if (existing) {
          existing.add(profileId);
        } else {
          bindingsByServiceId.set(entry.serviceId, new Set([profileId]));
        }
        const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
        const groupId = typeof entry.groupId === 'string' ? entry.groupId.trim() : '';
        if (sessionId && groupId) {
          const bindingKey = this.makeBindingKey({ serviceId: entry.serviceId, profileId });
          const targets = groupSwitchTargetsByBindingKey.get(bindingKey) ?? [];
          if (!targets.some((candidate) =>
            candidate.sessionId === sessionId
            && candidate.serviceId === entry.serviceId
            && candidate.groupId === groupId
            && candidate.activeProfileId === profileId
          )) {
            const groupTarget = {
              sessionId,
              serviceId: entry.serviceId,
              groupId,
              activeProfileId: profileId,
              groupGeneration: entry.groupGeneration ?? null,
            };
            targets.push(groupTarget);
            const serviceTargets = activeGroupTargetsByServiceId.get(entry.serviceId) ?? [];
            if (!serviceTargets.some((candidate) =>
              candidate.sessionId === groupTarget.sessionId
              && candidate.serviceId === groupTarget.serviceId
              && candidate.groupId === groupTarget.groupId
              && candidate.activeProfileId === groupTarget.activeProfileId
            )) {
              serviceTargets.push(groupTarget);
              activeGroupTargetsByServiceId.set(entry.serviceId, serviceTargets);
            }
          }
          groupSwitchTargetsByBindingKey.set(bindingKey, targets);
        }
      }
    }

    for (const source of this.startupCurrentSourceRefreshByKey.values()) {
      const profiles = bindingsByServiceId.get(source.serviceId);
      if (profiles) profiles.add(source.profileId);
      else bindingsByServiceId.set(source.serviceId, new Set([source.profileId]));
    }

    if (this.discoveryEnabled && typeof this.api.listConnectedServiceProfiles === 'function') {
      const discoveryDue = this.lastDiscoveryAt <= 0 || now - this.lastDiscoveryAt >= this.discoveryIntervalMs;
      if (discoveryDue) {
        this.lastDiscoveryAt = now;
        for (const serviceId of this.quotaFetchersByServiceId.keys()) {
          if (!this.shouldRunLegacyQuotaFetcher(serviceId, qualifiedPeerClass)) {
            continue;
          }
          try {
            const result = await this.api.listConnectedServiceProfiles({ serviceId });
            const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
            for (const prof of profiles) {
              if (!prof || typeof prof !== 'object') continue;
              if (!isConnectedServiceCredentialHealthStatusUsable(prof.status)) continue;
              const profileId = typeof prof.profileId === 'string' ? String(prof.profileId).trim() : '';
              if (!profileId) continue;
              const existing = bindingsByServiceId.get(serviceId);
              if (existing) {
                existing.add(profileId);
              } else {
                bindingsByServiceId.set(serviceId, new Set([profileId]));
              }
            }
          } catch {
            // Best-effort only.
            continue;
          }
        }
      }
    }

    for (const [serviceId, profileIds] of bindingsByServiceId.entries()) {
      if (!this.shouldRunLegacyQuotaFetcher(serviceId, qualifiedPeerClass)) {
        continue;
      }
      const fetcher = this.quotaFetchersByServiceId.get(serviceId);
      if (!fetcher) continue;

      for (const profileId of profileIds) {
        let expectedCredentialRevision:
          ResolvedQuotaFetchCredential['credentialRevision'] | null = null;
        try {
          const bindingKey = this.makeBindingKey({ serviceId, profileId });
          const directGroupTargets = groupSwitchTargetsByBindingKey.get(bindingKey) ?? [];
          const failureState = this.failureStateByBindingKey.get(bindingKey);
          if (failureState && now < failureState.nextAllowedAt) {
            continue;
          }
          const credential = await this.readCredentialRecordForQuotaFetch({
            accountMode,
            material,
            serviceId,
            profileId,
          });
          if (!credential) continue;
          expectedCredentialRevision = credential.credentialRevision;
          const groupContexts = await resolveGroupContextsForFetchedProfile({
            serviceId,
            profileId,
            directTargets: directGroupTargets,
          });
          const existing = await this.readExistingQuotaSnapshot({ accountMode, serviceId, profileId });
          const forcedRefresh = this.shouldForceQuotaRefresh(existing)
            || this.hasScheduledCurrentSourceRefreshForBinding({ serviceId, profileId });
          const existingSnapshot = this.openExistingQuotaSnapshot({
            accountMode,
            existing,
            material,
          });
          if (existingSnapshot) {
            this.recordQuotaPersistenceStateFromExisting({
              serviceId,
              profileId,
              snapshot: existingSnapshot,
              existing,
            });
          }

          if (this.isExistingQuotaSnapshotFresh({ existing, now, forcedRefresh })) {
            this.failureStateByBindingKey.delete(bindingKey);
            continue;
          }

          const lease = await this.acquireQuotaFetchLease({
            serviceId,
            profileId,
            expectedCredentialRevision: credential.credentialRevision,
          });
          if (lease.type === 'unavailable') continue;
          if (lease.type === 'contended') {
            const observedFresh = await this.readFreshExistingQuotaSnapshot({
              accountMode,
              serviceId,
              profileId,
              now,
              leaseUntil: lease.leaseUntil,
              material,
            });
            if (observedFresh) {
              this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: observedFresh });
              await this.recordFetchedQuotaSnapshotAsAccountUsage({
                serviceId,
                profileId,
                snapshot: observedFresh,
                now,
                groupContexts,
                groupTargets: directGroupTargets,
              });
              await this.maybeRequestActiveGroupSwitchForSnapshot({
                now,
                targets: directGroupTargets,
              });
              this.failureStateByBindingKey.delete(bindingKey);
            }
            continue;
          }

          const fetched = await this.fetchQuotaSnapshotForProfile({
            accountMode,
            material,
            fetcher,
            serviceId,
            profileId,
            credential,
          });
          if (!fetched) continue;
          if (
            existingSnapshot
            && hasUsefulQuotaSnapshotData(existingSnapshot)
            && isQuotaUnknownPlaceholderSnapshot(fetched.snapshot)
          ) {
            this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: existingSnapshot });
            this.failureStateByBindingKey.delete(bindingKey);
            continue;
          }

          this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: fetched.snapshot });
          const recordedAccountUsage = await this.recordFetchedQuotaSnapshotAsAccountUsage({
            serviceId,
            profileId,
            snapshot: fetched.snapshot,
            now,
            authenticatedProbe: true,
            groupContexts,
            groupTargets: directGroupTargets,
            sourceProviderAccountId: fetched.sourceProviderAccountId,
          });
          await this.maybeRequestActiveGroupSwitchForSnapshot({
            now,
            targets: directGroupTargets,
          });
          if (!recordedAccountUsage) {
            await this.persistQuotaSnapshotWithServerWork({
              accountMode: fetched.credentialStorageMode,
              serviceId,
              profileId,
              snapshot: fetched.snapshot,
              sourceProviderAccountId: fetched.sourceProviderAccountId,
              materialFingerprint: this.computeQuotaMaterialFingerprint(fetched.snapshot),
            });
          }
          this.failureStateByBindingKey.delete(bindingKey);
          for (const [key, source] of this.startupCurrentSourceRefreshByKey) {
            if (source.serviceId === serviceId && source.profileId === profileId) {
              this.startupCurrentSourceRefreshByKey.delete(key);
            }
          }
        } catch (error) {
          const bindingKey = this.makeBindingKey({ serviceId, profileId });
          if (expectedCredentialRevision) {
            await this.persistCredentialHealthForQuotaFailure({
              serviceId,
              profileId,
              error,
              now,
              expectedCredentialRevision,
            }).catch(() => false);
          }
          this.applyFailureBackoff({ now, key: bindingKey, error });
          // Best-effort only.
          continue;
        }
      }
    }

    await this.pollQualifiedConnectedAccountQuotas({
      accountMode,
      now,
      v4Support:
        qualifiedPeerClass === 'advertised_v4'
          ? 'advertised'
          : qualifiedPeerClass === 'revisioned_v2_v3'
            || qualifiedPeerClass === 'exact_v0_2_1'
            ? 'absent'
            : 'indeterminate',
    });
  }
}
