import {
  ConnectedServiceIdSchema,
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  readConnectedServiceCredentialRevisionBoundaryV1,
  ConnectedServiceUsageSourceV1Schema,
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
import { ConnectedServiceAuthGroupRuntimeStateRevisionConflictError } from '@/api/connectedServices/connectedServiceCredentialApi';
import { assertConnectedServiceCredentialRecordBinding } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
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
} from '../connectedServiceChildEnvironment';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  normalizeConnectedServiceAuthGroupPolicy,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
  buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
  resolveAccountUsageSnapshotsByGroupProfile,
  type AccountUsageStoreForAuthGroupSwitchState,
  type ConnectedServiceUsageSourceRecordRef,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import {
  resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence,
  type ConnectedServiceAuthGroupMemberRuntimeState,
} from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { reconcileMemberRuntimeStateWithFreshQuotaEvidence } from '../accountGroups/memberRuntimeState';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher } from './types';
import {
  buildQuotaPersistenceKey,
  resolveQuotaPersistenceAccountScope,
  type QuotaPersistenceAccountScope,
} from './quotaPersistenceKey';
import {
  computeQuotaSnapshotFingerprint,
  deriveQuotaSnapshotFingerprintHmacKey,
} from './quotaSnapshotFingerprint';
import { shouldPersistQuotaSnapshot, type ShouldPersistQuotaSnapshotStatus } from './shouldPersistQuotaSnapshot';
import {
  createConnectedServiceQuotaPersistenceScheduler,
  type ConnectedServiceQuotaPersistenceFlushResult as InProcessQuotaPersistenceFlushResult,
  type ConnectedServiceQuotaPersistenceScheduler,
} from './createConnectedServiceQuotaPersistenceScheduler';
import {
  reconcileIndexedSameAccountFanoutCandidates,
} from './identity/reconcileIndexedSameAccountFanoutCandidates';
import {
  resolveRuntimeAccountIdentityFanoutMatch,
} from './identity/resolveRuntimeAccountIdentityFanoutMatch';
import {
  persistedSessionAccountIdentityMatchesFailingAccount,
} from './identity/resolvePersistedMaterializationIdentityFanoutMatch';
import { resolveSessionsSharingProviderAccount } from './identity/resolveSessionsSharingProviderAccount';
import {
  requiresExactProviderAccountFanout,
  type ConnectedServiceSameAccountFanoutStrategy,
} from './identity/providerFanoutStrategy';
import type {
  PersistedSessionAccountIdentityReader,
  ReconciledRuntimeAccountIdentityEntry,
  RuntimeAccountIdentityEntry,
  RuntimeAccountIdentityProbeResult,
  RuntimeAccountIdentityRecordInput,
  RuntimeAccountIdentityRecordResult,
  RuntimeAccountIdentitySelection,
  RuntimeAccountIdentitySelectionInput,
  RuntimeAccountIdentitySource,
} from './identity/runtimeAccountIdentityTypes';
import {
  resolveQuotaProbeFreshProof,
  type QuotaProbeAppliedIdentity,
  type QuotaProbeFreshProofResult,
} from './proof/quotaProbeFreshProof';
import type { ConnectedServiceRuntimeAuthApplyCapability } from '../credentials/lifecycleTypes';
import {
  runtimeAuthApplyRequiresLiveIdentityProbe,
} from '../accountGroups/switching/predictiveSoftSwitchPolicy';
import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  buildConnectedServiceAuthGroupTargetEpochIdentity,
  type ConnectedServiceAuthGroupCommittedGenerationFact,
} from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import type { ConnectedServiceAuthGroupGenerationConsumptionOutcome } from '../accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { hasExactAcceptedConnectedServiceTargetAdoptionProof } from '../accountTransitions/acceptedConnectedServiceAccountVerification';
import {
  ConnectedServiceRuntimeRegistry,
  type ConnectedServiceRuntimeQuotaTarget,
} from '../runtimeRegistry/registry';
import type { ProviderAccountUsageStore } from '../accountUsage/store';
import type { ProviderAccountUsagePersistenceScheduler } from '../accountUsage/persistence';
import {
  evaluateConnectedServiceAuthGroupQuotaLifecycle,
  type ConnectedServiceAuthGroupQuotaLifecycleState,
} from '../accountGroups/quotas/lifecycle';
import {
  buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation,
} from '../accountUsage/fromConnectedServiceQuotaObservation';
import {
  authorizeProviderAccountUsageObservation,
  canRecordProviderAccountUsageSourceLinks,
} from '../accountUsage/record';
import { computeProviderAccountUsageSnapshotFingerprint } from '../accountUsage/fingerprint';
import { recordFetchedQuotaSnapshotAsAccountUsage } from './accountUsage/recordFetchedQuotaSnapshotAsAccountUsage';

import {
  annotateSnapshotAsStale,
  buildConnectedServiceUsageSourceKey,
  buildCredentialRecordForQuotaFetcher,
  buildQuotaAuthFailureCredentialHealth,
  DaemonServerWorkQuotaPersistenceError,
  DEFAULT_QUOTA_PERSISTENCE_MIN_FRESHNESS_REFRESH_MS,
  defaultSleepMs,
  deriveQuotaSnapshotStatus,
  extractActiveBindings,
  activeBindingMatchesRuntimeIdentity,
  isQuotaUnknownFallbackSnapshot,
  isQuotaAuthFailure,
  normalizeConnectedServiceQuotaGeneration,
  QUOTA_AUTH_FAILURE_REAUTH_CONSECUTIVE_FAILURES,
  readCredentialAccountIdentity,
  readFiniteNonNegativeMs,
  readQuotaRetryAfterMs,
  SAME_ACCOUNT_FANOUT_RESET_BUCKET_MS,
  shouldProbeCredentialRefreshForQuotaFailure,
  trimConnectedServiceQuotaString,
  UnknownAccountModeQuotaPersistenceError,
  type AccountUsageStoreForQuotaPolicy,
  type ActiveConnectedServiceBinding,
  type ActiveGroupQuotaSwitchTarget,
  type ActiveSameAccountFanoutCandidate,
  type AuthGroupSwitchCoordinator,
  type ConnectedServiceInBandQuotaSnapshotRecordResult,
  type ConnectedServiceQuotaCoordinatorDiagnostic,
  type ConnectedServiceQuotaGroupContext,
  type ConnectedServiceQuotaLifecycleListener,
  type ConnectedServiceQuotaLifecycleTransition,
  type ConnectedServiceQuotaPersistenceFlushResult,
  type ConnectedServiceQuotaRecoveryCreditConsumeResult,
  type ConnectedServiceQuotaSoftSwitchPolicyGuard,
  type ConnectedServiceRuntimeAuthApplyCapabilityResolver,
  type ConnectedServiceSameAccountFanoutStrategyResolver,
  type ConnectedServicesBindingsV1Like,
  type ExistingQuotaSnapshotResponse,
  type FailureState,
  type GroupSwitchTargetEligibility,
  type InBandQuotaPersistencePayload,
  type PersistedInBandQuotaState,
  type ProfileHealthByServiceId,
  type QuotaApi,
  type QuotaWorkPhase,
  type ReconciledColdSameAccountFanoutCandidates,
  type ResolvedExistingQuotaSnapshot,
  type ResolvedQuotaStorageMode,
  type RefreshConnectedServiceCredentialForQuota,
  type RuntimeAccountIdentityReader,
  type SameAccountFanoutDecisionTrace,
  type SameAccountFanoutProofSource,
  type SoftSwitchPolicyGuardResult,
} from './coordinator/support';

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

export type {
  ConnectedServiceInBandQuotaSnapshotRecordResult,
  ConnectedServiceQuotaCoordinatorDiagnostic,
  ConnectedServiceQuotaLifecycleListener,
  ConnectedServiceQuotaLifecycleTransition,
  ConnectedServiceQuotaPersistenceFlushResult,
  ConnectedServiceQuotaRecoveryCreditConsumeResult,
  ConnectedServiceQuotaSoftSwitchPolicyGuard,
} from './coordinator/support';

export type ConnectedServiceGroupQuotaProbeResult = Readonly<{
  status: 'complete' | 'incomplete';
  requestedProfileCount: number;
  completedProfileCount: number;
  completedProfileIds: ReadonlyArray<string>;
  reason?: 'deadline_exceeded' | 'probe_unavailable';
}>;

export const DEFAULT_CONNECTED_SERVICE_QUOTA_FETCH_TIMEOUT_MS = 15_000;

export class ConnectedServiceQuotasCoordinator {
  private static readonly MAX_STARTUP_CURRENT_SOURCE_REFRESHES = 256;
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
  private readonly accountUsageStore: AccountUsageStoreForQuotaPolicy | null;
  private readonly accountUsagePersistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
  private readonly machineIdProvider: (() => string | null | undefined) | null;
  private readonly ownerIdProvider: (() => string | null | undefined) | null;
  private readonly quotaFetchLeaseMs: number;
  private readonly quotaFetchLeaseContentionWaitMaxMs: number;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly quotaPersistenceScheduler: ConnectedServiceQuotaPersistenceScheduler<string, InBandQuotaPersistencePayload>;
  private readonly quotaPersistenceServerWorkScheduler: DaemonServerWorkScheduler | null;
  private readonly quotaPersistenceServerScope: string;
  private quotaPersistenceAccountScope: QuotaPersistenceAccountScope;
  private readonly quotaPersistenceAccountScopeCanRefresh: boolean;
  private readonly quotaPersistenceMinFreshnessRefreshMs: number;
  private readonly quotaFingerprintKeyMaterial: Uint8Array;
  private quotaFingerprintHmacKey: Uint8Array;
  private readonly authGroupSwitchCoordinator: AuthGroupSwitchCoordinator | null;
  private readonly consumeCommittedAuthGroupGeneration: ConsumeCommittedAuthGroupGeneration | null;
  private readonly softSwitchPolicyGuard: ConnectedServiceQuotaSoftSwitchPolicyGuard | null;
  private readonly sameAccountFanoutStrategyResolver: ConnectedServiceSameAccountFanoutStrategyResolver | null;
  private readonly refreshConnectedServiceCredentialForQuota: RefreshConnectedServiceCredentialForQuota | null;
  private readonly runtimeAuthApplyCapabilityResolver: ConnectedServiceRuntimeAuthApplyCapabilityResolver | null;
  private readonly readRuntimeAccountIdentity: RuntimeAccountIdentityReader | null;
  private readonly readPersistedSessionAccountIdentity: PersistedSessionAccountIdentityReader | null;
  private readonly groupSwitchCheckMinIntervalMs: number;
  private readonly groupSwitchCheckJitterMs: number;
  private readonly quotaWorkGate: DaemonServerWorkGate | null;
  private readonly recordDiagnostic: ((event: ConnectedServiceQuotaCoordinatorDiagnostic) => void) | null;
  private readonly onQuotaLifecycleTransition: ConnectedServiceQuotaLifecycleListener | null;
  private readonly quotaLifecycleFreshnessMs: number;
  private readonly sameAccountFanoutMinIntervalMs: number;
  private readonly runtimeRegistry: ConnectedServiceRuntimeRegistry;
  private readonly failureStateByBindingKey = new Map<string, FailureState>();
  private readonly groupSwitchCheckAtByKey = new Map<string, number>();
  private readonly sameAccountFanoutAtByKey = new Map<string, number>();
  /**
   * Sessions whose live runtime-identity probe reported `unsupported_session_runtime_method` — a
   * STABLE per-session capability fact. The fanout reconcile backs off re-probing these (one INFO
   * record, no per-tick storm). Cleared on dispose; entries are naturally bounded by live sessions.
   */
  private readonly liveIdentityProbeUnsupportedSessionIds = new Set<string>();
  private readonly persistedInBandQuotaStateByKey = new Map<string, PersistedInBandQuotaState>();
  private readonly quotaLifecycleStateByGroupKey = new Map<string, ConnectedServiceAuthGroupQuotaLifecycleState>();
  private readonly recoveryCreditConsumeResultsByKey = new Map<string, ConnectedServiceQuotaRecoveryCreditConsumeResult>();
  private readonly recoveryCreditConsumeInFlightByKey = new Map<string, Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult>>();
  private readonly startupCurrentSourceRefreshByKey = new Map<string, ConnectedServiceUsageSourceV1>();
  private readonly discoveredProfileIdsByServiceId = new Map<ConnectedServiceId, ReadonlySet<string>>();
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
    accountUsageStore?: AccountUsageStoreForQuotaPolicy | null;
    accountUsagePersistence?: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
    refreshConnectedServiceCredentialForQuota?: RefreshConnectedServiceCredentialForQuota;
    credentialRefreshWindowMs?: number;
    machineIdProvider?: () => string | null | undefined;
    ownerIdProvider?: () => string | null | undefined;
    quotaFetchLeaseMs?: number;
    quotaFetchLeaseContentionWaitMaxMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
    quotaPersistenceServerWorkScheduler?: DaemonServerWorkScheduler | null;
    quotaPersistenceServerScope?: string;
    quotaPersistenceAccountScope?: QuotaPersistenceAccountScope;
    quotaPersistenceIsConnected?: () => boolean;
    quotaPersistenceMaxConcurrent?: number;
    quotaPersistenceMinIntervalMs?: number;
    quotaPersistenceMaxKeys?: number;
    quotaPersistenceMaxKeyAgeMs?: number;
    quotaPersistenceMaxPendingPayloadAgeMs?: number;
    quotaPersistenceBackoffBaseMs?: number;
    quotaPersistenceBackoffMaxMs?: number;
    quotaPersistenceBackoffJitterRatio?: number;
    quotaPersistenceMinFreshnessRefreshMs?: number;
    quotaPersistenceMaxConsecutiveFailures?: number;
    authGroupSwitchCoordinator?: AuthGroupSwitchCoordinator | null;
    consumeCommittedAuthGroupGeneration?: ConsumeCommittedAuthGroupGeneration | null;
    softSwitchPolicyGuard?: ConnectedServiceQuotaSoftSwitchPolicyGuard | null;
    sameAccountFanoutStrategyResolver?: ConnectedServiceSameAccountFanoutStrategyResolver | null;
    runtimeAuthApplyCapabilityResolver?: ConnectedServiceRuntimeAuthApplyCapabilityResolver | null;
    readRuntimeAccountIdentity?: RuntimeAccountIdentityReader | null;
    readPersistedSessionAccountIdentity?: PersistedSessionAccountIdentityReader | null;
    groupSwitchCheckMinIntervalMs?: number;
    groupSwitchCheckJitterMs?: number;
    quotaWorkGate?: DaemonServerWorkGate | null;
    recordDiagnostic?: (event: ConnectedServiceQuotaCoordinatorDiagnostic) => void;
    onQuotaLifecycleTransition?: ConnectedServiceQuotaLifecycleListener | null;
    quotaLifecycleFreshnessMs?: number;
    runtimeAccountIdentityTtlMs?: number;
    sameAccountFanoutMinIntervalMs?: number;
    runtimeRegistry?: ConnectedServiceRuntimeRegistry;
  }>) {
    this.api = params.api;
    this.credentials = params.credentials;
    this.now = params.now;
    this.randomBytes = params.randomBytes;
    this.quotaFetchersByServiceId = new Map(params.quotaFetchers.map((f) => [f.serviceId, f]));
    this.fetchTimeoutMs =
      typeof params.fetchTimeoutMs === 'number' && Number.isFinite(params.fetchTimeoutMs)
        ? Math.max(1, Math.trunc(params.fetchTimeoutMs))
        : DEFAULT_CONNECTED_SERVICE_QUOTA_FETCH_TIMEOUT_MS;
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
    this.softSwitchPolicyGuard = params.softSwitchPolicyGuard ?? null;
    this.sameAccountFanoutStrategyResolver = params.sameAccountFanoutStrategyResolver ?? null;
    this.refreshConnectedServiceCredentialForQuota = params.refreshConnectedServiceCredentialForQuota ?? null;
    this.runtimeAuthApplyCapabilityResolver = params.runtimeAuthApplyCapabilityResolver ?? null;
    this.readRuntimeAccountIdentity = params.readRuntimeAccountIdentity ?? null;
    this.readPersistedSessionAccountIdentity = params.readPersistedSessionAccountIdentity ?? null;
    this.groupSwitchCheckMinIntervalMs =
      typeof params.groupSwitchCheckMinIntervalMs === 'number' && Number.isFinite(params.groupSwitchCheckMinIntervalMs)
        ? Math.max(0, Math.trunc(params.groupSwitchCheckMinIntervalMs))
        : 60_000;
    this.groupSwitchCheckJitterMs =
      typeof params.groupSwitchCheckJitterMs === 'number' && Number.isFinite(params.groupSwitchCheckJitterMs)
        ? Math.max(0, Math.trunc(params.groupSwitchCheckJitterMs))
        : 0;
    this.quotaWorkGate = params.quotaWorkGate ?? null;
    this.recordDiagnostic = params.recordDiagnostic ?? null;
    this.onQuotaLifecycleTransition = params.onQuotaLifecycleTransition ?? null;
    this.quotaLifecycleFreshnessMs =
      typeof params.quotaLifecycleFreshnessMs === 'number' && Number.isFinite(params.quotaLifecycleFreshnessMs)
        ? Math.max(0, Math.trunc(params.quotaLifecycleFreshnessMs))
        : 5 * 60_000;
    this.sameAccountFanoutMinIntervalMs =
      typeof params.sameAccountFanoutMinIntervalMs === 'number' && Number.isFinite(params.sameAccountFanoutMinIntervalMs)
        ? Math.max(0, Math.trunc(params.sameAccountFanoutMinIntervalMs))
        : 60_000;
    this.runtimeRegistry = params.runtimeRegistry ?? new ConnectedServiceRuntimeRegistry({
      nowMs: params.now,
      runtimeAccountIdentityTtlMs: params.runtimeAccountIdentityTtlMs,
    });
    this.quotaPersistenceServerWorkScheduler = params.quotaPersistenceServerWorkScheduler ?? null;
    this.quotaPersistenceServerScope = params.quotaPersistenceServerScope?.trim() || 'current-server';
    this.quotaPersistenceAccountScopeCanRefresh = params.quotaPersistenceAccountScope === undefined;
    this.quotaPersistenceAccountScope =
      params.quotaPersistenceAccountScope ?? resolveQuotaPersistenceAccountScope(params.credentials);
    this.quotaPersistenceMinFreshnessRefreshMs =
      typeof params.quotaPersistenceMinFreshnessRefreshMs === 'number' && Number.isFinite(params.quotaPersistenceMinFreshnessRefreshMs)
        ? Math.max(0, Math.trunc(params.quotaPersistenceMinFreshnessRefreshMs))
        : DEFAULT_QUOTA_PERSISTENCE_MIN_FRESHNESS_REFRESH_MS;
    const quotaPersistenceMinIntervalMs =
      typeof params.quotaPersistenceMinIntervalMs === 'number' && Number.isFinite(params.quotaPersistenceMinIntervalMs)
        ? Math.max(0, Math.trunc(params.quotaPersistenceMinIntervalMs))
        : 5_000;
    const quotaPersistenceBackoff = createKeyedBackoffTracker({
      baseDelayMs:
        typeof params.quotaPersistenceBackoffBaseMs === 'number' && Number.isFinite(params.quotaPersistenceBackoffBaseMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceBackoffBaseMs))
          : 1_000,
      maxDelayMs:
        typeof params.quotaPersistenceBackoffMaxMs === 'number' && Number.isFinite(params.quotaPersistenceBackoffMaxMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceBackoffMaxMs))
          : 60_000,
      jitterRatio:
        typeof params.quotaPersistenceBackoffJitterRatio === 'number' && Number.isFinite(params.quotaPersistenceBackoffJitterRatio)
          ? Math.min(1, Math.max(0, params.quotaPersistenceBackoffJitterRatio))
          : 0.2,
      now: params.now,
    });
    const fingerprintKeyMaterial = params.credentials.encryption.type === 'legacy'
      ? params.credentials.encryption.secret
      : params.credentials.encryption.machineKey;
    this.quotaFingerprintKeyMaterial = fingerprintKeyMaterial;
    this.quotaFingerprintHmacKey = this.deriveQuotaFingerprintHmacKey();
    this.quotaPersistenceScheduler = createConnectedServiceQuotaPersistenceScheduler({
      run: async (_key, payload) => {
        await this.flushInBandQuotaPersistencePayload(payload);
      },
      maxConcurrent:
        typeof params.quotaPersistenceMaxConcurrent === 'number' && Number.isFinite(params.quotaPersistenceMaxConcurrent)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxConcurrent))
          : 1,
      minKeyIntervalMs: quotaPersistenceMinIntervalMs,
      maxKeys:
        typeof params.quotaPersistenceMaxKeys === 'number' && Number.isFinite(params.quotaPersistenceMaxKeys)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxKeys))
          : 256,
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
      now: params.now,
      isConnected: params.quotaPersistenceIsConnected,
      backoff: quotaPersistenceBackoff,
      shouldRetry: (error) => this.shouldRetryQuotaPersistence(error),
      shouldPauseAfterFailure: (error) => {
        if (error instanceof UnknownAccountModeQuotaPersistenceError) return false;
        if (error instanceof DaemonServerWorkQuotaPersistenceError && error.outcome.status === 'deferred') return false;
        if (
          error instanceof DaemonServerWorkQuotaPersistenceError
          && error.outcome.status === 'failed'
          && error.outcome.classification.kind === 'dependency_unavailable'
        ) {
          return false;
        }
        return true;
      },
      onEvent: (event) => {
        if (event.type !== 'coalesced' && event.type !== 'suppressed' && event.type !== 'deferred') return;
        this.quotaPersistenceServerWorkScheduler?.recordEvent({
          purpose: 'connectedServiceQuotaPersistence',
          key: event.key,
          type: event.type,
        });
      },
    });
  }

  public registerSpawnTarget(params: Readonly<{
    pid: number;
    sessionId?: string;
    connectedServicesBindingsRaw: ConnectedServicesBindingsV1Like;
    connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string>;
    runtimeAccountIdentitySelections?: ReadonlyArray<RuntimeAccountIdentitySelectionInput>;
  }>): void {
    const pid = Math.trunc(Number(params.pid));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    if (sessionId) {
      this.runtimeRegistry.invalidateRuntimeAccountIdentity(sessionId);
    }
    const target = this.runtimeRegistry.registerTarget({
      pid,
      ...(sessionId ? { sessionId } : {}),
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw ?? {},
      ...(params.connectedServiceSelectionsEnv ? { connectedServiceSelectionsEnv: { ...params.connectedServiceSelectionsEnv } } : {}),
      ...(params.runtimeAccountIdentitySelections
        ? { runtimeAccountIdentitySelections: params.runtimeAccountIdentitySelections }
        : {}),
    });
    if (sessionId && params.runtimeAccountIdentitySelections) {
      this.recordRuntimeAccountIdentitySelections({
        sessionId,
        bindings: extractActiveBindings(target.connectedServicesBindingsRaw, target.connectedServiceSelectionsEnv),
        selections: params.runtimeAccountIdentitySelections,
      });
    }
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
      this.runtimeRegistry.invalidateRuntimeAccountIdentity(target.sessionId);
    }
    this.runtimeRegistry.invalidateRuntimeAccountIdentity(sessionId);
    const nextTarget = this.runtimeRegistry.adoptSessionId({ pid, sessionId });
    if (!nextTarget) return;
    if (target.runtimeAccountIdentitySelections) {
      this.recordRuntimeAccountIdentitySelections({
        sessionId,
        bindings: extractActiveBindings(nextTarget.connectedServicesBindingsRaw, nextTarget.connectedServiceSelectionsEnv),
        selections: target.runtimeAccountIdentitySelections,
      });
    }
  }

  public unregisterPid(pidRaw: number): void {
    const pid = Math.trunc(Number(pidRaw));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const target = this.runtimeRegistry.getByPid(pid);
    if (target?.sessionId) {
      this.runtimeRegistry.invalidateRuntimeAccountIdentity(target.sessionId);
    }
    this.runtimeRegistry.unregisterPid(pid);
  }

  public transferPid(fromPidRaw: number, toPidRaw: number): void {
    const fromPid = Math.trunc(Number(fromPidRaw));
    const toPid = Math.trunc(Number(toPidRaw));
    if (!Number.isFinite(fromPid) || fromPid <= 0 || !Number.isFinite(toPid) || toPid <= 0) return;
    const target = this.runtimeRegistry.getByPid(fromPid);
    if (!target) return;
    if (target.sessionId) {
      this.runtimeRegistry.invalidateRuntimeAccountIdentity(target.sessionId);
    }
    this.runtimeRegistry.transferPid(fromPid, toPid);
  }

  private makeBindingKey(params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>): string {
    return `${params.serviceId}\u0000${params.profileId}`;
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

  private applyFailureBackoff(params: Readonly<{
    now: number;
    key: string;
    retryAfterMs?: number | null;
    retryAfterBackoffMinMs?: number | null;
  }>): void {
    const existing = this.failureStateByBindingKey.get(params.key);
    const consecutiveFailures = Math.min((existing?.consecutiveFailures ?? 0) + 1, 30);
    const retryAfterMs = readFiniteNonNegativeMs(params.retryAfterMs);
    if (retryAfterMs !== null) {
      const floorMs = readFiniteNonNegativeMs(params.retryAfterBackoffMinMs) ?? 0;
      this.failureStateByBindingKey.set(params.key, {
        consecutiveFailures,
        nextAllowedAt: params.now + Math.max(retryAfterMs, floorMs, 1),
      });
      return;
    }
    const expMs = this.failureBackoffMinMs * Math.pow(2, consecutiveFailures - 1);
    const cappedMs = Math.min(expMs, this.failureBackoffMaxMs);
    const jitteredMs = this.computeJitteredBackoffMs(cappedMs);
    this.failureStateByBindingKey.set(params.key, {
      consecutiveFailures,
      nextAllowedAt: params.now + jitteredMs,
    });
  }

  public async recordInBandQuotaSnapshot(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>): Promise<ConnectedServiceInBandQuotaSnapshotRecordResult> {
    if (input.snapshot.serviceId !== input.serviceId) {
      return { status: 'suppressed', reason: 'service_id_mismatch' };
    }

    await this.recordFetchedQuotaSnapshotAsAccountUsage({
      serviceId: input.serviceId,
      profileId: input.profileId,
      snapshot: input.snapshot,
      now: Math.max(0, Math.trunc(this.now())),
      persistDurably: false,
    });

    const key = this.buildQuotaPersistenceKey(input).key;
    const status = deriveQuotaSnapshotStatus(input.snapshot);
    const materialFingerprint = this.computeQuotaMaterialFingerprint(input.snapshot);
    const previous = this.persistedInBandQuotaStateByKey.get(key) ?? null;
    const materiality = shouldPersistQuotaSnapshot({
      previous,
      incoming: { snapshot: input.snapshot, fingerprint: materialFingerprint, status },
      minFreshnessRefreshMs: this.quotaPersistenceMinFreshnessRefreshMs,
    });
    if (!materiality.persist) return { status: 'suppressed', reason: materiality.reason };

    const enqueue = this.quotaPersistenceScheduler.enqueue(key, {
      serviceId: input.serviceId,
      profileId: input.profileId,
      snapshot: input.snapshot,
      materialFingerprint,
      status,
    });
    if (enqueue.type === 'suppressed') return { status: 'suppressed', reason: enqueue.reason };
    return { status: 'enqueued', enqueue: enqueue.type };
  }

  public async flushInBandQuotaPersistence(timeoutMs: number): Promise<ConnectedServiceQuotaPersistenceFlushResult> {
    const inProcess = await this.quotaPersistenceScheduler.flushAll(timeoutMs);
    const serverWork = this.quotaPersistenceServerWorkScheduler
      ? await this.quotaPersistenceServerWorkScheduler.flushAll(timeoutMs)
      : null;
    return {
      timedOut: inProcess.timedOut || serverWork?.timedOut === true,
      inProcess,
      serverWork,
    };
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

    // Reactive preemption: a genuine in-band usage change (delivered outside the poll) is the freshest
    // per-session consumption signal. Re-evaluate the burn-projected soft-switch NOW (through the
    // existing, fully flap-guarded soft-switch machinery) instead of waiting for the ~30-minute quota
    // poll — the whole point of catching a fast burn before the hard limit. The poll performs its own
    // soft-switch check (`source: 'poll'`), so suppress the reactive re-check there to avoid a
    // double-request. Best-effort; the poll remains the backstop.
    const changedProfileId = input.profileId.trim();
    if (input.source === 'evidence_only') {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'soft_switch',
        reason: 'post_hard_limit_snapshot_evidence_only',
        sessionId: input.sessionId,
        serviceId: input.serviceId,
        groupId,
        activeProfileId: changedProfileId,
      });
    }
    if (input.source === 'in_band' && changedProfileId) {
      await this.maybeRequestActiveGroupSwitchForSnapshot({
        now: this.now(),
        targets: [{
          sessionId: input.sessionId,
          serviceId: input.serviceId,
          groupId,
          activeProfileId: changedProfileId,
          groupGeneration: normalizeConnectedServiceQuotaGeneration(input.groupGeneration),
        }],
      }).catch(() => undefined);
    }

    if (!listener) return;
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
    if (evaluation.edge.phase === 'no_edge') return;
    try {
      await listener(evaluation.edge);
    } catch {
      // Lifecycle notifications are best-effort; account usage remains canonical.
    }
  }

  public notifyQuotaPersistenceConnectivityChanged(): void {
    this.quotaPersistenceScheduler.notifyConnectivityChanged();
  }

  public dispose(): void {
    this.quotaPersistenceScheduler.dispose();
    this.runtimeRegistry.clearRuntimeAccountIdentities();
    this.sameAccountFanoutAtByKey.clear();
    this.liveIdentityProbeUnsupportedSessionIds.clear();
    this.quotaLifecycleStateByGroupKey.clear();
  }

  public recordRuntimeAccountIdentityFromSnapshot(
    input: RuntimeAccountIdentityRecordInput,
  ): RuntimeAccountIdentityRecordResult {
    return this.runtimeRegistry.recordRuntimeAccountIdentity(input);
  }

  public recordRuntimeAccountIdentityFromSelection(input: Readonly<{
    sessionId: string;
    selection: RuntimeAccountIdentitySelectionInput;
  }>): RuntimeAccountIdentityRecordResult {
    return this.recordRuntimeAccountIdentitySelection({
      sessionId: input.sessionId,
      selection: input.selection,
    });
  }

  public async recordAccountExhaustionAndFanout(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    exhaustedProfileId: string;
    providerAccountId?: string | null;
    sourceGroupGeneration?: number | null;
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
    void input.reason;
    const authGroupSwitchCoordinator = this.authGroupSwitchCoordinator;
    if (!authGroupSwitchCoordinator) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const committedGeneration = input.committedGeneration ?? null;
    const committedTarget = committedGeneration?.decisionCommittedTarget ?? null;
    if (
      !committedGeneration
      || committedTarget?.serviceId !== input.serviceId
      || committedTarget.groupId !== input.groupId
    ) {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'same_account_fanout',
        reason: 'hard_limit_committed_generation_missing',
      });
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const generationTargets = this.listCommittedGenerationTargetsForGroup({
      serviceId: input.serviceId,
      groupId: input.groupId,
      sourceSessionId: input.sourceSessionId,
      sourceProfileId: input.exhaustedProfileId,
      includeSource: input.sourceRequiresConvergence !== false,
    });
    const applyCommittedGeneration = async (): Promise<number> => await this.applyCommittedAuthGroupGeneration({
      committedGeneration,
      reason: 'same_provider_account_exhausted',
      targets: generationTargets,
    });
    const fanoutStrategy = input.resolvedFanoutStrategy
      ?? await this.resolveSameAccountFanoutStrategy({
        sourceSessionId: input.sourceSessionId,
        serviceId: input.serviceId,
        groupId: input.groupId,
      });
    if (fanoutStrategy === 'none') {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'same_account_fanout',
        reason: 'same_account_fanout_strategy_not_exact_provider_account',
      });
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: await applyCommittedGeneration() };
    }
    const providerAccountId = trimConnectedServiceQuotaString(input.providerAccountId) ?? '';
    const sourceGroupGeneration = normalizeConnectedServiceQuotaGeneration(input.sourceGroupGeneration);
    if (fanoutStrategy === 'provider_account_id' && !providerAccountId) {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'same_account_fanout',
        reason: 'same_account_fanout_missing_provider_account_id',
      });
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: await applyCommittedGeneration() };
    }
    this.recordRuntimeAccountIdentitySelectionsFromRegistryTargets();
    const currentGroupGenerationBySessionId = this.buildCurrentGroupGenerationBySessionId({
      serviceId: input.serviceId,
      groupId: input.groupId,
    });
    const indexedCandidates = requiresExactProviderAccountFanout(fanoutStrategy)
      ? resolveSessionsSharingProviderAccount(this.runtimeRegistry, {
          serviceId: input.serviceId,
          groupId: input.groupId,
          providerAccountId,
          excludeSessionId: input.sourceSessionId,
          currentGroupGenerationBySessionId,
        }).filter((entry) => this.hasActiveSpawnTargetForIdentity(entry))
      : [];
    const reconciledIndexedCandidates = requiresExactProviderAccountFanout(fanoutStrategy)
      ? await this.reconcileIndexedSameAccountFanoutCandidates({
          sourceSessionId: input.sourceSessionId,
          serviceId: input.serviceId,
          groupId: input.groupId,
          providerAccountId,
          indexedCandidates,
        })
      : [];
    const coldReconciliation = await this.reconcileColdSameAccountFanoutCandidates({
      strategy: fanoutStrategy,
      sourceSessionId: input.sourceSessionId,
      sourceProfileId: input.exhaustedProfileId,
      serviceId: input.serviceId,
      groupId: input.groupId,
      providerAccountId,
      expectedProviderAccountId: providerAccountId || null,
      indexedCandidates: reconciledIndexedCandidates,
      sourceGroupGeneration,
      currentGroupGenerationBySessionId,
    });
    const candidates = this.mergeSameAccountFanoutCandidates(reconciledIndexedCandidates, coldReconciliation.candidates);
    if (candidates.length === 0) {
      if (indexedCandidates.length === 0 && coldReconciliation.activeCandidateCount === 0) {
        this.recordDiagnostic?.({
          event: 'quota_work_suppressed',
          phase: 'same_account_fanout',
          reason: 'same_account_fanout_no_matching_sessions',
        });
      }
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: await applyCommittedGeneration() };
    }
    if (this.isSameAccountFanoutCoalesced(input)) {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'same_account_fanout',
        reason: 'same_provider_account_exhaustion_coalesced',
      });
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: await applyCommittedGeneration() };
    }

    for (const candidate of candidates) {
      this.runtimeRegistry.invalidateRuntimeAccountIdentity(candidate.sessionId);
    }
    const fanoutRequests = await applyCommittedGeneration();
    return {
      status: 'recorded',
      fanoutCandidates: candidates.length,
      fanoutRequests,
    };
  }

  private listCommittedGenerationTargetsForGroup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    sourceSessionId: string;
    sourceProfileId: string;
    includeSource: boolean;
  }>): ReadonlyArray<Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    fromProfileId: string;
  }>> {
    const targetsBySessionId = new Map<string, Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      groupId: string;
      fromProfileId: string;
    }>>();
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
      if (!sessionId) continue;
      const binding = target.activeBindings.find((candidate) => (
        candidate.serviceId === input.serviceId && candidate.groupId === input.groupId
      )) ?? extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv)
        .find((candidate) => candidate.serviceId === input.serviceId && candidate.groupId === input.groupId);
      if (!binding) continue;
      targetsBySessionId.set(sessionId, {
        sessionId,
        serviceId: input.serviceId,
        groupId: input.groupId,
        fromProfileId: binding.profileId,
      });
    }
    if (input.includeSource && !targetsBySessionId.has(input.sourceSessionId)) {
      targetsBySessionId.set(input.sourceSessionId, {
        sessionId: input.sourceSessionId,
        serviceId: input.serviceId,
        groupId: input.groupId,
        fromProfileId: input.sourceProfileId,
      });
    } else if (input.includeSource) {
      const source = targetsBySessionId.get(input.sourceSessionId)!;
      targetsBySessionId.delete(input.sourceSessionId);
      targetsBySessionId.set(input.sourceSessionId, source);
    } else if (!input.includeSource) {
      targetsBySessionId.delete(input.sourceSessionId);
    }
    return Array.from(targetsBySessionId.values());
  }

  private async decideAndApplyAuthGroupGeneration(input: Readonly<{
    reason: 'soft_threshold';
    observedProfileId: string;
    targets: ReadonlyArray<Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      groupId: string;
      fromProfileId: string;
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
    }).catch(() => null);
    if (!rawDecision || typeof rawDecision !== 'object' || Array.isArray(rawDecision)) return 1;
    const decision = rawDecision as Readonly<Record<string, unknown>>;
    const activeProfileId = typeof decision.activeProfileId === 'string' && decision.activeProfileId.trim()
      ? decision.activeProfileId.trim()
      : null;
    const generation = typeof decision.generation === 'number' && Number.isInteger(decision.generation) && decision.generation >= 0
      ? decision.generation
      : null;
    const credentialRevisionParsed = ConnectedServiceCredentialRevisionV1Schema.safeParse(decision.credentialRevision);
    const status = typeof decision.status === 'string' ? decision.status : '';
    if (!activeProfileId || generation === null || ![
      'switched',
      'observed_generation',
      'superseded_after_apply',
    ].includes(status)) return 1;

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
      requestedTarget: { profileId: activeProfileId },
      decisionCommittedTarget,
    });
    return await this.applyCommittedAuthGroupGeneration({
      committedGeneration,
      reason: input.reason,
      targets: input.targets,
      ...(hasExactAcceptedConnectedServiceTargetAdoptionProof({
        verificationByServiceId: decision.verificationByServiceId,
        target: decisionCommittedTarget,
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
    }>>;
    skipInitialSessionId?: string;
  }>): Promise<number> {
    const coordinator = this.authGroupSwitchCoordinator;
    if (!coordinator || input.targets.length === 0) return 0;
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
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'durable_generation_consumer_unavailable',
    });
    return 0;
  }

  public async recordRuntimeUsageLimitExhaustionAndFanout(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    exhaustedProfileId: string;
    resetAtMs: number | null;
    sourceGroupGeneration?: number | null;
    sourceProviderAccountId?: string | null;
    sourceAccountLabel?: string | null;
    committedGeneration?: ConnectedServiceAuthGroupCommittedGenerationFact | null;
    sourceRequiresConvergence?: boolean;
  }>): Promise<Readonly<{
    status: 'recorded';
    fanoutCandidates: number;
    fanoutRequests: number;
  }>> {
    const groupId = trimConnectedServiceQuotaString(input.groupId);
    const exhaustedProfileId = trimConnectedServiceQuotaString(input.exhaustedProfileId);
    if (!groupId || !exhaustedProfileId) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }

    const fanoutStrategy = await this.resolveSameAccountFanoutStrategy({
      sourceSessionId: input.sourceSessionId,
      serviceId: input.serviceId,
      groupId,
    });
    if (!requiresExactProviderAccountFanout(fanoutStrategy)) {
      return await this.recordAccountExhaustionAndFanout({
        sourceSessionId: input.sourceSessionId,
        serviceId: input.serviceId,
        groupId,
        exhaustedProfileId,
        sourceGroupGeneration: input.sourceGroupGeneration,
        resetAtMs: input.resetAtMs,
        reason: 'usage_limit',
        committedGeneration: input.committedGeneration,
        sourceRequiresConvergence: input.sourceRequiresConvergence,
        resolvedFanoutStrategy: fanoutStrategy,
      });
    }

    this.recordRuntimeAccountIdentitySelectionsFromRegistryTargets();
    const currentGroupGeneration = this.buildCurrentGroupGenerationBySessionId({
      serviceId: input.serviceId,
      groupId,
    }).get(input.sourceSessionId) ?? null;
    const sourceGroupGeneration = normalizeConnectedServiceQuotaGeneration(input.sourceGroupGeneration)
      ?? currentGroupGeneration;
    const reportedProviderAccountId = trimConnectedServiceQuotaString(input.sourceProviderAccountId);
    if (reportedProviderAccountId) {
      this.runtimeRegistry.recordRuntimeAccountIdentity({
        sessionId: input.sourceSessionId,
        serviceId: input.serviceId,
        groupId,
        profileId: exhaustedProfileId,
        providerAccountId: reportedProviderAccountId,
        accountLabel: trimConnectedServiceQuotaString(input.sourceAccountLabel),
        observedAtMs: this.now(),
        source: 'runtime_auth_failure_report',
        proofStrength: 'exact',
        groupGeneration: sourceGroupGeneration,
      });
      return await this.recordAccountExhaustionAndFanout({
        sourceSessionId: input.sourceSessionId,
        serviceId: input.serviceId,
        groupId,
        exhaustedProfileId,
        providerAccountId: reportedProviderAccountId,
        sourceGroupGeneration,
        resetAtMs: input.resetAtMs,
        reason: 'usage_limit',
        committedGeneration: input.committedGeneration,
        sourceRequiresConvergence: input.sourceRequiresConvergence,
      });
    }
    const indexedSourceIdentity = this.runtimeRegistry.readRuntimeAccountIdentity(input.sourceSessionId);
    const indexedProviderAccountId = this.resolveUsableSourceProviderAccountId({
      identity: indexedSourceIdentity,
      serviceId: input.serviceId,
      groupId,
      profileId: exhaustedProfileId,
      currentGroupGeneration: sourceGroupGeneration,
    });
    if (indexedProviderAccountId) {
      return await this.recordAccountExhaustionAndFanout({
        sourceSessionId: input.sourceSessionId,
        serviceId: input.serviceId,
        groupId,
        exhaustedProfileId,
        providerAccountId: indexedProviderAccountId,
        sourceGroupGeneration,
        resetAtMs: input.resetAtMs,
        reason: 'usage_limit',
        committedGeneration: input.committedGeneration,
        sourceRequiresConvergence: input.sourceRequiresConvergence,
      });
    }

    const probedProviderAccountId = await this.probeSourceProviderAccountIdForFanout({
      sourceSessionId: input.sourceSessionId,
      serviceId: input.serviceId,
      groupId,
      profileId: exhaustedProfileId,
      currentGroupGeneration: sourceGroupGeneration,
    });
    if (!probedProviderAccountId) {
      this.recordSameAccountFanoutSuppression({
        reason: 'same_account_fanout_missing_source_provider_account_id',
        serviceId: input.serviceId,
        groupId,
        sourceSessionId: input.sourceSessionId,
        sourceProfileId: exhaustedProfileId,
        proofSource: 'runtime_identity_probe',
        proofSourcesTried: [
          'runtime_auth_failure_report',
          'runtime_identity_index',
          'runtime_identity_probe',
        ],
        expectedGroupGeneration: sourceGroupGeneration,
      });
      return await this.recordAccountExhaustionAndFanout({
        sourceSessionId: input.sourceSessionId,
        serviceId: input.serviceId,
        groupId,
        exhaustedProfileId,
        sourceGroupGeneration,
        resetAtMs: input.resetAtMs,
        reason: 'usage_limit',
        committedGeneration: input.committedGeneration,
        sourceRequiresConvergence: input.sourceRequiresConvergence,
        resolvedFanoutStrategy: fanoutStrategy,
      });
    }

    return await this.recordAccountExhaustionAndFanout({
      sourceSessionId: input.sourceSessionId,
      serviceId: input.serviceId,
      groupId,
      exhaustedProfileId,
      providerAccountId: probedProviderAccountId,
      sourceGroupGeneration,
      resetAtMs: input.resetAtMs,
      reason: 'usage_limit',
      committedGeneration: input.committedGeneration,
      sourceRequiresConvergence: input.sourceRequiresConvergence,
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

  private async resolveSameAccountFanoutStrategy(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceSameAccountFanoutStrategy> {
    if (!this.sameAccountFanoutStrategyResolver) return 'none';
    try {
      return await this.sameAccountFanoutStrategyResolver(input);
    } catch {
      return 'none';
    }
  }

  private async resolveRuntimeAuthApplyCapability(input: Readonly<{
    sourceSessionId: string;
    targetSessionId?: string;
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceRuntimeAuthApplyCapability> {
    if (!this.runtimeAuthApplyCapabilityResolver) return { directLiveHotAuth: 'unsupported' };
    try {
      return await this.runtimeAuthApplyCapabilityResolver(input);
    } catch {
      return { directLiveHotAuth: 'unsupported' };
    }
  }

  private isSameAccountFanoutCoalesced(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    providerAccountId?: string | null;
    resetAtMs: number | null;
  }>): boolean {
    const minIntervalMs = this.sameAccountFanoutMinIntervalMs;
    if (minIntervalMs <= 0) return false;
    const key = this.buildSameAccountFanoutCoalescingKey(input);
    const now = this.now();
    const lastAt = this.sameAccountFanoutAtByKey.get(key);
    if (lastAt !== undefined && now - lastAt < minIntervalMs) {
      return true;
    }
    this.sameAccountFanoutAtByKey.set(key, now);
    return false;
  }

  private buildSameAccountFanoutCoalescingKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    providerAccountId?: string | null;
    resetAtMs: number | null;
  }>): string {
    const groupId = input.groupId.trim();
    const providerAccountId = trimConnectedServiceQuotaString(input.providerAccountId) ?? '';
    const resetBucket = typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs)
      ? Math.floor(Math.max(0, input.resetAtMs) / SAME_ACCOUNT_FANOUT_RESET_BUCKET_MS)
      : 'unknown';
    return `${input.serviceId}\u0000${groupId}\u0000${providerAccountId}\u0000${resetBucket}`;
  }

  private buildSameAccountFanoutDecisionTrace(input: Readonly<{
    proofSource: SameAccountFanoutProofSource;
    sameAccountFanoutStrategy?: ConnectedServiceSameAccountFanoutStrategy;
    sourceSessionId: string;
    sourceProfileId: string;
    expectedGroupGeneration: number | null;
    proofSourcesTried?: readonly SameAccountFanoutProofSource[];
  }>): SameAccountFanoutDecisionTrace {
    return {
      proofSource: input.proofSource,
      ...(input.sameAccountFanoutStrategy ? { sameAccountFanoutStrategy: input.sameAccountFanoutStrategy } : {}),
      proofKind: input.proofSource === 'registry_binding'
        ? 'registry_binding'
        : input.proofSource === 'runtime_identity_probe'
          ? 'runtime_exact'
          : input.proofSource === 'persisted_materialization_identity'
            ? 'persisted_materialization_identity'
            : input.proofSource,
      sourceSessionId: input.sourceSessionId,
      sourceProfileId: input.sourceProfileId,
      expectedGroupGeneration: normalizeConnectedServiceQuotaGeneration(input.expectedGroupGeneration),
      ...(input.proofSourcesTried && input.proofSourcesTried.length > 0
        ? { proofSourcesTried: [...input.proofSourcesTried] }
        : {}),
    };
  }

  private recordSameAccountFanoutSuppression(input: Readonly<{
    reason: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    sourceSessionId: string;
    sourceProfileId: string;
    proofSource: SameAccountFanoutProofSource;
    sameAccountFanoutStrategy?: ConnectedServiceSameAccountFanoutStrategy;
    proofSourcesTried?: readonly SameAccountFanoutProofSource[];
    sessionId?: string;
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
  }>): void {
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: input.reason,
      sessionId: input.sessionId ?? input.sourceSessionId,
      serviceId: input.serviceId,
      groupId: input.groupId,
      sourceProfileId: input.sourceProfileId,
      ...(input.expectedProviderAccountId === undefined ? {} : { expectedProviderAccountId: input.expectedProviderAccountId }),
      ...(input.actualProviderAccountId === undefined ? {} : { actualProviderAccountId: input.actualProviderAccountId }),
      ...(input.expectedProfileId === undefined ? {} : { expectedProfileId: input.expectedProfileId }),
      ...(input.actualProfileId === undefined ? {} : { actualProfileId: input.actualProfileId }),
      ...(input.expectedGroupId === undefined ? {} : { expectedGroupId: input.expectedGroupId }),
      ...(input.actualGroupId === undefined ? {} : { actualGroupId: input.actualGroupId }),
      ...(input.expectedGroupGeneration === undefined
        ? {}
        : { expectedGroupGeneration: normalizeConnectedServiceQuotaGeneration(input.expectedGroupGeneration) }),
      ...(input.actualGroupGeneration === undefined
        ? {}
        : { actualGroupGeneration: normalizeConnectedServiceQuotaGeneration(input.actualGroupGeneration) }),
      ...(input.probeStatus === undefined ? {} : { probeStatus: input.probeStatus }),
      ...(input.probeReason === undefined ? {} : { probeReason: input.probeReason }),
      decisionTrace: this.buildSameAccountFanoutDecisionTrace({
        proofSource: input.proofSource,
        sameAccountFanoutStrategy: input.sameAccountFanoutStrategy,
        sourceSessionId: input.sourceSessionId,
        sourceProfileId: input.sourceProfileId,
        expectedGroupGeneration: input.expectedGroupGeneration ?? null,
        proofSourcesTried: input.proofSourcesTried,
      }),
    });
  }

  private recordNoEligibleSameAccountFanoutTarget(
    targetEligibility: Extract<GroupSwitchTargetEligibility, { status: 'no_eligible_target' }>,
  ): void {
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'same_account_fanout',
      reason: 'group_exhausted_no_eligible_target',
      ...(targetEligibility.retryAfterMs === null ? {} : { retryAfterMs: targetEligibility.retryAfterMs }),
      ...(targetEligibility.decisionTrace === undefined ? {} : { decisionTrace: targetEligibility.decisionTrace }),
    });
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
  }>): Readonly<{
    kind: 'source_backed' | 'provisional';
    state: Readonly<{
      serviceId: string;
      groupId: string;
      activeProfileId: string | null;
      generation: number;
      policy: ReturnType<typeof normalizeConnectedServiceAuthGroupPolicy>;
      members: ReadonlyArray<Readonly<{
        profileId: string;
        priority: number;
        enabled: boolean;
        createdAtMs: number;
      }>>;
      memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
    }>;
    sourceRefsByProfileId: ReadonlyMap<string, ConnectedServiceUsageSourceRecordRef>;
  }> | null {
    if (!this.accountUsageStore) return null;
    return buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group: input.group,
      accountUsageStore: this.accountUsageStore,
    });
  }

  private async resolveGroupSwitchTargetEligibility(input: Readonly<{
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
    const accountUsageSwitchState = this.accountUsageStore
      ? this.buildSwitchStateFromAccountUsage({ group })
      : null;
    // Proactive soft-switch policy must read canonical source-backed account usage only.
    // A provisional switch state (cold PAU, no source-backed records) carries no canonical
    // evidence, so it must not drive eligibility — treat it as source usage unavailable rather
    // than falling back to non-canonical snapshot-derived state.
    const switchState = accountUsageSwitchState?.kind === 'source_backed'
      ? accountUsageSwitchState.state
      : null;
    if (!switchState) {
      return { status: 'unknown', reason: 'source_account_usage_unavailable' };
    }
    const activeProfileId = switchState.activeProfileId;
    // Preemptive burn projection: the poll-driven soft-switch cannot see a session burning from
    // healthy to exhausted inside one ~30-minute poll window. Feed the recent consumption velocity
    // (from the in-band runtime snapshots) so a projected-below-threshold active member triggers the
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
      quotaFreshnessMs: this.quotaLifecycleFreshnessMs,
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

  private buildCurrentGroupGenerationBySessionId(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Map<string, number | null> {
    const generations = new Map<string, number | null>();
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      if (!target.sessionId) continue;
      const selection = readConnectedServiceChildSelectionsFromEnv(target.connectedServiceSelectionsEnv ?? {})
        .find((candidate) => (
          candidate.kind === 'group'
          && candidate.serviceId === input.serviceId
          && candidate.groupId === input.groupId
        )) ?? null;
      generations.set(target.sessionId, selection?.kind === 'group' ? selection.generation : null);
    }
    return generations;
  }

  private hasActiveSpawnTargetForIdentity(entry: RuntimeAccountIdentityEntry): boolean {
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      if (target.sessionId !== entry.sessionId) continue;
      const bindings = extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv);
      return bindings.some((binding) => activeBindingMatchesRuntimeIdentity(binding, entry));
    }
    return false;
  }

  private recordRuntimeAccountIdentitySelections(input: Readonly<{
    sessionId: string;
    bindings: ReadonlyArray<ActiveConnectedServiceBinding>;
    selections: ReadonlyArray<RuntimeAccountIdentitySelection>;
  }>): void {
    for (const selection of input.selections) {
      const matchesActiveBinding = input.bindings.some((binding) => activeBindingMatchesRuntimeIdentity(binding, selection));
      if (!matchesActiveBinding) continue;
      this.recordRuntimeAccountIdentitySelection({
        sessionId: input.sessionId,
        selection,
      });
    }
  }

  private recordRuntimeAccountIdentitySelectionsFromRegistryTargets(): void {
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
      if (!sessionId || !target.runtimeAccountIdentitySelections?.length) continue;
      this.recordRuntimeAccountIdentitySelections({
        sessionId,
        bindings: extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv),
        selections: target.runtimeAccountIdentitySelections,
      });
    }
  }

  private recordRuntimeAccountIdentitySelection(input: Readonly<{
    sessionId: string;
    selection: RuntimeAccountIdentitySelection;
  }>): RuntimeAccountIdentityRecordResult {
    const identity = 'providerAccountId' in input.selection
      ? {
          providerAccountId: input.selection.providerAccountId,
          accountLabel: input.selection.accountLabel,
        }
      : readCredentialAccountIdentity(input.selection.record);
    if (!identity) {
      return { status: 'suppressed', reason: 'missing_provider_account_id' };
    }
    return this.runtimeRegistry.recordRuntimeAccountIdentity({
      sessionId: input.sessionId,
      serviceId: input.selection.serviceId,
      groupId: input.selection.groupId ?? null,
      profileId: input.selection.profileId,
      providerAccountId: identity.providerAccountId,
      accountLabel: identity.accountLabel,
      observedAtMs: this.now(),
      source: input.selection.source,
      proofStrength: 'exact',
      groupGeneration: input.selection.groupGeneration ?? null,
    });
  }

  private resolveUsableSourceProviderAccountId(input: Readonly<{
    identity: RuntimeAccountIdentityEntry | null;
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    currentGroupGeneration: number | null;
  }>): string | null {
    const identity = input.identity;
    if (!identity) return null;
    if (identity.serviceId !== input.serviceId) return null;
    if (identity.groupId !== input.groupId) return null;
    if (identity.profileId !== input.profileId) return null;
    const currentGeneration = normalizeConnectedServiceQuotaGeneration(input.currentGroupGeneration);
    if (
      currentGeneration !== null
      && identity.groupGeneration !== null
      && identity.groupGeneration !== currentGeneration
    ) {
      return null;
    }
    return trimConnectedServiceQuotaString(identity.providerAccountId);
  }

  private async probeSourceProviderAccountIdForFanout(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    currentGroupGeneration: number | null;
  }>): Promise<string | null> {
    if (!this.readRuntimeAccountIdentity) return null;

    let result: RuntimeAccountIdentityProbeResult;
    try {
      result = await this.readRuntimeAccountIdentity({
        sessionId: input.sourceSessionId,
        serviceId: input.serviceId,
        groupId: input.groupId,
        profileId: input.profileId,
        expectedGroupGeneration: input.currentGroupGeneration,
      });
    } catch {
      return null;
    }
    if (result.status !== 'verified' || result.proofStrength !== 'exact') return null;
    const strategy = result.strategy ?? 'provider_account_id';
    if (strategy !== 'provider_account_id') return null;

    const runtimeGroupId = trimConnectedServiceQuotaString(result.groupId);
    if (runtimeGroupId && runtimeGroupId !== input.groupId) return null;
    const runtimeProfileId = trimConnectedServiceQuotaString(result.profileId);
    if (runtimeProfileId && runtimeProfileId !== input.profileId) return null;
    const currentGeneration = normalizeConnectedServiceQuotaGeneration(input.currentGroupGeneration);
    const runtimeGeneration = normalizeConnectedServiceQuotaGeneration(result.groupGeneration);
    if (
      currentGeneration !== null
      && runtimeGeneration !== null
      && runtimeGeneration !== currentGeneration
    ) {
      return null;
    }

    const providerAccountId = trimConnectedServiceQuotaString(result.providerAccountId);
    if (!providerAccountId) return null;
    this.runtimeRegistry.recordRuntimeAccountIdentity({
      sessionId: input.sourceSessionId,
      serviceId: input.serviceId,
      groupId: runtimeGroupId ?? input.groupId,
      profileId: runtimeProfileId ?? input.profileId,
      providerAccountId,
      accountLabel: trimConnectedServiceQuotaString(result.accountLabel),
      observedAtMs: this.now(),
      source: result.source ?? 'runtime_identity_probe',
      proofStrength: 'exact',
      groupGeneration: runtimeGeneration ?? currentGeneration,
    });
    return providerAccountId;
  }

  private mergeSameAccountFanoutCandidates(
    indexedCandidates: ReadonlyArray<RuntimeAccountIdentityEntry | ReconciledRuntimeAccountIdentityEntry>,
    reconciledCandidates: ReadonlyArray<ReconciledRuntimeAccountIdentityEntry>,
  ): Array<RuntimeAccountIdentityEntry | ReconciledRuntimeAccountIdentityEntry> {
    const merged = new Map<string, RuntimeAccountIdentityEntry | ReconciledRuntimeAccountIdentityEntry>();
    for (const candidate of indexedCandidates) {
      merged.set(candidate.sessionId, candidate);
    }
    for (const candidate of reconciledCandidates) {
      merged.set(candidate.sessionId, candidate);
    }
    return Array.from(merged.values()).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  private async reconcileIndexedSameAccountFanoutCandidates(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    providerAccountId: string;
    indexedCandidates: ReadonlyArray<RuntimeAccountIdentityEntry>;
  }>): Promise<Array<RuntimeAccountIdentityEntry | ReconciledRuntimeAccountIdentityEntry>> {
    return await reconcileIndexedSameAccountFanoutCandidates({
      serviceId: input.serviceId,
      groupId: input.groupId,
      providerAccountId: input.providerAccountId,
      indexedCandidates: input.indexedCandidates,
      readRuntimeAccountIdentity: this.readRuntimeAccountIdentity,
      readPersistedSessionAccountIdentity: this.readPersistedSessionAccountIdentity,
      // Capability choke point: broker/shared-group-indirection providers (opencode/pi/claude —
      // `requiresExactRuntimeIdentity: false`) are DAEMON-authoritative; retain them via the indexed
      // identity instead of demanding a live probe their runtime cannot answer. codex still probes.
      resolveCandidateRequiresLiveIdentityProbe: async (candidate) =>
        runtimeAuthApplyRequiresLiveIdentityProbe(await this.resolveRuntimeAuthApplyCapability({
          sourceSessionId: input.sourceSessionId,
          targetSessionId: candidate.sessionId,
          serviceId: input.serviceId,
          groupId: input.groupId,
        })),
      isLiveIdentityProbeUnsupported: (sessionId) => this.liveIdentityProbeUnsupportedSessionIds.has(sessionId),
      markLiveIdentityProbeUnsupported: (sessionId) => { this.liveIdentityProbeUnsupportedSessionIds.add(sessionId); },
      now: this.now,
      recordRuntimeAccountIdentity: (entry) => this.runtimeRegistry.recordRuntimeAccountIdentity(entry),
      invalidateRuntimeAccountIdentity: (sessionId) => this.runtimeRegistry.invalidateRuntimeAccountIdentity(sessionId),
      ...(this.recordDiagnostic ? { recordDiagnostic: this.recordDiagnostic } : {}),
    });
  }

  private listActiveSameAccountFanoutCandidates(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    excludeSessionIds: ReadonlySet<string>;
    currentGroupGenerationBySessionId: ReadonlyMap<string, number | null>;
  }>): ActiveSameAccountFanoutCandidate[] {
    const candidates: ActiveSameAccountFanoutCandidate[] = [];
    const seen = new Set<string>();
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
      if (!sessionId || sessionId === input.sourceSessionId || input.excludeSessionIds.has(sessionId) || seen.has(sessionId)) {
        continue;
      }
      const binding = extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv)
        .find((candidate) => (
          candidate.serviceId === input.serviceId
          && candidate.groupId === input.groupId
        )) ?? null;
      if (!binding) continue;
      seen.add(sessionId);
      candidates.push({
        sessionId,
        serviceId: binding.serviceId,
        groupId: input.groupId,
        profileId: binding.profileId,
        groupGeneration: input.currentGroupGenerationBySessionId.get(sessionId) ?? null,
      });
    }
    return candidates.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  /**
   * Durable cold-path fallback for the `provider_account_id` strategy: when the live runtime-identity
   * probe cannot VERIFY a candidate's account (unavailable/inexact — never a verified mismatch), retain
   * the candidate via its PERSISTED materialization identity if it proves the same failing account and
   * a matching group binding. Re-warms the (cold) runtime identity index so later ticks hit the fast
   * indexed path. Best-effort: a read failure or non-match yields null (candidate stays suppressed).
   */
  private async attemptColdPersistedFanoutFallback(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    providerAccountId: string;
    candidate: ActiveSameAccountFanoutCandidate;
  }>): Promise<RuntimeAccountIdentityEntry | null> {
    if (!this.readPersistedSessionAccountIdentity) return null;
    let identity: Awaited<ReturnType<PersistedSessionAccountIdentityReader>>;
    try {
      identity = await this.readPersistedSessionAccountIdentity({
        sessionId: input.candidate.sessionId,
        serviceId: input.serviceId,
        groupId: input.candidate.groupId,
        profileId: input.candidate.profileId,
        expectedGroupGeneration: input.candidate.groupGeneration,
      });
    } catch {
      return null;
    }
    if (!identity) return null;
    const matched = persistedSessionAccountIdentityMatchesFailingAccount({
      identity,
      serviceId: input.serviceId,
      groupId: input.groupId,
      providerAccountId: input.providerAccountId,
      candidate: {
        serviceId: input.candidate.serviceId,
        groupId: input.candidate.groupId,
        groupGeneration: input.candidate.groupGeneration,
      },
    });
    if (!matched) return null;
    const retained: RuntimeAccountIdentityEntry = {
      sessionId: input.candidate.sessionId,
      serviceId: input.serviceId,
      groupId: input.candidate.groupId,
      profileId: input.candidate.profileId,
      providerAccountId: input.providerAccountId,
      accountLabel: null,
      observedAtMs: this.now(),
      source: 'persisted_materialization_identity',
      proofStrength: 'exact',
      groupGeneration: input.candidate.groupGeneration,
    };
    this.runtimeRegistry.recordRuntimeAccountIdentity(retained);
    this.recordDiagnostic?.({
      event: 'quota_work_deferred',
      phase: 'same_account_fanout',
      reason: 'same_account_fanout_retained_via_persisted_materialization_identity',
      sessionId: input.candidate.sessionId,
      serviceId: input.serviceId,
      groupId: input.groupId,
      expectedProviderAccountId: input.providerAccountId,
      decisionTrace: this.buildSameAccountFanoutDecisionTrace({
        proofSource: 'persisted_materialization_identity',
        sameAccountFanoutStrategy: 'provider_account_id',
        sourceSessionId: input.candidate.sessionId,
        sourceProfileId: input.candidate.profileId,
        expectedGroupGeneration: input.candidate.groupGeneration,
      }),
    });
    return retained;
  }

  private async reconcileColdSameAccountFanoutCandidates(input: Readonly<{
    strategy: ConnectedServiceSameAccountFanoutStrategy;
    sourceSessionId: string;
    sourceProfileId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    providerAccountId: string;
    expectedProviderAccountId: string | null;
    indexedCandidates: ReadonlyArray<RuntimeAccountIdentityEntry | ReconciledRuntimeAccountIdentityEntry>;
    sourceGroupGeneration: number | null;
    currentGroupGenerationBySessionId: ReadonlyMap<string, number | null>;
  }>): Promise<ReconciledColdSameAccountFanoutCandidates> {
    const activeCandidates = this.listActiveSameAccountFanoutCandidates({
      sourceSessionId: input.sourceSessionId,
      serviceId: input.serviceId,
      groupId: input.groupId,
      excludeSessionIds: new Set(input.indexedCandidates.map((candidate) => candidate.sessionId)),
      currentGroupGenerationBySessionId: input.currentGroupGenerationBySessionId,
    });
    if (activeCandidates.length === 0) {
      return { activeCandidateCount: 0, candidates: [] };
    }

    this.recordSameAccountFanoutSuppression({
      reason: 'same_account_fanout_identity_index_cold',
      serviceId: input.serviceId,
      groupId: input.groupId,
      sourceSessionId: input.sourceSessionId,
      sourceProfileId: input.sourceProfileId,
      proofSource: 'runtime_identity_index',
      sameAccountFanoutStrategy: input.strategy,
      expectedProviderAccountId: input.expectedProviderAccountId,
      expectedGroupGeneration: input.sourceGroupGeneration
        ?? input.currentGroupGenerationBySessionId.get(input.sourceSessionId)
        ?? null,
    });

    if (input.strategy === 'shared_group_auth_surface') {
      const sourceGeneration = normalizeConnectedServiceQuotaGeneration(
        input.sourceGroupGeneration
          ?? input.currentGroupGenerationBySessionId.get(input.sourceSessionId)
          ?? null,
      );
      const reconciled: ReconciledRuntimeAccountIdentityEntry[] = [];
      for (const candidate of activeCandidates) {
        const candidateGeneration = normalizeConnectedServiceQuotaGeneration(candidate.groupGeneration);
        if (sourceGeneration === null || candidateGeneration === null) {
          this.recordSameAccountFanoutSuppression({
            reason: 'registry_binding_missing_group_generation',
            serviceId: input.serviceId,
            groupId: input.groupId,
            sourceSessionId: input.sourceSessionId,
            sourceProfileId: input.sourceProfileId,
            proofSource: 'registry_binding',
            sameAccountFanoutStrategy: input.strategy,
            sessionId: candidate.sessionId,
            expectedProviderAccountId: input.expectedProviderAccountId,
            expectedProfileId: candidate.profileId,
            actualProfileId: candidate.profileId,
            expectedGroupId: candidate.groupId,
            actualGroupId: candidate.groupId,
            expectedGroupGeneration: sourceGeneration,
            actualGroupGeneration: candidateGeneration,
          });
          continue;
        }
        if (candidateGeneration !== sourceGeneration) {
          this.recordSameAccountFanoutSuppression({
            reason: 'registry_binding_group_generation_mismatch',
            serviceId: input.serviceId,
            groupId: input.groupId,
            sourceSessionId: input.sourceSessionId,
            sourceProfileId: input.sourceProfileId,
            proofSource: 'registry_binding',
            sameAccountFanoutStrategy: input.strategy,
            sessionId: candidate.sessionId,
            expectedProviderAccountId: input.expectedProviderAccountId,
            expectedProfileId: candidate.profileId,
            actualProfileId: candidate.profileId,
            expectedGroupId: candidate.groupId,
            actualGroupId: candidate.groupId,
            expectedGroupGeneration: sourceGeneration,
            actualGroupGeneration: candidateGeneration,
          });
          continue;
        }
        reconciled.push({
          proofStrategy: 'shared_group_auth_surface',
          sessionId: candidate.sessionId,
          serviceId: candidate.serviceId,
          groupId: candidate.groupId,
          profileId: candidate.profileId,
          accountLabel: null,
          observedAtMs: this.now(),
          source: 'group_switch_selection',
          proofStrength: 'exact',
          groupGeneration: candidateGeneration,
          runtime: {
            safeToApply: true,
            inProviderTurn: false,
          },
        });
      }
      return {
        activeCandidateCount: activeCandidates.length,
        candidates: reconciled,
      };
    }

    if (!this.readRuntimeAccountIdentity) {
      return { activeCandidateCount: activeCandidates.length, candidates: [] };
    }

    const reconciled: ReconciledRuntimeAccountIdentityEntry[] = [];
    for (const candidate of activeCandidates) {
      let result: RuntimeAccountIdentityProbeResult;
      try {
        result = await this.readRuntimeAccountIdentity({
          sessionId: candidate.sessionId,
          serviceId: candidate.serviceId,
          groupId: candidate.groupId,
          profileId: candidate.profileId,
          expectedGroupGeneration: candidate.groupGeneration,
        });
      } catch {
        const fallback = await this.attemptColdPersistedFanoutFallback({
          serviceId: input.serviceId,
          groupId: input.groupId,
          providerAccountId: input.providerAccountId,
          candidate,
        });
        if (fallback) {
          reconciled.push(fallback);
          continue;
        }
        this.recordSameAccountFanoutSuppression({
          reason: 'runtime_identity_probe_missing_exact_identity',
          serviceId: input.serviceId,
          groupId: input.groupId,
          sourceSessionId: input.sourceSessionId,
          sourceProfileId: input.sourceProfileId,
          proofSource: 'runtime_identity_probe',
          ...(this.readPersistedSessionAccountIdentity
            ? { proofSourcesTried: ['runtime_identity_probe', 'persisted_materialization_identity'] as const }
            : {}),
          sameAccountFanoutStrategy: input.strategy,
          sessionId: candidate.sessionId,
          expectedProviderAccountId: input.providerAccountId,
          expectedProfileId: candidate.profileId,
          actualProfileId: candidate.profileId,
          expectedGroupId: candidate.groupId,
          actualGroupId: candidate.groupId,
          expectedGroupGeneration: candidate.groupGeneration,
          actualGroupGeneration: candidate.groupGeneration,
        });
        continue;
      }

      const match = resolveRuntimeAccountIdentityFanoutMatch({
        strategy: input.strategy,
        serviceId: input.serviceId,
        groupId: input.groupId,
        providerAccountId: input.providerAccountId,
        candidate: {
          sessionId: candidate.sessionId,
          serviceId: candidate.serviceId,
          groupId: candidate.groupId,
          profileId: candidate.profileId,
          accountLabel: null,
          groupGeneration: candidate.groupGeneration,
        },
        result,
        observedAtMs: this.now(),
      });
      if (match.status === 'suppressed') {
        // A VERIFIED probe pointing at a genuinely different account is an authoritative veto. Only an
        // unverifiable probe (unavailable/inexact) is eligible for the durable persisted-identity fallback.
        if (result.status !== 'verified') {
          const fallback = await this.attemptColdPersistedFanoutFallback({
            serviceId: input.serviceId,
            groupId: input.groupId,
            providerAccountId: input.providerAccountId,
            candidate,
          });
          if (fallback) {
            reconciled.push(fallback);
            continue;
          }
        }
        this.recordSameAccountFanoutSuppression({
          reason: match.reason,
          serviceId: input.serviceId,
          groupId: input.groupId,
          sourceSessionId: input.sourceSessionId,
          sourceProfileId: input.sourceProfileId,
          proofSource: 'runtime_identity_probe',
          ...(this.readPersistedSessionAccountIdentity && result.status !== 'verified'
            ? { proofSourcesTried: ['runtime_identity_probe', 'persisted_materialization_identity'] as const }
            : {}),
          sameAccountFanoutStrategy: input.strategy,
          ...match.diagnostic,
        });
        continue;
      }
      if (match.staleExpectedStateReconciled) {
        this.recordDiagnostic?.({
          event: 'quota_work_suppressed',
          phase: 'same_account_fanout',
          reason: 'runtime_identity_probe_stale_expected_state_reconciled',
        });
      }
      if (input.strategy === 'provider_account_id' && 'providerAccountId' in match.entry) {
        this.runtimeRegistry.recordRuntimeAccountIdentity(match.entry);
      }
      reconciled.push(match.entry);
    }
    return {
      activeCandidateCount: activeCandidates.length,
      candidates: reconciled,
    };
  }

  private buildQuotaPersistenceKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Readonly<{ key: string; diagnostics: Record<string, string> }> {
    this.refreshQuotaPersistenceAccountScope();
    return buildQuotaPersistenceKey({
      serverScope: this.quotaPersistenceServerScope,
      accountScope: this.quotaPersistenceAccountScope,
      serviceId: input.serviceId,
      profileId: input.profileId,
    });
  }

  private deriveQuotaFingerprintHmacKey(): Uint8Array {
    return deriveQuotaSnapshotFingerprintHmacKey({
      keyMaterial: this.quotaFingerprintKeyMaterial,
      serverScope: this.quotaPersistenceServerScope,
      accountScope: this.quotaPersistenceAccountScope.kind === 'known'
        ? this.quotaPersistenceAccountScope.value
        : 'unknown-account',
    });
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
    this.quotaFingerprintHmacKey = this.deriveQuotaFingerprintHmacKey();
  }

  private computeQuotaMaterialFingerprint(snapshot: ConnectedServiceQuotaSnapshotV1): string {
    this.refreshQuotaPersistenceAccountScope();
    return computeQuotaSnapshotFingerprint(snapshot, this.quotaFingerprintHmacKey);
  }

  private shouldRetryQuotaPersistence(error: unknown): boolean {
    if (error instanceof UnknownAccountModeQuotaPersistenceError) return false;
    if (error instanceof DaemonServerWorkQuotaPersistenceError) {
      if (error.outcome.status === 'deferred') return true;
      if (error.outcome.status !== 'failed') return false;
      return error.outcome.classification.retryable;
    }
    return classifyDaemonServerWorkError(error).retryable;
  }

  private async flushInBandQuotaPersistencePayload(payload: InBandQuotaPersistencePayload): Promise<void> {
    await this.persistQuotaSnapshotWithServerWork({
      serviceId: payload.serviceId,
      profileId: payload.profileId,
      snapshot: payload.snapshot,
      materialFingerprint: payload.materialFingerprint,
    });

    this.persistedInBandQuotaStateByKey.set(this.buildQuotaPersistenceKey(payload).key, {
      snapshot: payload.snapshot,
      fingerprint: payload.materialFingerprint,
      status: payload.status,
      fetchedAt: payload.snapshot.fetchedAt,
    });
  }

  private async persistQuotaSnapshotWithServerWork(input: Readonly<{
    accountMode?: 'e2ee' | 'plain';
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    materialFingerprint?: string;
    sourceProviderAccountId?: string | null;
  }>): Promise<void> {
    const run = async (payload: typeof input): Promise<void> => {
      const accountMode = payload.accountMode ?? await resolveConnectedServiceAccountMode(this.api, { refresh: true });
      if (accountMode === 'unknown') {
        invalidateConnectedServiceAccountMode(this.api);
        throw new UnknownAccountModeQuotaPersistenceError();
      }
      await this.persistQuotaSnapshot({
        ...payload,
        accountMode,
      });
    };

    if (this.quotaPersistenceServerWorkScheduler) {
      const outcome = await this.quotaPersistenceServerWorkScheduler.enqueue({
        purpose: 'connectedServiceQuotaPersistence',
        kind: 'latestStateWrite',
        key: this.buildQuotaPersistenceKey(input).key,
        payload: input,
        payloadBytes: JSON.stringify(input.snapshot).length,
        run,
      });
      if (outcome.status !== 'written') throw new DaemonServerWorkQuotaPersistenceError(outcome);
      return;
    }

    await run(input);
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
      ?? computeProviderAccountUsageSnapshotFingerprint(providerAccountUsageSnapshot, this.quotaFingerprintHmacKey);
    const canPersistSourceLink = canRecordProviderAccountUsageSourceLinks({
      snapshot: providerAccountUsageSnapshot,
      sourceProviderAccountId: input.sourceProviderAccountId,
    });
    if (input.accountMode === 'plain') {
      if (typeof this.api.registerProviderAccountUsageSnapshotPlain !== 'function') {
        throw new Error('Provider account usage plaintext persistence route unavailable');
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
    const sealed = sealProviderAccountUsageSnapshotCiphertext({
      material,
      payload: providerAccountUsageSnapshot,
      randomBytes: this.randomBytes,
    });
    if (typeof this.api.registerProviderAccountUsageSnapshotSealed !== 'function') {
      throw new Error('Provider account usage sealed persistence route unavailable');
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

  private recordPersistedInBandQuotaStateFromExisting(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    existing: ExistingQuotaSnapshotResponse;
  }>): void {
    const metadata = input.existing?.metadata;
    const status = metadata?.status ?? deriveQuotaSnapshotStatus(input.snapshot);
    const fetchedAt = readFiniteNonNegativeMs(metadata?.fetchedAt) ?? input.snapshot.fetchedAt;
    const materialFingerprint = typeof metadata?.materialFingerprint === 'string' && metadata.materialFingerprint.trim()
      ? metadata.materialFingerprint
      : this.computeQuotaMaterialFingerprint(input.snapshot);
    const refreshRequestedAt = readFiniteNonNegativeMs(metadata?.refreshRequestedAt);
    this.persistedInBandQuotaStateByKey.set(this.buildQuotaPersistenceKey(input).key, {
      snapshot: input.snapshot,
      fingerprint: materialFingerprint,
      status,
      fetchedAt,
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

  private async recordFetchedQuotaSnapshotAsAccountUsage(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    now: number;
    accountMode?: ResolvedQuotaStorageMode | null;
    sourceProviderAccountId?: string | null;
    groupId?: string | null;
    groupContexts?: ReadonlyArray<ConnectedServiceQuotaGroupContext> | null;
    groupTargets?: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | null;
    persistDurably?: boolean;
  }>): Promise<ProviderAccountUsageSnapshotV1 | null> {
    return await recordFetchedQuotaSnapshotAsAccountUsage({
      accountUsageStore: this.accountUsageStore,
      accountUsagePersistence: this.accountUsagePersistence,
      quotaFingerprintHmacKey: this.quotaFingerprintHmacKey,
      persistQuotaSnapshotWithServerWork: (payload) => this.persistQuotaSnapshotWithServerWork(payload),
      handleAccountUsageChanged: (payload) => this.handleAccountUsageChanged(payload),
    }, input);
  }

  private makeQuotaLifecycleGroupKey(input: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>): string {
    return `${input.serviceId}\u0000${input.groupId.trim()}`;
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
      group: input.group,
      accountUsageStore: this.accountUsageStore,
      changedProfileId: input.changedProfileId,
      changedSnapshot: input.changedSnapshot,
      changedGroupGeneration: normalizeConnectedServiceQuotaGeneration(input.changedGroupGeneration),
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
      changedGroupGeneration: input.changedGroupGeneration,
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

  private async maybeClearStaleMemberLimitersForGroupQuotaSnapshot(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    now: number;
    signal?: AbortSignal;
  }>): Promise<void> {
    if (!this.runtimeQuotaSnapshots) return;
    if (typeof this.api.getConnectedServiceAuthGroup !== 'function') return;

    const group = await this.api.getConnectedServiceAuthGroup({
      serviceId: input.serviceId,
      groupId: input.groupId,
      signal: input.signal,
    }).catch(() => null);
    if (!group) return;
    if (input.signal?.aborted) return;

    const reconciledGroup = await this.clearStaleMemberLimitersWithFreshEvidence({ group, ...input });
    await this.evaluateGroupQuotaLifecycle({
      group: reconciledGroup ?? group,
      changedProfileId: input.profileId,
      now: input.now,
    });
  }

  private async clearStaleMemberLimitersWithFreshEvidence(input: Readonly<{
    group: ConnectedServiceAuthGroupV1;
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    now: number;
  }>): Promise<ConnectedServiceAuthGroupV1 | null> {
    if (!this.runtimeQuotaSnapshots) return null;
    if (typeof this.api.updateConnectedServiceAuthGroupRuntimeState !== 'function') return null;

    const runtimeState = this.runtimeQuotaSnapshots.buildMemberStates({
      serviceId: input.serviceId,
      groupId: input.groupId,
      capturedAtMs: input.now,
    }).get(input.profileId) ?? null;
    const quotaSnapshot = runtimeState?.quotaSnapshot ?? null;
    if (!quotaSnapshot) return null;

    let group = input.group;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const member = group.members.find((candidate) => candidate.profileId === input.profileId) ?? null;
      if (!member) return null;
      const reconciledState = reconcileMemberRuntimeStateWithFreshQuotaEvidence({
        state: member.state as ConnectedServiceAuthGroupMemberRuntimeState,
        quotaSnapshot,
        policy: normalizeConnectedServiceAuthGroupPolicy(group.policy),
        nowMs: input.now,
      });
      if (!reconciledState || reconciledState === member.state) return null;
      try {
        return await this.api.updateConnectedServiceAuthGroupRuntimeState({
          serviceId: input.serviceId,
          groupId: input.groupId,
          expectedGeneration: group.generation,
          expectedRuntimeStateRevision: group.runtimeStateRevision,
          memberStates: [{
            profileId: input.profileId,
            state: reconciledState,
          }],
        });
      } catch (error) {
        if (!(error instanceof ConnectedServiceAuthGroupRuntimeStateRevisionConflictError) || attempt === 1) return null;
        const latest = await this.api.getConnectedServiceAuthGroup?.({
          serviceId: input.serviceId,
          groupId: input.groupId,
        }).catch(() => null);
        if (!latest || latest.generation !== group.generation) return null;
        group = latest;
      }
    }
    return null;
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

  /**
   * RD-QUO-13: edge-triggered group quota lifecycle (blocked/recovered) producer hook.
   *
   * Runs the same eligibility pass the switch coordinator uses (`allowCurrentProfileRetry`
   * so the active member counts when eligible). `no_eligible_members` with live group-bound
   * sessions emits `blocked` once; a later pass that frees any member emits `recovered`
   * once. Manual-strategy groups are user-driven and never emit.
   */
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

  private makeGroupSwitchCheckKey(input: ActiveGroupQuotaSwitchTarget): string {
    return `${input.serviceId}\u0000${input.groupId}`;
  }

  private collectActiveGroupTargetsForBinding(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): ActiveGroupQuotaSwitchTarget[] {
    const out: ActiveGroupQuotaSwitchTarget[] = [];
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
      if (!sessionId) continue;
      const bindings: ReadonlyArray<ActiveConnectedServiceBinding> = target.activeBindings.length > 0
        ? target.activeBindings.map((binding) => ({
          serviceId: binding.serviceId,
          profileId: binding.profileId,
          ...(binding.groupId ? { groupId: binding.groupId } : {}),
          groupGeneration: binding.generation,
        }))
        : extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv);
      for (const entry of bindings) {
        const groupId = typeof entry.groupId === 'string' ? entry.groupId.trim() : '';
        if (
          entry.serviceId !== input.serviceId
          || entry.profileId !== input.profileId
          || !groupId
        ) {
          continue;
        }
        out.push({
          sessionId,
          serviceId: entry.serviceId,
          groupId,
          activeProfileId: entry.profileId,
          groupGeneration: entry.groupGeneration ?? null,
        });
      }
    }
    return out;
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

  private async shouldRunSoftSwitchForTarget(target: ActiveGroupQuotaSwitchTarget): Promise<boolean> {
    const policyGuard = this.softSwitchPolicyGuard;
    if (policyGuard) {
      let policyResult: SoftSwitchPolicyGuardResult;
      try {
        policyResult = await policyGuard({
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
          reason: 'quota_soft_switch_policy_guard_failed',
        });
        return false;
      }
      if (policyResult.status !== 'allow') {
        this.recordDiagnostic?.({
          event: 'quota_work_suppressed',
          phase: 'soft_switch',
          reason: policyResult.reason.trim() || 'quota_soft_switch_suppressed_policy_guard',
        });
        return false;
      }
    }

    return true;
  }

  private async persistCredentialHealthForQuotaFailure(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    error: unknown;
    now: number;
  }>): Promise<ConnectedServiceCredentialHealthV1['status'] | null> {
    if (!isQuotaAuthFailure(input.error)) return null;
    const updateHealth = this.api.updateConnectedServiceCredentialHealth;
    if (typeof updateHealth !== 'function') return null;
    const bindingKey = this.makeBindingKey({ serviceId: input.serviceId, profileId: input.profileId });
    const consecutiveFailures = Math.max(
      1,
      Math.trunc(this.failureStateByBindingKey.get(bindingKey)?.consecutiveFailures ?? 0) + 1,
    );
    const health = buildQuotaAuthFailureCredentialHealth(input.error, input.now, {
      consecutiveFailuresBeforeCurrent: this.failureStateByBindingKey.get(bindingKey)?.consecutiveFailures ?? 0,
    });
    if (shouldProbeCredentialRefreshForQuotaFailure(input.error, { consecutiveFailures })) {
      const probe = await this.refreshConnectedServiceCredentialForQuota?.({
        serviceId: input.serviceId,
        profileId: input.profileId,
        force: true,
        reason: 'auth_failure',
      }).catch(() => null);
      if (probe?.reauthRequired === true) {
        // The refresh coordinator (canonical owner of refresh-failure health) proved this
        // credential needs reconnection — permanent provider auth failure (e.g. 401
        // refresh_token_invalidated) or an existing needs_reauth latch — and already persisted
        // that health with the provider error code. Do NOT overwrite the latch with a retryable
        // status: that clobber kept dead accounts in the proactive probe rotation forever
        // (codex4 quota_bridge retry storm, 2026-07-09).
        return 'needs_reauth';
      }
      if (probe?.record) {
        // The refresh owner already persisted connected health for the newly
        // committed revision. The quota failure belongs to the predecessor
        // credential and must not overwrite that successful refresh result.
        return 'connected';
      }
    }
    await updateHealth.call(this.api, {
      serviceId: input.serviceId,
      profileId: input.profileId,
      ...(input.expectedCredentialRevision
        ? { expectedCredentialRevision: input.expectedCredentialRevision }
        : {}),
      health,
    });
    return health.status;
  }

  private async maybeRequestActiveGroupSwitchForSnapshot(input: Readonly<{
    now: number;
    targets: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | undefined;
  }>): Promise<void> {
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
      const targetEligibility = await this.resolveGroupSwitchTargetEligibility({
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
    signal?: AbortSignal;
  }>): Promise<ConnectedServiceAuthGroupV1 | null> {
    if (typeof this.api.getConnectedServiceAuthGroup !== 'function') return null;
    const group = await this.api.getConnectedServiceAuthGroup({
      serviceId: input.serviceId,
      groupId: input.groupId,
      signal: input.signal,
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

  public scheduleCurrentSourceRefresh(
    sources: readonly ConnectedServiceUsageSourceV1[],
  ): Readonly<{ accepted: number; ignored: number }> {
    let accepted = 0;
    let ignored = 0;
    for (const candidate of sources) {
      const parsed = ConnectedServiceUsageSourceV1Schema.safeParse(candidate);
      if (!parsed.success || !this.quotaFetchersByServiceId.has(parsed.data.serviceId)) {
        ignored += 1;
        continue;
      }
      const key = buildConnectedServiceUsageSourceKey(parsed.data);
      if (
        this.startupCurrentSourceRefreshByKey.has(key)
        || this.startupCurrentSourceRefreshByKey.size
          >= ConnectedServiceQuotasCoordinator.MAX_STARTUP_CURRENT_SOURCE_REFRESHES
      ) {
        ignored += 1;
        continue;
      }
      this.startupCurrentSourceRefreshByKey.set(key, parsed.data);
      accepted += 1;
    }
    return { accepted, ignored };
  }

  private listScheduledCurrentSourceRefreshesForBinding(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): ConnectedServiceUsageSourceV1[] {
    return [...this.startupCurrentSourceRefreshByKey.values()].filter((source) => (
      source.serviceId === input.serviceId && source.profileId === input.profileId
    ));
  }

  private clearScheduledCurrentSourceRefreshesForBinding(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): void {
    for (const [key, source] of this.startupCurrentSourceRefreshByKey.entries()) {
      if (source.serviceId === input.serviceId && source.profileId === input.profileId) {
        this.startupCurrentSourceRefreshByKey.delete(key);
      }
    }
  }

  public async probeGroupQuotaSnapshots(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileIds: ReadonlyArray<string>;
    deadlineAtMs?: number;
  }>): Promise<ConnectedServiceGroupQuotaProbeResult> {
    const startedAtMs = Date.now();
    const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
    const groupId = String(input.groupId ?? '').trim();
    const profileIds = Array.from(new Set(input.profileIds
      .map((profileId) => String(profileId ?? '').trim())
      .filter((profileId) => profileId.length > 0)));
    const completedProfileIds: string[] = [];
    const deadlineAtMs = typeof input.deadlineAtMs === 'number' && Number.isFinite(input.deadlineAtMs)
      ? Math.max(0, Math.trunc(input.deadlineAtMs))
      : null;
    const deadlineController = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    if (deadlineAtMs !== null) {
      const remainingMs = Math.max(0, deadlineAtMs - Date.now());
      if (remainingMs === 0) deadlineController.abort('quota-probe-deadline');
      else {
        deadlineTimer = setTimeout(() => deadlineController.abort('quota-probe-deadline'), remainingMs);
        (deadlineTimer as unknown as { unref?: () => void }).unref?.();
      }
    }
    const deadlineExceeded = (): boolean => deadlineController.signal.aborted
      || (deadlineAtMs !== null && Date.now() >= deadlineAtMs);
    const result = (
      status: ConnectedServiceGroupQuotaProbeResult['status'],
      reason?: ConnectedServiceGroupQuotaProbeResult['reason'],
    ): ConnectedServiceGroupQuotaProbeResult => ({
      status,
      requestedProfileCount: profileIds.length,
      completedProfileCount: completedProfileIds.length,
      completedProfileIds: [...completedProfileIds],
      ...(reason ? { reason } : {}),
    });
    let outcome: ConnectedServiceGroupQuotaProbeResult = result('complete');
    try {
      if (!groupId || profileIds.length === 0) return outcome;
      if (this.checkQuotaWorkGate('probe_group').status !== 'open' || !this.runtimeQuotaSnapshots) {
        outcome = result('incomplete', 'probe_unavailable');
        return outcome;
      }
      const fetcher = this.quotaFetchersByServiceId.get(serviceId);
      if (!fetcher) {
        outcome = result('incomplete', 'probe_unavailable');
        return outcome;
      }
      if (deadlineExceeded()) {
        outcome = result('incomplete', 'deadline_exceeded');
        return outcome;
      }

      const accountMode = deadlineAtMs !== null
        ? await this.api.getAccountEncryptionModeUncached?.({ signal: deadlineController.signal }) ?? 'unknown'
        : await resolveConnectedServiceAccountMode(this.api);
      if (deadlineExceeded()) {
        outcome = result('incomplete', 'deadline_exceeded');
        return outcome;
      }
      if (deadlineAtMs !== null && typeof this.api.getAccountEncryptionModeUncached !== 'function') {
        outcome = result('incomplete', 'probe_unavailable');
        return outcome;
      }
      const encryption = this.credentials.encryption;
      const material = encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });
      const now = Math.max(0, Math.trunc(this.now()));
      const group = await this.readCurrentQuotaGroupForContext({
        serviceId,
        groupId,
        signal: deadlineAtMs === null ? undefined : deadlineController.signal,
      });
      if (deadlineExceeded()) {
        outcome = result('incomplete', 'deadline_exceeded');
        return outcome;
      }

      for (const profileId of profileIds) {
        if (deadlineExceeded()) {
          outcome = result('incomplete', 'deadline_exceeded');
          return outcome;
        }
        let expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
        try {
          // Lease acquisition is a mutation. Do not start it after expiry and always await it once started.
          const lease = await this.acquireQuotaFetchLease({
            serviceId,
            profileId,
            signal: deadlineAtMs === null ? undefined : deadlineController.signal,
          });
          if (deadlineExceeded()) {
            outcome = result('incomplete', 'deadline_exceeded');
            return outcome;
          }
          if (lease.type === 'contended') {
            const observedSnapshot = await this.waitForContendedQuotaFetch({
              accountMode,
              material,
              serviceId,
              profileId,
              fetcher,
              now,
              leaseUntil: lease.leaseUntil,
              signal: deadlineAtMs === null ? undefined : deadlineController.signal,
            });
            if (deadlineExceeded()) {
              outcome = result('incomplete', 'deadline_exceeded');
              return outcome;
            }
            if (observedSnapshot) {
              this.runtimeQuotaSnapshots.recordSnapshot({
                serviceId,
                groupId,
                profileId,
                groupGeneration: group?.generation ?? null,
                snapshot: observedSnapshot,
              });
              if (deadlineExceeded()) {
                outcome = result('incomplete', 'deadline_exceeded');
                return outcome;
              }
              await this.recordFetchedQuotaSnapshotAsAccountUsage({
                serviceId,
                profileId,
                accountMode: accountMode === 'plain' || accountMode === 'e2ee' ? accountMode : null,
                groupId,
                groupContexts: this.buildQuotaGroupContextsForProfile({ group, profileId }),
                snapshot: observedSnapshot,
                now,
              });
              if (deadlineExceeded()) {
                outcome = result('incomplete', 'deadline_exceeded');
                return outcome;
              }
              await this.maybeClearStaleMemberLimitersForGroupQuotaSnapshot({
                serviceId,
                groupId,
                profileId,
                now,
                signal: deadlineAtMs === null ? undefined : deadlineController.signal,
              });
              if (deadlineExceeded()) {
                outcome = result('incomplete', 'deadline_exceeded');
                return outcome;
              }
            }
            completedProfileIds.push(profileId);
            continue;
          }

          const credential = await this.readCredentialForQuota({
            accountMode,
            material,
            serviceId,
            profileId,
            signal: deadlineAtMs === null ? undefined : deadlineController.signal,
          });
          expectedCredentialRevision = credential.credentialRevision;
          if (deadlineExceeded()) {
            outcome = result('incomplete', 'deadline_exceeded');
            return outcome;
          }
          if (!credential.record) {
            completedProfileIds.push(profileId);
            continue;
          }
          const raced = await this.fetchQuotaSnapshot({
            fetcher,
            serviceId,
            profileId,
            record: credential.record,
            now,
            signal: deadlineAtMs === null ? undefined : deadlineController.signal,
          });
          if (deadlineExceeded()) {
            outcome = result('incomplete', 'deadline_exceeded');
            return outcome;
          }
          if (raced.type === 'timeout' || !raced.snapshot) {
            completedProfileIds.push(profileId);
            continue;
          }
          const snapshot = raced.snapshot;
          this.runtimeQuotaSnapshots.recordSnapshot({
            serviceId,
            groupId,
            profileId,
            groupGeneration: group?.generation ?? null,
            snapshot,
          });
          if (deadlineExceeded()) {
            outcome = result('incomplete', 'deadline_exceeded');
            return outcome;
          }
          await this.recordFetchedQuotaSnapshotAsAccountUsage({
            serviceId,
            profileId,
            accountMode: credential.storageMode,
            sourceProviderAccountId: readCredentialAccountIdentity(credential.record)?.providerAccountId ?? null,
            groupId,
            groupContexts: this.buildQuotaGroupContextsForProfile({ group, profileId }),
            snapshot,
            now,
          });
          if (deadlineExceeded()) {
            outcome = result('incomplete', 'deadline_exceeded');
            return outcome;
          }
          await this.maybeClearStaleMemberLimitersForGroupQuotaSnapshot({
            serviceId,
            groupId,
            profileId,
            now,
            signal: deadlineAtMs === null ? undefined : deadlineController.signal,
          });
          if (deadlineExceeded()) {
            outcome = result('incomplete', 'deadline_exceeded');
            return outcome;
          }
          completedProfileIds.push(profileId);
        } catch (error) {
          if (deadlineExceeded()) {
            outcome = result('incomplete', 'deadline_exceeded');
            return outcome;
          }
          await this.persistCredentialHealthForQuotaFailure({
            serviceId,
            profileId,
            expectedCredentialRevision,
            error,
            now,
          }).catch(() => false);
          const key = this.makeBindingKey({ serviceId, profileId });
          this.applyFailureBackoff({
            now,
            key,
            retryAfterMs: readQuotaRetryAfterMs(error),
            retryAfterBackoffMinMs: fetcher.pollPolicy?.retryAfterBackoffMinMs,
          });
          completedProfileIds.push(profileId);
        }
      }
      outcome = result('complete');
      return outcome;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.recordDiagnostic?.({
        event: 'quota_work_requested',
        phase: 'probe_group',
        reason: outcome.status === 'complete' ? 'complete' : outcome.reason ?? 'incomplete',
        serviceId,
        groupId,
        targetCount: profileIds.length,
        completedTargetCount: outcome.completedProfileCount,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        probeOutcome: outcome.status,
      });
    }
  }

  private openExistingQuotaSnapshot(input: Readonly<{
    storageMode: ResolvedQuotaStorageMode;
    material: Parameters<typeof openConnectedServiceQuotaSnapshotCiphertext>[0]['material'];
    serviceId: ConnectedServiceId;
    profileId: string;
    existing: ExistingQuotaSnapshotResponse;
  }>): ConnectedServiceQuotaSnapshotV1 | null {
    if (input.storageMode === 'plain') {
      const plain = input.existing as Awaited<ReturnType<NonNullable<QuotaApi['getConnectedServiceQuotaSnapshotPlain']>>>;
      return plain?.content?.t === 'plain' ? plain.content.v : null;
    }
    const sealed = input.existing as Awaited<ReturnType<QuotaApi['getConnectedServiceQuotaSnapshotSealed']>>;
    if (!sealed?.sealed?.ciphertext) return null;
    try {
      const opened = openConnectedServiceQuotaSnapshotCiphertext({
        material: input.material,
        ciphertext: sealed.sealed.ciphertext,
      });
      if (opened?.value) {
        return (opened.value as ConnectedServiceQuotaSnapshotV1 | null | undefined) ?? null;
      }
    } catch {
      // Source-backed quota routes may now return provider-account usage ciphertext.
    }

    let providerOpened: ReturnType<typeof openProviderAccountUsageSnapshotCiphertext> | null = null;
    try {
      providerOpened = openProviderAccountUsageSnapshotCiphertext({
        material: input.material,
        ciphertext: sealed.sealed.ciphertext,
      });
    } catch {
      providerOpened = null;
    }
    if (!providerOpened?.value) return null;
    return projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
      snapshot: providerOpened.value as ProviderAccountUsageSnapshotV1,
      source: {
        serviceId: input.serviceId,
        profileId: input.profileId,
        bindingKind: 'profile',
      },
    });
  }

  private async readExistingQuotaSnapshot(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }>): Promise<ResolvedExistingQuotaSnapshot> {
    if (input.accountMode !== 'e2ee' && typeof this.api.getConnectedServiceQuotaSnapshotPlain === 'function') {
      const plain = await this.api.getConnectedServiceQuotaSnapshotPlain({
        serviceId: input.serviceId,
        profileId: input.profileId,
        signal: input.signal,
      });
      if (plain) {
        return { storageMode: 'plain', existing: plain };
      }
      if (input.accountMode === 'plain') {
        return { storageMode: 'plain', existing: null };
      }
    }

    return {
      storageMode: 'e2ee',
      existing: await this.api.getConnectedServiceQuotaSnapshotSealed({
        serviceId: input.serviceId,
        profileId: input.profileId,
        signal: input.signal,
      }),
    };
  }

  private async readCredentialForQuota(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    material: Parameters<typeof openConnectedServiceQuotaSnapshotCiphertext>[0]['material'];
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    storageMode: ResolvedQuotaStorageMode;
    record: ConnectedServiceCredentialRecordV1 | null;
    credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  }>> {
    if (input.accountMode !== 'e2ee' && typeof this.api.getConnectedServiceCredentialPlain === 'function') {
      const plain = await this.api.getConnectedServiceCredentialPlain({
        serviceId: input.serviceId,
        profileId: input.profileId,
        signal: input.signal,
      }).catch(() => null);
      const record = plain?.content?.t === 'plain' ? plain.content.v : null;
      if (plain && record) {
        const revision = readConnectedServiceCredentialRevisionBoundaryV1(plain);
        return {
          storageMode: 'plain',
          credentialRevision: revision?.revisionSemantics === 'revisioned' ? revision.credentialRevision : null,
          record: assertConnectedServiceCredentialRecordBinding({
            binding: input,
            record: ConnectedServiceCredentialRecordV1Schema.parse(record),
          }),
        };
      }
      if (input.accountMode === 'plain') {
        return { storageMode: 'plain', record: null, credentialRevision: null };
      }
    }

    const sealed = await this.api.getConnectedServiceCredentialSealed({
      serviceId: input.serviceId,
      profileId: input.profileId,
      signal: input.signal,
    });
    if (!sealed?.sealed?.ciphertext) {
      return { storageMode: 'e2ee', record: null, credentialRevision: null };
    }
    const opened = openConnectedServiceCredentialCiphertext({
      material: input.material,
      ciphertext: sealed.sealed.ciphertext,
    });
    const revision = readConnectedServiceCredentialRevisionBoundaryV1(sealed);
    return {
      storageMode: 'e2ee',
      credentialRevision: revision?.revisionSemantics === 'revisioned' ? revision.credentialRevision : null,
      record: opened?.value
        ? assertConnectedServiceCredentialRecordBinding({
            binding: input,
            record: ConnectedServiceCredentialRecordV1Schema.parse(opened.value),
          })
        : null,
    };
  }

  private isExistingQuotaSnapshotFresh(input: Readonly<{
    existing: ExistingQuotaSnapshotResponse;
    now: number;
    fetcher: ConnectedServiceQuotaFetcher;
    forcedRefresh: boolean;
  }>): boolean {
    if (!input.existing?.metadata) return false;
    const fetchedAt = Number(input.existing.metadata.fetchedAt ?? 0);
    const staleAfterMs = Number(input.existing.metadata.staleAfterMs ?? 0);
    if (!Number.isFinite(fetchedAt) || !Number.isFinite(staleAfterMs) || fetchedAt <= 0 || staleAfterMs <= 0) return false;
    const policyMinPollIntervalMs = readFiniteNonNegativeMs(input.fetcher.pollPolicy?.minPollIntervalMs) ?? 0;
    const effectiveStaleAfterMs = Math.max(staleAfterMs, policyMinPollIntervalMs);
    return !input.forcedRefresh && input.now < fetchedAt + effectiveStaleAfterMs;
  }

  private shouldForceQuotaRefresh(existing: ExistingQuotaSnapshotResponse): boolean {
    const fetchedAt = Number(existing?.metadata?.fetchedAt ?? 0);
    const refreshRequestedAt = Number(existing?.metadata?.refreshRequestedAt ?? 0);
    return Number.isFinite(refreshRequestedAt) && refreshRequestedAt > 0 && refreshRequestedAt > fetchedAt;
  }

  private async acquireQuotaFetchLease(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ type: 'acquired' } | { type: 'contended'; leaseUntil: number }>> {
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
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (lease.acquired) return { type: 'acquired' };
    return { type: 'contended', leaseUntil: Number(lease.leaseUntil ?? 0) };
  }

  private async waitForContendedQuotaFetch(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    material: Parameters<typeof openConnectedServiceQuotaSnapshotCiphertext>[0]['material'];
    serviceId: ConnectedServiceId;
    profileId: string;
    fetcher: ConnectedServiceQuotaFetcher;
    now: number;
    leaseUntil: number;
    signal?: AbortSignal;
  }>): Promise<ConnectedServiceQuotaSnapshotV1 | null> {
    const maxWaitMs = this.quotaFetchLeaseContentionWaitMaxMs;
    if (maxWaitMs > 0) {
      const waitMs = Math.min(maxWaitMs, Math.max(0, Math.trunc(input.leaseUntil - input.now)));
    if (waitMs > 0) {
      if (input.signal) {
        let resolveAbort!: () => void;
        const abortPromise = new Promise<void>((resolve) => { resolveAbort = resolve; });
        if (input.signal.aborted) resolveAbort();
        else input.signal.addEventListener('abort', resolveAbort, { once: true });
        try {
          await Promise.race([this.sleepMs(waitMs), abortPromise]);
        } finally {
          input.signal.removeEventListener('abort', resolveAbort);
        }
      } else {
        await this.sleepMs(waitMs);
      }
    }
    }
    const observed = await this.readExistingQuotaSnapshot(input).catch(() => null);
    if (!this.isExistingQuotaSnapshotFresh({
      existing: observed?.existing ?? null,
      now: this.now(),
      fetcher: input.fetcher,
      forcedRefresh: this.shouldForceQuotaRefresh(observed?.existing ?? null),
    })) {
      return null;
    }
    if (!observed) return null;
    return this.openExistingQuotaSnapshot({
      storageMode: observed.storageMode,
      material: input.material,
      serviceId: input.serviceId,
      profileId: input.profileId,
      existing: observed.existing,
    });
  }

  private async runFetcherWithTimeout(input: Readonly<{
    fetcher: ConnectedServiceQuotaFetcher;
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    signal?: AbortSignal;
  }>): Promise<
    | Readonly<{ type: 'timeout' }>
    | Readonly<{ type: 'result'; snapshot: ConnectedServiceQuotaSnapshotV1 | null }>
  > {
    const controller = new AbortController();
    const timeoutMs = this.fetchTimeoutMs;
    const abortFromCaller = (): void => controller.abort('quota-probe-deadline');
    if (input.signal?.aborted) abortFromCaller();
    else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const fetchPromise = input.fetcher.fetch({
      record: buildCredentialRecordForQuotaFetcher(input.record),
      now: input.now,
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

    let resolveCallerAbort!: () => void;
    const callerAbortPromise = new Promise<{ type: 'timeout' }>((resolve) => {
      resolveCallerAbort = () => resolve({ type: 'timeout' });
    });
    const settleCallerAbort = (): void => resolveCallerAbort();
    if (input.signal?.aborted) settleCallerAbort();
    else input.signal?.addEventListener('abort', settleCallerAbort, { once: true });
    const raced = await Promise.race([
      fetchPromise.then(
        (snapshot) => ({ type: 'result' as const, snapshot }),
        (error) => ({ type: 'error' as const, error }),
      ),
      timeoutPromise,
      ...(input.signal ? [callerAbortPromise] : []),
    ]);

    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = null;
    input.signal?.removeEventListener('abort', abortFromCaller);
    input.signal?.removeEventListener('abort', settleCallerAbort);

    if (raced.type === 'timeout') {
      if (input.signal) {
        // Deadline-owned pre-spawn probes never detach a provider read. Every registered production
        // fetcher forwards AbortSignal to fetch (or settles synchronously), so abort and observe its
        // terminal result before reporting the aggregate probe incomplete.
        controller.abort('quota-probe-deadline');
        await fetchPromise.catch(() => null);
      }
      return raced;
    }
    if (raced.type === 'error') throw raced.error;
    return raced;
  }

  private async runRecoveryCreditConsumerWithTimeout(input: Readonly<{
    fetcher: ConnectedServiceQuotaFetcher;
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    idempotencyKey: string;
    providerCreditId?: string;
  }>): Promise<Readonly<
    { type: 'timeout' }
    | { type: 'result'; outcome: Exclude<ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1['status'], 'unknown_after_timeout'> }
  >> {
    if (!input.fetcher.consumeRecoveryCredit) {
      throw new ConnectedServiceQuotaFetchError(
        'Connected service quota recovery credit consume is unsupported',
        { quotaFetchErrorCode: 'provider_backoff', providerCode: 'unsupported' },
      );
    }

    const controller = new AbortController();
    const timeoutMs = this.fetchTimeoutMs;
    const consumePromise = input.fetcher.consumeRecoveryCredit({
      record: buildCredentialRecordForQuotaFetcher(input.record),
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
        (outcome) => ({ type: 'result' as const, outcome }),
        (error) => ({ type: 'error' as const, error }),
      ),
      timeoutPromise,
    ]);

    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = null;

    if (raced.type === 'timeout') return raced;
    if (raced.type === 'error') throw raced.error;
    return raced;
  }

  private async consumeRecoveryCreditWithCredential(input: Readonly<{
    fetcher: ConnectedServiceQuotaFetcher;
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    idempotencyKey: string;
    providerCreditId?: string;
  }>): Promise<Readonly<
    { type: 'timeout' }
    | {
      type: 'result';
      record: ConnectedServiceCredentialRecordV1;
      outcome: Exclude<ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1['status'], 'unknown_after_timeout'>;
    }
  >> {
    const consumed = await this.runRecoveryCreditConsumerWithTimeout({
      fetcher: input.fetcher,
      record: input.record,
      now: input.now,
      idempotencyKey: input.idempotencyKey,
      ...(input.providerCreditId ? { providerCreditId: input.providerCreditId } : {}),
    });
    return consumed.type === 'timeout'
      ? consumed
      : { type: 'result', record: input.record, outcome: consumed.outcome };
  }

  private async fetchQuotaSnapshot(input: Readonly<{
    fetcher: ConnectedServiceQuotaFetcher;
    serviceId: ConnectedServiceId;
    profileId: string;
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    signal?: AbortSignal;
  }>): Promise<
    | Readonly<{ type: 'timeout' }>
    | Readonly<{ type: 'result'; snapshot: ConnectedServiceQuotaSnapshotV1 | null }>
  > {
    return await this.runFetcherWithTimeout({
      fetcher: input.fetcher,
      record: input.record,
      now: input.now,
      signal: input.signal,
    });
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
    const profileId = String(input.profileId ?? '').trim();
    const idempotencyKey = String(input.idempotencyKey ?? '').trim();
    const providerCreditId = typeof input.providerCreditId === 'string' && input.providerCreditId.trim()
      ? input.providerCreditId.trim()
      : undefined;
    if (!profileId) {
      return {
        ok: false,
        errorCode: 'connected_service_quota_recovery_credit_profile_unavailable',
        error: 'connected_service_quota_recovery_credit_profile_unavailable',
      };
    }
    if (!idempotencyKey) {
      return {
        ok: false,
        errorCode: 'connected_service_quota_recovery_credit_idempotency_key_required',
        error: 'connected_service_quota_recovery_credit_idempotency_key_required',
      };
    }

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

    const fetcher = this.quotaFetchersByServiceId.get(serviceId);
    if (!fetcher?.consumeRecoveryCredit) {
      return {
        ok: false,
        errorCode: 'connected_service_quota_recovery_credit_unsupported',
        error: 'connected_service_quota_recovery_credit_unsupported',
      };
    }

    const accountMode = await resolveConnectedServiceAccountMode(this.api);
    if (accountMode === 'unknown') {
      return {
        ok: false,
        errorCode: 'connected_service_quota_recovery_credit_account_mode_unknown',
        error: 'connected_service_quota_recovery_credit_account_mode_unknown',
      };
    }

    const now = Math.max(0, Math.trunc(this.now()));
    const encryption = this.credentials.encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });

    const credential = await this.readCredentialForQuota({
      accountMode,
      material,
      serviceId,
      profileId,
    });
    if (!credential.record) {
      return {
        ok: false,
        errorCode: 'connected_service_quota_recovery_credit_auth_unavailable',
        error: 'connected_service_quota_recovery_credit_auth_unavailable',
      };
    }

    let consumedReceipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 | null = null;
    try {
      const consumed = await this.consumeRecoveryCreditWithCredential({
        fetcher,
        record: credential.record,
        now,
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
      if (
        consumed.outcome !== 'consumed'
        && consumed.outcome !== 'already_consumed'
        && consumed.outcome !== 'not_available'
        && consumed.outcome !== 'nothing_to_reset'
      ) {
        throw new ConnectedServiceQuotaFetchError(
          'Connected service quota recovery credit consumer returned an invalid outcome',
          {
            quotaFetchErrorCode: 'malformed',
            providerCode: 'connected_service_quota_recovery_credit_invalid_outcome',
          },
        );
      }
      consumedReceipt = this.buildRecoveryCreditConsumeReceipt({
        idempotencyKey,
        ...(providerCreditId ? { providerCreditId } : {}),
        status: consumed.outcome,
      });

      const refreshed = await this.fetchQuotaSnapshot({
        fetcher,
        serviceId,
        profileId,
        record: consumed.record,
        now,
      });
      if (refreshed.type === 'timeout') {
        return {
          ok: false,
          errorCode: 'connected_service_quota_refresh_timeout',
          error: 'connected_service_quota_refresh_timeout',
          receipt: consumedReceipt,
        };
      }

      const snapshot = refreshed.snapshot;
      if (snapshot) {
        this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot });
        const recordedAccountUsage = await this.recordFetchedQuotaSnapshotAsAccountUsage({
          serviceId,
          profileId,
          snapshot,
          now,
          accountMode: credential.storageMode,
          sourceProviderAccountId: readCredentialAccountIdentity(credential.record)?.providerAccountId ?? null,
          groupTargets: this.collectActiveGroupTargetsForBinding({ serviceId, profileId }),
        });
        void recordedAccountUsage;
      }

      return { ok: true, snapshot, receipt: consumedReceipt };
    } catch (error) {
      const errorCode = error instanceof ConnectedServiceQuotaFetchError
        ? error.providerCode ?? error.quotaFetchErrorCode
        : error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'connected_service_quota_recovery_credit_failed';
      return {
        ok: false,
        errorCode,
        error: errorCode,
        ...(consumedReceipt ? { receipt: consumedReceipt } : {}),
      };
    }
  }

  public async tickOnce(): Promise<void> {
    const now = Math.max(0, Math.trunc(this.now()));
    if (this.checkQuotaWorkGate('tick').status !== 'open') return;
    const accountMode = await resolveConnectedServiceAccountMode(this.api);
    if (accountMode === 'unknown') return;
    const encryption = this.credentials.encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });

    const bindingsByServiceId = new Map<ConnectedServiceId, Set<string>>();
    const groupSwitchTargetsByBindingKey = new Map<string, ActiveGroupQuotaSwitchTarget[]>();
    const activeGroupTargetsByServiceId = new Map<ConnectedServiceId, ActiveGroupQuotaSwitchTarget[]>();
    const pendingSoftSwitchTargets: ActiveGroupQuotaSwitchTarget[] = [];
    const profileHealthByServiceId: ProfileHealthByServiceId = new Map();
    const profileHealthLoadFailures = new Set<ConnectedServiceId>();
    const authGroupByKey = new Map<string, Promise<ConnectedServiceAuthGroupV1 | null>>();
    const loadProfileHealth = async (serviceId: ConnectedServiceId): Promise<Map<string, ConnectedServiceCredentialHealthStatusV1>> => {
      const existing = profileHealthByServiceId.get(serviceId);
      if (existing) return existing;
      if (typeof this.api.listConnectedServiceProfiles !== 'function') {
        const empty = new Map<string, ConnectedServiceCredentialHealthStatusV1>();
        profileHealthByServiceId.set(serviceId, empty);
        return empty;
      }
      try {
        const result = await this.api.listConnectedServiceProfiles({ serviceId });
        const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
        const byProfileId = new Map<string, ConnectedServiceCredentialHealthStatusV1>();
        for (const profile of profiles) {
          if (!profile || typeof profile !== 'object') continue;
          const profileId = typeof profile.profileId === 'string' ? String(profile.profileId).trim() : '';
          if (!profileId) continue;
          byProfileId.set(profileId, profile.status);
        }
        profileHealthByServiceId.set(serviceId, byProfileId);
        return byProfileId;
      } catch {
        profileHealthLoadFailures.add(serviceId);
        const empty = new Map<string, ConnectedServiceCredentialHealthStatusV1>();
        profileHealthByServiceId.set(serviceId, empty);
        return empty;
      }
    };
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
      for (const source of this.listScheduledCurrentSourceRefreshesForBinding(input)) {
        if (source.bindingKind !== 'group_member') continue;
        const groupId = source.groupId?.trim();
        const groupGeneration = source.groupGeneration;
        if (!groupId || typeof groupGeneration !== 'number') {
          this.startupCurrentSourceRefreshByKey.delete(buildConnectedServiceUsageSourceKey(source));
          continue;
        }
        const group = await this.readCurrentQuotaGroupForContext({
          serviceId: source.serviceId,
          groupId,
        });
        const isCurrentMember = group !== null
          && group.generation === groupGeneration
          && group.members.some((member) => (
            member.enabled && member.profileId.trim() === source.profileId
          ));
        if (!isCurrentMember) {
          this.startupCurrentSourceRefreshByKey.delete(buildConnectedServiceUsageSourceKey(source));
          continue;
        }
        addContext({
          groupId,
          groupGeneration,
        });
      }
      return out;
    };

    for (const source of this.startupCurrentSourceRefreshByKey.values()) {
      const profileId = source.profileId.trim();
      if (!profileId || !this.quotaFetchersByServiceId.has(source.serviceId)) continue;
      const existing = bindingsByServiceId.get(source.serviceId);
      if (existing) {
        existing.add(profileId);
      } else {
        bindingsByServiceId.set(source.serviceId, new Set([profileId]));
      }
    }

    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const activeBindings: ReadonlyArray<ActiveConnectedServiceBinding> = target.activeBindings.length > 0
        ? target.activeBindings.map((binding) => ({
          serviceId: binding.serviceId,
          profileId: binding.profileId,
          ...(binding.groupId ? { groupId: binding.groupId } : {}),
          groupGeneration: binding.generation,
        }))
        : extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv);
      for (const entry of activeBindings) {
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

    if (this.discoveryEnabled && typeof this.api.listConnectedServiceProfiles === 'function') {
      const discoveryDue = this.lastDiscoveryAt <= 0 || now - this.lastDiscoveryAt >= this.discoveryIntervalMs;
      if (discoveryDue) {
        let discoverySucceeded = true;
        for (const serviceId of this.quotaFetchersByServiceId.keys()) {
          const profiles = await loadProfileHealth(serviceId);
          if (profileHealthLoadFailures.has(serviceId)) {
            discoverySucceeded = false;
            continue;
          }
          const usableProfileIds = new Set<string>();
          for (const [profileId, status] of profiles.entries()) {
            if (!isConnectedServiceCredentialHealthStatusUsable(status)) continue;
            if (!profileId) continue;
            usableProfileIds.add(profileId);
          }
          this.discoveredProfileIdsByServiceId.set(serviceId, usableProfileIds);
        }
        if (discoverySucceeded) this.lastDiscoveryAt = now;
      }

      for (const [serviceId, profileIds] of this.discoveredProfileIdsByServiceId.entries()) {
        const existing = bindingsByServiceId.get(serviceId);
        if (existing) {
          for (const profileId of profileIds) existing.add(profileId);
        } else if (profileIds.size > 0) {
          bindingsByServiceId.set(serviceId, new Set(profileIds));
        }
      }
    }

    for (const [serviceId, profileIds] of bindingsByServiceId.entries()) {
      const fetcher = this.quotaFetchersByServiceId.get(serviceId);
      if (!fetcher) continue;
      const profileHealthByProfileId = await loadProfileHealth(serviceId);

      for (const profileId of profileIds) {
        if (profileHealthByProfileId.get(profileId) === 'needs_reauth') continue;
        // X8: capture any stale snapshot found during read so the catch path can
        // surface it with a stale_quota annotation instead of discarding it.
        let staleSnapshotForFallback: ConnectedServiceQuotaSnapshotV1 | null = null;
        let expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
        try {
          const bindingKey = this.makeBindingKey({ serviceId, profileId });
          const directGroupTargets = groupSwitchTargetsByBindingKey.get(bindingKey) ?? [];
          const groupContexts = await resolveGroupContextsForFetchedProfile({
            serviceId,
            profileId,
            directTargets: directGroupTargets,
          });
          const existing = await this.readExistingQuotaSnapshot({ accountMode, serviceId, profileId });
          const forcedRefresh = this.shouldForceQuotaRefresh(existing.existing)
            || this.listScheduledCurrentSourceRefreshesForBinding({ serviceId, profileId }).length > 0;

          const failureState = this.failureStateByBindingKey.get(bindingKey);
          if (failureState && now < failureState.nextAllowedAt) {
            continue;
          }

          if (this.isExistingQuotaSnapshotFresh({ existing: existing.existing, now, fetcher, forcedRefresh })) {
            this.failureStateByBindingKey.delete(bindingKey);
            this.clearScheduledCurrentSourceRefreshesForBinding({ serviceId, profileId });
            continue;
          }

          // Snapshot is stale — capture it for the failure fallback path (X8) before
          // attempting the fetch.  The fetch may throw, and if so we want to surface
          // the last-known data with a stale_quota annotation.
          staleSnapshotForFallback = this.openExistingQuotaSnapshot({
            storageMode: existing.storageMode,
            material,
            serviceId,
            profileId,
            existing: existing.existing,
          });
          if (staleSnapshotForFallback) {
            this.recordPersistedInBandQuotaStateFromExisting({
              serviceId,
              profileId,
              snapshot: staleSnapshotForFallback,
              existing: existing.existing,
            });
          }

          const lease = await this.acquireQuotaFetchLease({ serviceId, profileId });
          if (lease.type === 'contended') {
            const observedSnapshot = await this.waitForContendedQuotaFetch({
              accountMode,
              material,
              serviceId,
              profileId,
              fetcher,
              now,
              leaseUntil: lease.leaseUntil,
            });
            if (observedSnapshot) {
              this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: observedSnapshot });
              await this.recordFetchedQuotaSnapshotAsAccountUsage({
                serviceId,
                profileId,
                snapshot: observedSnapshot,
                now,
                accountMode,
                groupContexts,
                groupTargets: directGroupTargets,
              });
              pendingSoftSwitchTargets.push(...directGroupTargets);
              this.failureStateByBindingKey.delete(bindingKey);
              this.clearScheduledCurrentSourceRefreshesForBinding({ serviceId, profileId });
            }
            continue;
          }

          const credential = await this.readCredentialForQuota({
            accountMode,
            material,
            serviceId,
            profileId,
          });
          expectedCredentialRevision = credential.credentialRevision;
          const record = credential.record;
          if (!record) continue;

          const raced = await this.fetchQuotaSnapshot({
            fetcher,
            serviceId,
            profileId,
            record,
            now,
          });
          if (raced.type === 'timeout') {
            // Best-effort only: ignore late results. The AbortController should be enough for well-behaved fetchers.
            continue;
          }

          const snapshot = raced.snapshot;
          if (!snapshot) continue;

          if (staleSnapshotForFallback && isQuotaUnknownFallbackSnapshot(snapshot)) {
            this.recordRuntimeProfileSnapshot({
              serviceId,
              profileId,
              snapshot: annotateSnapshotAsStale(staleSnapshotForFallback),
            });
            this.failureStateByBindingKey.delete(bindingKey);
            continue;
          }

          this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot });
          const recordedAccountUsage = await this.recordFetchedQuotaSnapshotAsAccountUsage({
            serviceId,
            profileId,
            snapshot,
            now,
            accountMode: credential.storageMode,
            sourceProviderAccountId: readCredentialAccountIdentity(record)?.providerAccountId ?? null,
            groupContexts,
            groupTargets: directGroupTargets,
          });
          pendingSoftSwitchTargets.push(...directGroupTargets);
          void recordedAccountUsage;
          this.failureStateByBindingKey.delete(bindingKey);
          this.clearScheduledCurrentSourceRefreshesForBinding({ serviceId, profileId });
        } catch (error) {
          const bindingKey = this.makeBindingKey({ serviceId, profileId });
          const credentialHealthStatus = await this.persistCredentialHealthForQuotaFailure({
            serviceId,
            profileId,
            expectedCredentialRevision,
            error,
            now,
          }).catch(() => null);
          if (credentialHealthStatus === 'needs_reauth') {
            profileHealthByProfileId.set(profileId, 'needs_reauth');
          }
          this.applyFailureBackoff({
            now,
            key: bindingKey,
            retryAfterMs: readQuotaRetryAfterMs(error),
            retryAfterBackoffMinMs: fetcher?.pollPolicy?.retryAfterBackoffMinMs,
          });
          // X8: keep last-known quota in the runtime store with stale_quota annotation
          // so the UI can display "stale data" rather than showing nothing.
          if (staleSnapshotForFallback) {
            this.recordRuntimeProfileSnapshot({
              serviceId,
              profileId,
              snapshot: annotateSnapshotAsStale(staleSnapshotForFallback),
            });
          }
          // Best-effort only.
          continue;
        }
      }
    }
    if (pendingSoftSwitchTargets.length > 0) {
      await this.maybeRequestActiveGroupSwitchForSnapshot({
        now,
        targets: pendingSoftSwitchTargets,
      });
    }
  }
}
