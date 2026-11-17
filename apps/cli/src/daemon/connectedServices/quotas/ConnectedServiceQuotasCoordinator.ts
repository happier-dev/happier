import { setTimeout, clearTimeout } from 'node:timers';
import { buildProviderAccountUsageIdentityFromQualifiedAccount } from '../accountUsage/qualifiedAccountIdentity';
import { maintainProviderAccountUsageDaySummariesForRecord, persistProviderAccountUsageWithDaySummaries } from '../accountUsage/persistence';
import type { ProviderAccountUsageUsageIdentityResolver } from '../accountUsage/hydration';
import type { ConnectedAccountCompletionObservation } from '@happier-dev/cli-common/connectedAccounts';
import type { ConnectedServiceRefreshCoordinator } from '../refresh/ConnectedServiceRefreshCoordinator';
import type { ScheduledQualifiedAccountHealth } from '../refresh/ConnectedServiceRefreshCoordinator';
import { logger } from '@/ui/logger';
import { matchesCurrentQuotaObservationCredential } from './proof/quotaProbeFreshProof';
import { invokeQuota } from './invokeQuota';
import type { SingleFlightLoopSchedule } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { buildRecoveryCreditConsumeIdempotencyKey } from '@happier-dev/protocol/connect/recoveryCreditConsumeIdempotencyKey';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedServiceIdSchema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import { ConnectedServiceCredentialRevisionV1Schema, ConnectedServiceUsageSourceV1Schema, isConnectedServiceCredentialHealthStatusUsable, isConnectedServiceQuotaRecoveryCreditAvailable } from '@happier-dev/protocol/connect/connected-service-schemas';
import { compareConnectedServiceQuotaObservationRecency, isConnectedServiceQuotaObservationFresh } from '@happier-dev/protocol/connect/quotaObservationTime';
import { mergeProviderAccountSubscription } from '@happier-dev/protocol/connect/accountSubscription';
import { openQualifiedConnectedAccountQuotaResponseV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { isProviderAccountUsageIdentityMatch, projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1, sealProviderAccountUsageSnapshot } from '@happier-dev/protocol/connect/accountUsage';
import type { BuiltInLegacyConnectedAccountOperation, ConnectedAccountServiceKey, ConnectedServiceAuthGroupMemberStateV1, ConnectedServiceCredentialHealthV1, ConnectedServiceId, ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1, ConnectedServiceQuotaSnapshotV1, ConnectedServiceUsageSourceV1, ConnectedServiceLimitCategoryV1, PluginConnectedAccountDescriptorContributionV2, ProviderAccountUsageRecordKeyV1, ProviderAccountUsageQuotaScopeV1, ProviderAccountUsageSnapshotV1, QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountRef, QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol';
import type { ConnectedAccountRuntimeEstablishedResult } from '@/plugins/runtime/connectedAccounts/runtimeInvoker';
import {
  type KeyedBackoffTracker,
} from '@/api/connection/scheduling';
import type {
  ConnectedServiceCredentialPlainResponse,
  ConnectedServiceCredentialSealedResponse,
} from '@/api/client/connectedServiceCredentialApi';
import type { StoredCredentials } from '@/persistence';
import type { RequesterConnectedAccountObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import {
  AccountEncryptionMaterialUnavailableError,
} from '@/api/client/encryptionKey';
import {
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

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { projectProviderAccountUsageSnapshotToAuthGroupRuntimeState } from '../accountGroups/quotas/projection';
import {
  evaluateConnectedServiceAuthGroupQuotaLifecycle,
  type ConnectedServiceAuthGroupQuotaLifecycleState,
} from '../accountGroups/quotas/lifecycle';
import {
  isProviderAccountUsageStoreMutationAccepted,
  type ProviderAccountUsageStore,
} from '../accountUsage/store';
import { computeProviderAccountUsageSnapshotFingerprint } from '../accountUsage/fingerprint';
import {
  buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation,
  buildProviderAccountUsageSnapshotFromQualifiedQuotaRow,
} from '../accountUsage/fromConnectedServiceQuotaObservation';
import {
  resolveConnectedServiceAuthGroupPriorityPrimaryProfileId,
  resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence,
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupQuotaSnapshot,
} from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import {
  buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
  buildQualifiedConnectedAccountAuthGroupAccountUsageView,
  resolveAccountUsageSnapshotsByGroupProfile,
  type ConnectedServiceAuthGroupAccountUsageView,
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
import type { ConnectedServiceAuthGroupQuotaProbeResult } from '../accountGroups/quotas/preTurnQuotaProbe';

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
import { createQuotaPersistenceBackoff } from './createQuotaPersistenceBackoff';
import type { ConnectedServiceQuotaFetcher } from './types';
import { RuntimeAccountIdentityIndex } from './identity/RuntimeAccountIdentityIndex';
import { DEFAULT_CONNECTED_SERVICE_QUOTA_FRESHNESS_MS, resolveConnectedServiceQuotasDaemonOptions } from './resolveConnectedServiceQuotasDaemonOptions';
import { resolveSessionsSharingProviderAccount } from './identity/resolveSessionsSharingProviderAccount';
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
  type ConnectedServiceRuntimeTarget,
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
  readQualifiedConnectedAccountQuotaV4,
  writeQualifiedProviderAccountUsageV4,
  type QualifiedConnectedAccountPeerClass,
  type QualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import { isBuiltInLegacyConnectedAccountPeerOperationSupported } from '@happier-dev/protocol/connect/connected-service-bindings';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
  QualifiedConnectedAccountEstablishedInvocationBasis,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type {
  QualifiedConnectedAccountV4Support,
} from '../qualifiedConnectedAccountV4Support';
import {
  resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey,
  resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput,
  resolveQualifiedConnectedAccountServiceForIngressServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';

/**
 * The replacement read starts one refresh interval before the reading's freshness deadline, so a
 * reading is called old only when its replacement is late. A window no longer than one interval
 * keeps its own deadline, so no producer's reading is refreshed later than before.
 */
function quotaObservationProbeAt(input: Readonly<{
  fetchedAt: number;
  staleAfterMs: number;
  refreshIntervalMs: number;
  resetsAt: readonly (number | null | undefined)[];
  refreshWhenStale?: boolean;
}>): number {
  const refreshAfterMs = Math.max(
    Math.min(input.staleAfterMs, input.refreshIntervalMs),
    input.staleAfterMs - input.refreshIntervalMs,
  );
  return Math.min(...(input.refreshWhenStale === false ? [] : [input.fetchedAt + refreshAfterMs]), ...input.resetsAt.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > input.fetchedAt,
  ));
}

type PluginConnectedAccountQuotaSnapshot = NonNullable<ConnectedAccountRuntimeEstablishedResult<Readonly<{ kind: 'quota' }>>>;

export type QualifiedConnectedAccountQuotaRuntime = Readonly<{
  resolveUsageIdentity?: (service: Parameters<ProviderAccountUsageUsageIdentityResolver>[0], signal?: AbortSignal) => ReturnType<ProviderAccountUsageUsageIdentityResolver>;
  resolveCurrentCredentialProof?: (account: QualifiedConnectedAccountRef, signal?: AbortSignal) => Promise<Readonly<{
    providerAccountId: string | null; providerOrganizationId: string | null; credentialFingerprint: string | null;
  }> | null>;
  enrichCredentialContext?: ConnectedServiceRefreshCoordinator['enrichQualifiedConnectedAccountCredentialContext'];
  resolvePeerClass(): QualifiedConnectedAccountPeerClass;
  resolveOperationTransport?(input: Readonly<{
    service: QualifiedConnectedAccountRef['service'];
    operation: BuiltInLegacyConnectedAccountOperation;
  }>): QualifiedConnectedAccountPeerOperationTransport;
  establishedRuntimeOwner: Pick<
    QualifiedConnectedAccountEstablishedRuntimeOwner,
    'invokeWithReceipt' | 'invokeScheduledWithReceipts' | 'readQuotaSourceSnapshot'
  >;
  listScheduledAccounts(service?: QualifiedConnectedAccountRef['service'], signal?: AbortSignal): Promise<
    readonly QualifiedConnectedAccountProfileV4[]
  >;
  listAccounts?(input: Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    signal?: AbortSignal;
  }>): Promise<readonly QualifiedConnectedAccountProfileV4[]>;
  listGroupQuotaTargets?(input: Readonly<{
    service: QualifiedConnectedAccountRef['service'];
    groupId: string;
    /** Omit to observe every actual member of the selected group. */
    accountIds?: ReadonlyArray<string>;
    signal: AbortSignal;
  }>): Promise<readonly Readonly<{
    profile: QualifiedConnectedAccountProfileV4;
    groupGeneration: number;
  }>[]>;
  readGroup?(input: Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    groupId: string;
    signal?: AbortSignal;
  }>): Promise<QualifiedConnectedAccountGroupV4 | null>;
  updateGroupRuntimeState?(input: Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    groupId: string;
    expectedGeneration: number;
    expectedIncarnation: string;
    expectedRuntimeStateRevision: number;
    runtimeState: Readonly<{
      memberStates: readonly Readonly<{
        connectedAccountId: string;
        state: ConnectedServiceAuthGroupMemberStateV1;
      }>[];
    }>;
  }>): Promise<QualifiedConnectedAccountGroupV4>;
  readQuota?: typeof readQualifiedConnectedAccountQuotaV4;
  writeProviderAccountUsage?: typeof writeQualifiedProviderAccountUsageV4;
}>;

type ScalarQualifiedConnectedAccountGroup = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  group: QualifiedConnectedAccountGroupV4;
}>;

function matchesQualifiedService(
  left: QualifiedConnectedAccountServiceRef,
  right: QualifiedConnectedAccountServiceRef,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * Canonical source identity for the daemon account-usage store: every recorded source key uses
 * the qualified `ConnectedAccountServiceKey` so canonical consumers (switch state, lifecycle,
 * startup refresh scheduling) resolve them without a second ingress translation. The legacy
 * scalar id stays local to the legacy fetch/credential seams and is never recorded as a
 * store source identity.
 */
function canonicalConnectedAccountServiceKeyForSources(
  serviceId: ConnectedServiceId,
): ConnectedAccountServiceKey {
  const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(serviceId);
  return service ? buildQualifiedPluginContributionKey(service) : serviceId;
}

function scalarQualifiedGroupAccountUsageView(
  input: ScalarQualifiedConnectedAccountGroup,
): ConnectedServiceAuthGroupAccountUsageView {
  return buildQualifiedConnectedAccountAuthGroupAccountUsageView(input.group);
}

function qualifiedAccountQuotaKey(
  account: QualifiedConnectedAccountRef,
): string {
  return JSON.stringify([
    account.service.pluginId,
    account.service.localId,
    account.accountId,
  ]);
}

function sameGroupSwitchTarget(
  left: ActiveGroupQuotaSwitchTarget,
  right: ActiveGroupQuotaSwitchTarget,
): boolean {
  return left.sessionId === right.sessionId
    && left.serviceId === right.serviceId
    && left.groupId === right.groupId
    && left.activeProfileId === right.activeProfileId;
}

export function buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota(
  input: Readonly<{
    profile: QualifiedConnectedAccountProfileV4;
    quota: PluginConnectedAccountQuotaSnapshot;
    staleAfterMs: number;
    usageIdentity?: PluginConnectedAccountDescriptorContributionV2['usageIdentity'];
  }>,
): ProviderAccountUsageSnapshotV1 {
  const identity = buildProviderAccountUsageIdentityFromQualifiedAccount({
    ref: input.profile.ref, providerIdentity: input.profile.providerIdentity,
    usageIdentity: input.usageIdentity, providerOrganizationId: input.quota.providerOrganizationId,
  });
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
    const total = typeof limit.limit === 'number' && Number.isFinite(limit.limit)
      ? limit.limit
      : used !== null && remaining !== null ? used + remaining : null;
    const hasPositiveTotal =
      total !== null && Number.isFinite(total) && total > 0;
    const usedPct = typeof limit.utilizationPct === 'number' && Number.isFinite(limit.utilizationPct)
      ? Math.min(100, Math.max(0, limit.utilizationPct))
      : hasPositiveTotal && used !== null ? Math.min(100, Math.max(0, (used / total) * 100)) : null;
    const remainingPct = typeof limit.remainingPct === 'number' && Number.isFinite(limit.remainingPct)
      ? Math.min(100, Math.max(0, limit.remainingPct))
      : hasPositiveTotal && remaining !== null ? Math.min(100, Math.max(0, (remaining / total) * 100)) : null;
    const resetsAt =
      typeof limit.resetsAtMs === 'number'
      && Number.isInteger(limit.resetsAtMs)
      && limit.resetsAtMs >= 0
        ? limit.resetsAtMs
        : null;
    return {
      meterId: limit.id,
      label: limit.label ?? limit.id,
      used,
      limit: total,
      remaining,
      remainingPct,
      usedPct,
      resetAtMs: resetsAt,
      resetSource: resetsAt === null ? 'unknown' as const : 'provider' as const,
      providerLimitId: limit.providerLimitId ?? limit.id,
      ...(limit.windowDurationMs === undefined ? {} : { windowDurationMs: limit.windowDurationMs }),
      ...(limit.modelId === undefined ? {} : { modelId: limit.modelId }),
      ...(limit.isExhausted !== undefined
        ? { isExhausted: limit.isExhausted }
        : remaining !== null
          ? { isExhausted: remaining <= 0 }
          : {}),
      unit: limit.unit ?? 'unknown' as const,
      utilizationPct: usedPct,
      resetsAt,
      status: limit.status ?? (used !== null || remaining !== null ? 'ok' as const : 'unavailable' as const),
      source: 'provider_api' as const,
      scope: limit.scope ?? 'unknown' as const,
      limitScope: limit.limitScope ?? 'account' as const,
      confidence: limit.confidence ?? 'exact' as const,
      details: {
        ...limit.details,
        providerLimitId: limit.providerLimitId ?? limit.id,
        remainingPct,
      },
    };
  });
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    ...identity,
    observedAtMs,
    fetchedAtMs: observedAtMs,
    staleAfterMs: Math.max(1, Math.trunc(input.staleAfterMs)),
    source: 'providerHttp',
    confidence: 'confirmed',
    state: meters.length > 0 ? 'loaded_data' : 'loaded_empty',
    accountLabel: input.profile.displayName ?? null,
    ...(input.quota.planLabel === undefined ? {} : { planLabel: input.quota.planLabel }),
    ...(input.quota.subscription ? { subscription: input.quota.subscription } : {}),
    ...(input.quota.recoveryCredits ? { recoveryCredits: input.quota.recoveryCredits } : {}),
    ...(input.quota.recoveryCreditDetails ? { recoveryCreditDetails: input.quota.recoveryCreditDetails } : {}),
    meters,
  });
}

type ConnectedServicesBindingsV1Like = Readonly<{
  v?: unknown;
  bindingsByServiceId?: Record<string, unknown>;
}>;

type QuotaApi = Readonly<{
  getAccountEncryptionMode?: (options?: Readonly<{ refresh?: boolean; signal?: AbortSignal }>) => Promise<ConnectedServiceAccountMode>;
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
  getConnectedServiceCredentialSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string; signal?: AbortSignal }>) => Promise<
    ConnectedServiceCredentialSealedResponse | null
  >;
  getConnectedServiceCredentialPlain?: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string; signal?: AbortSignal }>) => Promise<
    ConnectedServiceCredentialPlainResponse | null
  >;
  listConnectedServiceProfiles?: (args: Readonly<{ serviceId: ConnectedServiceId; signal?: AbortSignal }>) => Promise<
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
}>;

export type AutomaticQuotaResetContext = Readonly<{ groupId: string; sessionId?: string; providerLimitIds?: readonly string[] }>;
export type AutomaticQuotaResetConsumedEvent = AutomaticQuotaResetContext & Readonly<{
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
  receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1;
}>;

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
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
  groupId?: string;
  groupGeneration?: number | null;
}>;
type ActiveGroupQuotaSwitchTarget = Readonly<{
  sessionId: string;
  serviceId: ConnectedAccountServiceKey;
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
const CONNECTED_SERVICE_GROUP_QUOTA_PROBE_MAX_CONCURRENCY = 4;
export type ConnectedServiceQuotaCoordinatorDiagnostic = Readonly<{
  event: 'quota_work_deferred' | 'quota_work_suppressed' | 'quota_work_requested';
  phase: QuotaWorkPhase;
  reason: string;
  retryAfterMs?: number;
  sessionId?: string;
  serviceId?: ConnectedAccountServiceKey;
  groupId?: string;
  activeProfileId?: string;
  eligibilityStatus?: GroupSwitchTargetEligibility['status'];
  sourceProfileId?: string | null;
  sourceRemainingPercent?: number;
  sourceThresholdPercent?: number;
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
type LegacyConnectedServiceUsageSource = Omit<ConnectedServiceUsageSourceV1, 'serviceId'> & Readonly<{
  serviceId: ConnectedServiceId;
}>;
function requireQuotaCredentialOpenMaterial(
  material: QuotaCredentialOpenMaterial | null,
): QuotaCredentialOpenMaterial {
  if (!material) throw new AccountEncryptionMaterialUnavailableError();
  return material;
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
    signal?: AbortSignal;
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    observedProfileId?: string | null;
  }>): Promise<unknown>;
  applyCommittedGeneration?(input: Readonly<{
    sessionId: string;
    serviceId: string;
    groupId: string;
    activeProfileId: string;
    generation: number;
    credentialRevision?: import('@happier-dev/protocol').ConnectedServiceCredentialRevisionV1 | null;
    reason: string;
  }>): Promise<unknown>;
}>;

export type ConsumeCommittedAuthGroupGeneration = (input: Readonly<{
  signal?: AbortSignal;
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
}>;
type SameAccountFanoutStrategyResolver = (
  input: Readonly<{
    agentId?: string | null;
    serviceId: ConnectedAccountServiceKey;
    sourceSessionId: string;
    groupId: string;
  }>,
) => ConnectedServiceSameAccountFanoutStrategy | Promise<ConnectedServiceSameAccountFanoutStrategy>;
type PredictiveSwitchGuardResult =
  | Readonly<{ status: 'allow' }>
  | Readonly<{ status: 'suppress' | 'fold'; reason: string }>;
/**
 * Predictive admission consumes the exact canonical service identity before
 * any switch effect, including services without a legacy scalar projection.
 */
export type ConnectedServiceQuotaPredictiveSwitchGuard = (
  input: Readonly<{
    signal?: AbortSignal;
    sessionId: string;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    activeProfileId: string;
    reason: 'soft_threshold';
  }>,
) => PredictiveSwitchGuardResult | Promise<PredictiveSwitchGuardResult>;
export type ConnectedServiceQuotaLifecycleTransition = Readonly<{
  phase: 'blocked' | 'recovered';
  serviceId: ConnectedAccountServiceKey;
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
  signal?: AbortSignal,
) => void | Promise<void>;
export type ConnectedServiceUsageSnapshotTransition = Readonly<{
  phase: 'observed';
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
  previous: ProviderAccountUsageSnapshotV1 | null;
  snapshot: ProviderAccountUsageSnapshotV1;
}>;

function extractActiveBindings(
  target: Pick<ConnectedServiceRuntimeTarget, 'activeBindings'>,
): ActiveConnectedServiceBinding[] {
  // Effective registry bindings retain provider observations that invalidate applied
  // generation proof. Launch selections cannot restore that proof.
  return target.activeBindings.map((binding) => ({
    serviceId: binding.serviceId,
    profileId: binding.profileId,
    ...(binding.groupId ? { groupId: binding.groupId } : {}),
    groupGeneration: binding.groupGeneration,
  }));
}

function activeBindingMatchesRuntimeIdentity(
  binding: ActiveConnectedServiceBinding,
  identity: Readonly<{
    serviceId: ConnectedAccountServiceKey;
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

type FailureState = Readonly<{
  consecutiveFailures: number;
  nextAllowedAt: number;
  providerDirected: boolean;
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

function resolveQuotaFetchFailureBackoffMs(input: Readonly<{
  error: unknown;
  now: number;
}>): number | null {
  const error = isRecord(input.error) ? input.error : null;
  const retryAfterMs = readFiniteNonNegativeMs(error?.retryAfterMs);
  if (retryAfterMs !== null && retryAfterMs > 0) return retryAfterMs;

  const resetAtMs = readFiniteNonNegativeMs(error?.resetAtMs);
  if (resetAtMs !== null && resetAtMs > input.now) return resetAtMs - input.now;

  return null;
}

function providerHttpStatusForHealth(status: unknown): number | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 100 && status <= 599 ? status : undefined;
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

type RecoveryCreditConsumeInput = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
  groupId?: string;
  automaticResetContext?: AutomaticQuotaResetContext;
  consumeRequest?: Readonly<{ idempotencyKey: string; providerCreditId?: string }>;
}>;
type RecoveryCreditConsumeInFlight = Readonly<{
  promise: Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult>;
  automaticProviderLimitIds: readonly string[] | undefined;
}>;

export class ConnectedServiceQuotasCoordinator {
  private readonly api: QuotaApi;
  private readonly credentials: StoredCredentials;
  private readonly quotaFetchersByServiceId: Map<ConnectedServiceId, ConnectedServiceQuotaFetcher>;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly fetchTimeoutMs: number | null;
  private readonly discoveryEnabled: boolean;
  private readonly discoveryIntervalMs: number;
  private readonly probeIntervalMs: number;
  private readonly runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  private readonly accountUsageStore: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId' | 'retainSourcesForProfile'> & AccountUsageStoreForAuthGroupSwitchState | null;
  private readonly authGroupSwitchCoordinator: AuthGroupSwitchCoordinator | null;
  private readonly consumeCommittedAuthGroupGeneration: ConsumeCommittedAuthGroupGeneration | null;
  private readonly predictiveSwitchGuard: ConnectedServiceQuotaPredictiveSwitchGuard | null;
  private readonly sameAccountFanoutStrategyResolver: SameAccountFanoutStrategyResolver;
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
  /** Polled readings are refreshed every freshness interval and stay current through one missed refresh. */
  private readonly polledQuotaStaleAfterMs: number;
  private readonly runtimeRegistry: ConnectedServiceRuntimeRegistry;
  private readonly resolveRequiredModelIds?: (input: Readonly<{ serviceId: ConnectedAccountServiceKey; groupId: string }>) => ReadonlyArray<string>;
  private readonly qualifiedConnectedAccountRuntime:
    QualifiedConnectedAccountQuotaRuntime | null;
  private readonly qualifiedHealth: Pick<ConnectedServiceRefreshCoordinator,
    'prepareScheduledQualifiedHealth' | 'retainScheduledQualifiedHealthAccounts'>
    & Partial<Pick<ConnectedServiceRefreshCoordinator, 'refreshQualifiedConnectedAccountCredentialForRequestAuth'>> | null;
  private readonly runtimeAccountIdentities: RuntimeAccountIdentityIndex;
  private readonly failureStateByBindingKey = new Map<string, FailureState>();
  private readonly qualifiedQuotaScheduleByKey = new Map<string, Readonly<{
    basis: string; at: number | null; recordId: string | null;
    credentialRevision: QualifiedConnectedAccountProfileV4['credentialRevision'];
    configurationRevision: QualifiedConnectedAccountProfileV4['configurationRevision'];
    providerAccountId: string | null; providerOrganizationId: string | null;
  }>>();
  private readonly groupSwitchCheckAtByKey = new Map<string, number>();
  private readonly sameAccountFanoutAtByKey = new Map<string, number>();
  private readonly quotaLifecycleStateByGroupKey = new Map<string, ConnectedServiceAuthGroupQuotaLifecycleState>();
  private readonly onQuotaLifecycleTransition: ConnectedServiceQuotaLifecycleListener | null;
  private readonly onAccountUsageSnapshotAccepted: ((transition: ConnectedServiceUsageSnapshotTransition, signal?: AbortSignal) => void | Promise<void>) | null;
  private readonly onAutomaticQuotaResetConsumed: ((event: AutomaticQuotaResetConsumedEvent) => Promise<void>) | null;
  private readonly recoveryCreditConsumeResultsByKey = new Map<string, ConnectedServiceQuotaRecoveryCreditConsumeResult>();
  private readonly recoveryCreditConsumeInFlightByKey = new Map<string, RecoveryCreditConsumeInFlight>();
  private readonly startupCurrentSourceRefreshByKey = new Map<string, LegacyConnectedServiceUsageSource>();
  private readonly legacyDiscoveredProfileIdsByServiceId = new Map<ConnectedServiceId, ReadonlySet<string>>();
  private lastDiscoveryAt = 0;

  public invalidateInventory(event?: RequesterConnectedAccountObservation): void {
    this.lastDiscoveryAt = 0;
    for (const [key, schedule] of this.qualifiedQuotaScheduleByKey) {
      if (event?.resetQuotaSchedule || (event?.quotaRefreshRecordIds?.length
        && (schedule.recordId === null || event.quotaRefreshRecordIds.includes(schedule.recordId)))) {
        this.qualifiedQuotaScheduleByKey.set(key, { ...schedule, at: -Infinity });
      }
    }
  }

  public constructor(params: Readonly<{
    api: QuotaApi;
    credentials: StoredCredentials;
    quotaFetchers: ReadonlyArray<ConnectedServiceQuotaFetcher>;
    now: () => number;
    randomBytes: (length: number) => Uint8Array;
    fetchTimeoutMs?: number;
    discoveryEnabled?: boolean;
    discoveryIntervalMs?: number;
    /** Existing external acquisition cadence when a probe yields no observation. */
    probeIntervalMs?: number;
    runtimeQuotaSnapshots?: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
    accountUsageStore?: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId' | 'retainSourcesForProfile'> & AccountUsageStoreForAuthGroupSwitchState | null;
    authGroupSwitchCoordinator?: AuthGroupSwitchCoordinator | null;
    consumeCommittedAuthGroupGeneration?: ConsumeCommittedAuthGroupGeneration | null;
    predictiveSwitchGuard?: ConnectedServiceQuotaPredictiveSwitchGuard | null;
    sameAccountFanoutStrategyResolver?: SameAccountFanoutStrategyResolver;
    readRuntimeAccountIdentityForFanout?: RuntimeAccountIdentityFanoutReader | null;
    /**
     * Durable same-account fanout fallback proof source. When the live probe is UNAVAILABLE or INEXACT
     * (never on a VERIFIED mismatch), the candidate's persisted materialization identity can supply the
     * fanout proof — surviving the daemon restart that wipes the in-memory runtime identity index.
     */
    readPersistedSessionAccountIdentity?: PersistedSessionAccountIdentityReader | null;
    sameAccountFanoutMinIntervalMs?: number;
    sameAccountFanoutResetBucketMs?: number;
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
    onQuotaLifecycleTransition?: ConnectedServiceQuotaLifecycleListener | null;
    onAccountUsageSnapshotAccepted?: (transition: ConnectedServiceUsageSnapshotTransition, signal?: AbortSignal) => void | Promise<void>;
    onAutomaticQuotaResetConsumed?: (event: AutomaticQuotaResetConsumedEvent) => Promise<void>;
    runtimeRegistry?: ConnectedServiceRuntimeRegistry;
    resolveRequiredModelIds?: (input: Readonly<{ serviceId: ConnectedAccountServiceKey; groupId: string }>) => ReadonlyArray<string>;
    qualifiedConnectedAccountRuntime?:
      QualifiedConnectedAccountQuotaRuntime | null;
    qualifiedHealth?: Pick<ConnectedServiceRefreshCoordinator,
      'prepareScheduledQualifiedHealth' | 'retainScheduledQualifiedHealthAccounts'>
      & Partial<Pick<ConnectedServiceRefreshCoordinator, 'refreshQualifiedConnectedAccountCredentialForRequestAuth'>> | null;
  }>) {
    this.api = params.api;
    this.qualifiedHealth = params.qualifiedHealth ?? null;
    this.credentials = params.credentials;
    this.now = params.now;
    this.randomBytes = params.randomBytes;
    this.quotaFetchersByServiceId = new Map(params.quotaFetchers.map((f) => [f.serviceId, f]));
    this.fetchTimeoutMs =
      typeof params.fetchTimeoutMs === 'number' && Number.isFinite(params.fetchTimeoutMs)
        ? Math.max(1, Math.trunc(params.fetchTimeoutMs))
        : null;
    this.discoveryEnabled = typeof params.discoveryEnabled === 'boolean' ? params.discoveryEnabled : true;
    this.probeIntervalMs = params.probeIntervalMs ?? resolveConnectedServiceQuotasDaemonOptions({}).probeIntervalMs;
    this.discoveryIntervalMs =
      typeof params.discoveryIntervalMs === 'number' && Number.isFinite(params.discoveryIntervalMs)
        ? Math.max(1, Math.trunc(params.discoveryIntervalMs))
        : 60_000;
    this.runtimeQuotaSnapshots = params.runtimeQuotaSnapshots ?? null;
    this.accountUsageStore = params.accountUsageStore ?? null;
    this.authGroupSwitchCoordinator = params.authGroupSwitchCoordinator ?? null;
    this.consumeCommittedAuthGroupGeneration = params.consumeCommittedAuthGroupGeneration ?? null;
    this.predictiveSwitchGuard = params.predictiveSwitchGuard ?? null;
    this.sameAccountFanoutStrategyResolver = params.sameAccountFanoutStrategyResolver
      ?? (() => 'none');
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
    this.recordDiagnostic = params.recordDiagnostic ?? ((event) => {
      logger.infoFile('[DAEMON RUN] Connected-service quota diagnostic', event);
    });
    this.runtimeAccountIdentities = new RuntimeAccountIdentityIndex();
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
        : DEFAULT_CONNECTED_SERVICE_QUOTA_FRESHNESS_MS;
    this.polledQuotaStaleAfterMs = 2 * this.quotaPersistenceMinFreshnessMs;
    this.onQuotaLifecycleTransition = params.onQuotaLifecycleTransition ?? null;
    this.onAccountUsageSnapshotAccepted = params.onAccountUsageSnapshotAccepted ?? null;
    this.onAutomaticQuotaResetConsumed = params.onAutomaticQuotaResetConsumed ?? null;
    this.runtimeRegistry = params.runtimeRegistry ?? new ConnectedServiceRuntimeRegistry();
    this.resolveRequiredModelIds = params.resolveRequiredModelIds;
    this.qualifiedConnectedAccountRuntime =
      params.qualifiedConnectedAccountRuntime ?? null;
    this.inBandQuotaPersistenceBackoff = createQuotaPersistenceBackoff({
      baseDelayMs: params.quotaPersistenceFailureBackoffBaseMs,
      maxDelayMs: params.quotaPersistenceFailureBackoffMaxMs,
      jitterRatio: params.quotaPersistenceFailureBackoffJitterRatio,
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
          : undefined,
      maxKeyAgeMs:
        typeof params.quotaPersistenceMaxKeyAgeMs === 'number' && Number.isFinite(params.quotaPersistenceMaxKeyAgeMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxKeyAgeMs))
          : undefined,
      maxPendingPayloadAgeMs:
        typeof params.quotaPersistenceMaxPendingPayloadAgeMs === 'number' && Number.isFinite(params.quotaPersistenceMaxPendingPayloadAgeMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxPendingPayloadAgeMs))
          : undefined,
      maxConsecutiveFailures:
        typeof params.quotaPersistenceMaxConsecutiveFailures === 'number' && Number.isFinite(params.quotaPersistenceMaxConsecutiveFailures)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxConsecutiveFailures))
          : undefined,
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
    spawnTrackingKey?: string;
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
    }
    this.runtimeRegistry.registerTarget({
      pid,
      ...(sessionId ? { sessionId } : {}),
      ...(params.spawnTrackingKey ? { spawnTrackingKey: params.spawnTrackingKey } : {}),
      ...(agentId ? { agentId } : {}),
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw ?? {},
      ...(params.connectedServiceSelectionsEnv ? { connectedServiceSelectionsEnv: params.connectedServiceSelectionsEnv } : {}),
    });
  }

  public updateSpawnTargetSessionId(params: Readonly<{
    pid: number;
    sessionId?: string;
    /** The spawn's SessionTrackingKey: its own sessionless bootstrap is the one adopted. */
    spawnTrackingKey?: string;
    /** Tracked custody proves the process hosts only this Session (every runner but a session host). */
    soleSessionOfProcess?: boolean;
  }>): void {
    const pid = Math.trunc(Number(params.pid));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    if (!sessionId) return;
    const previousSessionId = params.soleSessionOfProcess === true ? this.runtimeRegistry.getByPid(pid)?.sessionId : undefined;
    const adopted = this.runtimeRegistry.adoptSessionId({
      pid,
      sessionId,
      ...(params.spawnTrackingKey ? { spawnTrackingKey: params.spawnTrackingKey } : {}),
      ...(params.soleSessionOfProcess === true ? { soleSessionOfProcess: true } : {}),
    });
    if (!adopted) return;
    if (previousSessionId && previousSessionId !== sessionId) {
      this.runtimeAccountIdentities.invalidateSession(previousSessionId);
    }
    this.runtimeAccountIdentities.invalidateSession(sessionId);
  }

  public unregisterPid(pidRaw: number): void {
    const pid = Math.trunc(Number(pidRaw));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const target = this.runtimeRegistry.getByPid(pid);
    if (target?.sessionId) {
      this.runtimeAccountIdentities.invalidateSession(target.sessionId);
    }
    this.runtimeRegistry.unregisterPid(pid);
  }

  public transferPid(fromPidRaw: number, toPidRaw: number): void {
    const fromPid = Math.trunc(Number(fromPidRaw));
    const toPid = Math.trunc(Number(toPidRaw));
    if (!Number.isFinite(fromPid) || fromPid <= 0 || !Number.isFinite(toPid) || toPid <= 0) return;
    const target = this.runtimeRegistry.getByPid(fromPid);
    if (!target) return;
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
    return this.recordRequestAuthProviderBackoffAtKey({
      key: this.makeBindingKey(input),
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      groupGeneration: input.groupGeneration,
      limitCategory: input.limitCategory,
      quotaScope: input.quotaScope,
      retryAfterMs: input.retryAfterMs,
      resetAtMs: input.resetAtMs,
      providerCode: input.providerCode,
    });
  }

  public recordQualifiedRequestAuthProviderBackoff(input: Readonly<{
    account: QualifiedConnectedAccountRef;
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
    return this.recordRequestAuthProviderBackoffAtKey({
      key: `qualified:${qualifiedAccountQuotaKey(input.account)}`,
      profileId: input.account.accountId,
      groupId: input.groupId,
      groupGeneration: input.groupGeneration,
      limitCategory: input.limitCategory,
      quotaScope: input.quotaScope,
      retryAfterMs: input.retryAfterMs,
      resetAtMs: input.resetAtMs,
      providerCode: input.providerCode,
    });
  }

  private recordRequestAuthProviderBackoffAtKey(input: Readonly<{
    key: string;
    serviceId?: ConnectedServiceId;
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
    this.applyFailureBackoff({
      now,
      key: input.key,
      error: {
        retryAfterMs: input.retryAfterMs,
        resetAtMs: input.resetAtMs,
      },
    });
    const state = this.failureStateByBindingKey.get(input.key);
    if (!state) {
      throw new Error('Connected Service request-auth backoff was not recorded');
    }
    const retryAfterMs = Math.max(0, state.nextAllowedAt - now);
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'probe_group',
      reason: 'request_auth_provider_backoff',
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
      ...(input.serviceId ? { serviceId: input.serviceId } : {}),
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

  public recordRuntimeProfileSnapshot(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    verifiedCredentialFingerprint?: string | null;
  }>): void {
    this.runtimeQuotaSnapshots?.recordProfileSnapshot(input);
  }

  private async readQualifiedGroupForServiceKey(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    signal?: AbortSignal;
  }>): Promise<ScalarQualifiedConnectedAccountGroup | null> {
    const runtime = this.qualifiedConnectedAccountRuntime;
    if (
      runtime?.resolvePeerClass() !== 'advertised_v4'
      || !runtime.readGroup
    ) {
      return null;
    }
    const service = parseQualifiedPluginContributionKey(input.serviceId);
    if (!service) return null;
    const groupId = input.groupId.trim();
    if (!groupId) return null;
    const group = await runtime.readGroup({
      service,
      groupId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      !group
      || group.ref.groupId !== groupId
      || !matchesQualifiedService(group.ref.service, service)
    ) {
      return null;
    }
    return { serviceId: input.serviceId, group };
  }

  private async clearPersistedMemberRuntimeBlockersWithQuotaEvidence(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    profileId: string;
    quotaEvidence: ConnectedServiceAuthGroupQuotaSnapshot | null;
    now: number;
    signal?: AbortSignal;
    authenticatedProbe?: boolean;
    groupContexts?: ReadonlyArray<ConnectedServiceQuotaGroupContext> | null;
    groupTargets?: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | null;
  }>): Promise<void> {
    const runtime = this.qualifiedConnectedAccountRuntime;
    if (
      runtime?.resolvePeerClass() !== 'advertised_v4'
      || !runtime.readGroup
      || !runtime.updateGroupRuntimeState
    ) return;

    const profileId = input.profileId.trim();
    if (!profileId) return;

    const contexts: ConnectedServiceQuotaGroupContext[] = [
      ...(input.groupContexts ?? []),
      ...(input.groupTargets ?? []).map((target) => ({
        groupId: target.groupId,
        groupGeneration: target.groupGeneration,
      })),
    ];
    const quotaEvidence = input.quotaEvidence;
    if (!quotaEvidence) return;
    const visited = new Set<string>();

    for (const context of contexts) {
      const groupId = context.groupId.trim();
      const expectedGeneration = normalizeNullableGeneration(context.groupGeneration);
      if (!groupId || expectedGeneration === null) continue;
      const visitKey = `${groupId}\u0000${expectedGeneration}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(input.serviceId);
      if (!service) continue;

      let clearedFields: string[] = [];
      await updateConnectedServiceAuthGroupRuntimeStateWithRetry<
        QualifiedConnectedAccountServiceRef,
        QualifiedConnectedAccountGroupV4,
        Readonly<{
          expectedIncarnation: string;
          runtimeState: Readonly<{
            memberStates: readonly Readonly<{
              connectedAccountId: string;
              state: ConnectedServiceAuthGroupMemberStateV1;
            }>[];
          }>;
        }>
      >({
        serviceId: service,
        groupId,
        expectedGeneration,
        loadGroup: async () => {
          input.signal?.throwIfAborted();
          const group = await runtime.readGroup!({
            service,
            groupId,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          input.signal?.throwIfAborted();
          return group && matchesQualifiedService(group.ref.service, service)
            && group.ref.groupId === groupId
            ? group
            : null;
        },
        buildPatch: (group) => {
          clearedFields = [];
          const member = group.members.find((candidate) => (
            candidate.connectedAccountId.trim() === profileId
          )) ?? null;
          if (!member) return null;
          const reconciled = reconcileMemberRuntimeStateWithFreshQuotaEvidence({
            state: member.state,
            quotaSnapshot: quotaEvidence,
            policy: group.policy,
            nowMs: input.now,
            authenticatedProbe:
              input.authenticatedProbe,
          });
          if (!reconciled || reconciled === member.state) return null;
          clearedFields = Object.keys(member.state).filter(key => !(key in reconciled));
          return {
            expectedIncarnation: group.incarnation,
            runtimeState: {
              memberStates: [{
                connectedAccountId: profileId,
                state: reconciled,
              }],
            },
          };
        },
        update: async (patch) => {
          input.signal?.throwIfAborted();
          const updated = await runtime.updateGroupRuntimeState!({
            service: patch.serviceId,
            groupId: patch.groupId,
            expectedGeneration: patch.expectedGeneration,
            expectedIncarnation: patch.expectedIncarnation,
            expectedRuntimeStateRevision:
              patch.expectedRuntimeStateRevision,
            runtimeState: patch.runtimeState,
          });
          logger.infoFile('[DAEMON RUN] Cleared connected-service auth-group member runtime blockers after positive evidence', {
            serviceId: input.serviceId, groupId, profileId, evidenceKind: 'fresh_quota',
            observedAtMs: input.now, clearedFields,
          });
          return updated;
        },
      }).catch(() => { input.signal?.throwIfAborted();
        logger.warn('[DAEMON RUN] Connected-service quota positive-evidence reconciliation failed', { serviceId: input.serviceId, groupId });
        return null;
      });
    }
  }

  private resolveCredentialOpenMaterial(): QuotaCredentialOpenMaterial | null {
    const encryption = this.credentials.encryption;
    if (!encryption) return null;
    return encryption.type === 'legacy'
      ? ({ type: 'legacy' as const, secret: encryption.secret })
      : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });
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
      const legacyServiceId = parsed.success
        ? resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
          parsed.data.serviceId,
        )
        : null;
      if (
        !parsed.success
        || !legacyServiceId
        || !this.quotaFetchersByServiceId.has(legacyServiceId)
        || !this.shouldRunLegacyQuotaFetcher(
          legacyServiceId,
          qualifiedPeerClass,
        )
      ) {
        ignored += 1;
        continue;
      }
      const key = parsed.data.bindingKind === 'profile'
        ? JSON.stringify([legacyServiceId, parsed.data.profileId, 'profile'])
        : JSON.stringify([
          legacyServiceId,
          parsed.data.profileId,
          'group_member',
          parsed.data.groupId,
          parsed.data.groupGeneration ?? null,
        ]);
      if (this.startupCurrentSourceRefreshByKey.has(key) || this.startupCurrentSourceRefreshByKey.size >= 256) {
        ignored += 1;
        continue;
      }
      this.startupCurrentSourceRefreshByKey.set(key, {
        ...parsed.data,
        serviceId: legacyServiceId,
      });
      accepted += 1;
    }
    return { accepted, ignored };
  }

  private buildRecoveryCreditConsumeLedgerKey(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
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

  private async joinRecoveryCreditConsume(input: RecoveryCreditConsumeInput,
    pending: RecoveryCreditConsumeInFlight, sameSelector: boolean): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult> {
    const result = await pending.promise;
    const callerTargets = !input.consumeRequest
      ? new Set(input.automaticResetContext?.providerLimitIds ?? []) : undefined;
    const pendingTargets = pending.automaticProviderLimitIds === undefined
      ? undefined : new Set(pending.automaticProviderLimitIds);
    const sameTargets = pendingTargets === undefined ? callerTargets === undefined
      : callerTargets !== undefined && pendingTargets.size === callerTargets.size
        && [...pendingTargets].every((target) => callerTargets.has(target));
    // A definitive refusal for another selector or target proves no debit.
    // Re-enter the same owner for this intent; spent or uncertain receipts stay shared.
    if ((!sameSelector || !sameTargets) && (result.receipt?.status === 'not_available'
      || result.receipt?.status === 'nothing_to_reset')) {
      return await this.consumeAvailableRecoveryCreditForProfile(input);
    }
    return result;
  }

  public async consumeAvailableRecoveryCreditForProfile(input: RecoveryCreditConsumeInput): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult> {
    const unavailable = (suffix: string): Extract<ConnectedServiceQuotaRecoveryCreditConsumeResult, { ok: false }> => ({
      ok: false,
      errorCode: `connected_service_quota_recovery_credit_${suffix}`,
      error: `connected_service_quota_recovery_credit_${suffix}`,
    });
    const service = parseQualifiedPluginContributionKey(input.serviceId);
    const profileId = readNonEmptyString(input.profileId);
    const runtime = this.qualifiedConnectedAccountRuntime;
    if (!service || !profileId || !runtime?.listAccounts) return unavailable('unavailable');
    const profileLedgerPrefix = `${input.serviceId}\u0000${profileId}\u0000`;
    // A changed quota timestamp cannot resolve an uncertain debit. Retain the
    // hold in the existing coordinator-lifetime receipt owner.
    for (const [key, result] of this.recoveryCreditConsumeResultsByKey) {
      if (key.startsWith(profileLedgerPrefix) && result.receipt?.status === 'unknown_after_timeout') return result;
    }
    if (input.consumeRequest) {
      const ledgerKey = this.buildRecoveryCreditConsumeLedgerKey({ ...input, ...input.consumeRequest });
      const completed = this.recoveryCreditConsumeResultsByKey.get(ledgerKey);
      if (completed) return completed;
      const inFlight = this.recoveryCreditConsumeInFlightByKey.get(ledgerKey);
      if (inFlight) return await this.joinRecoveryCreditConsume(input, inFlight, true);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingReceipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 | undefined;
    const timeout = new Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult>((resolve) => {
      if (this.fetchTimeoutMs === null) return;
      timer = setTimeout(() => {
        controller.abort('quota-recovery-credit-consume-timeout');
        resolve({ ...unavailable('timeout'), ...(pendingReceipt ? { receipt: pendingReceipt } : {}) });
      }, this.fetchTimeoutMs);
      timer.unref?.();
    });
    const operation = async (): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult> => {
      const profiles = await runtime.listAccounts!({ service, signal: controller.signal });
      controller.signal.throwIfAborted();
      const profile = profiles.find((candidate) => candidate.ref.accountId === profileId
        && matchesQualifiedService(candidate.ref.service, service));
      if (!profile || profile.revisionSemantics !== 'revisioned' || !profile.credentialRevision
        || !isConnectedServiceCredentialHealthStatusUsable(profile.status)
        || !this.shouldRunQualifiedQuotaOperation(profile, 'recovery_credit_consume')) return unavailable('unavailable');
      const observed = await runtime.establishedRuntimeOwner.invokeWithReceipt({
        account: profile.ref,
        operation: { kind: 'recoveryCredits.read' },
        expectedCredentialRevision: profile.credentialRevision,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!observed.result || !observed.basis.isCurrent()) return unavailable('unavailable');
      const credit = observed.result.credits.filter((candidate) => isConnectedServiceQuotaRecoveryCreditAvailable(candidate, this.now())
        && (!input.consumeRequest?.providerCreditId
          || candidate.providerCreditId === input.consumeRequest.providerCreditId))
        .sort((left, right) => (left.expiresAtMs ?? Infinity) - (right.expiresAtMs ?? Infinity)
          || left.providerCreditId.localeCompare(right.providerCreditId))[0];
      const creditUnavailable = !credit
        && (Boolean(input.consumeRequest?.providerCreditId) || observed.result.availableCount <= 0);
      if (creditUnavailable && !input.consumeRequest) return unavailable('not_available');
      // Inventory reads get a new observation time on every provider GET. The exhausted
      // quota observation, not that read time, identifies an aggregate reset attempt.
      const sourceSnapshot = this.accountUsageStore?.resolveBySource({
        serviceId: input.serviceId,
        profileId,
        bindingKind: 'profile',
      });
      const providerCreditId = credit?.providerCreditId ?? input.consumeRequest?.providerCreditId;
      const request = {
        idempotencyKey: input.consumeRequest?.idempotencyKey ?? buildRecoveryCreditConsumeIdempotencyKey({
          serviceId: input.serviceId,
          profileId,
          providerCreditId: credit?.providerCreditId,
          sourceSnapshotFetchedAtMs: sourceSnapshot?.fetchedAtMs,
        }),
        ...(providerCreditId ? { providerCreditId } : {}),
      };
      // A manual request retains its caller identity even when "use one" selected
      // a credit that no longer appears in the inventory on replay.
      const ledgerKey = this.buildRecoveryCreditConsumeLedgerKey({ ...input, profileId, ...request,
        ...(input.consumeRequest ? { providerCreditId: input.consumeRequest.providerCreditId } : {}),
      });
      // An aggregate choice overlaps any selected debit; distinct selected credits
      // remain independent while their acknowledgements are still pending.
      const selectedCreditId = input.consumeRequest ? input.consumeRequest.providerCreditId : providerCreditId;
      const selectedLedgerPrefix = `${profileLedgerPrefix}${selectedCreditId ?? ''}\u0000`;
      const aggregateLedgerPrefix = `${profileLedgerPrefix}\u0000`;
      for (const [key, pending] of this.recoveryCreditConsumeInFlightByKey) {
        if (key.startsWith(profileLedgerPrefix)
          && (!selectedCreditId || key.startsWith(selectedLedgerPrefix) || key.startsWith(aggregateLedgerPrefix))) {
          return await this.joinRecoveryCreditConsume(input, pending, key.startsWith(selectedLedgerPrefix));
        }
      }
      for (const [key, result] of this.recoveryCreditConsumeResultsByKey) {
        if (key.startsWith(profileLedgerPrefix) && result.receipt?.status === 'unknown_after_timeout') return result;
      }
      const completed = this.recoveryCreditConsumeResultsByKey.get(ledgerKey);
      if (completed) return completed;
      const inFlight = this.recoveryCreditConsumeInFlightByKey.get(ledgerKey);
      if (inFlight) return await this.joinRecoveryCreditConsume(input, inFlight, true);
      if (creditUnavailable) {
        const result = {
          ...unavailable('not_available'),
          ...(input.consumeRequest ? { receipt: { ...input.consumeRequest, status: 'not_available' as const } } : {}),
        };
        if (result.receipt) this.recoveryCreditConsumeResultsByKey.set(ledgerKey, result);
        return result;
      }
      const consume = async (): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult> => {
        let receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 | undefined;
        try {
          const accountMode = await resolveConnectedServiceAccountMode(this.api);
          controller.signal.throwIfAborted();
          if (accountMode === 'unknown') return unavailable('account_mode_unknown');
          pendingReceipt = { ...request, status: 'unknown_after_timeout' };
          const consumed = await runtime.establishedRuntimeOwner.invokeWithReceipt({
            account: profile.ref,
            operation: { kind: 'recoveryCredits.consume', request: {
              ...request,
              ...(!input.consumeRequest ? { providerLimitIds: input.automaticResetContext?.providerLimitIds ?? [] } : {}),
            } },
            expectedCredentialRevision: observed.basis.credentialRevision,
            assertEffectfulOperationAllowed: () => {
              controller.signal.throwIfAborted();
              if (!observed.basis.isCurrent()
                || !this.shouldRunQualifiedQuotaOperation(profile, 'recovery_credit_consume')) {
                throw new Error('connected_service_quota_recovery_credit_stale_basis');
              }
            },
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          if (!consumed.result) return unavailable('unavailable');
          receipt = { ...request, status: consumed.result.status };
          pendingReceipt = receipt;
          if (receipt.status === 'consumed' && input.automaticResetContext && this.onAutomaticQuotaResetConsumed) {
            const notification = { ...input.automaticResetContext, serviceId: input.serviceId, profileId, receipt };
            void Promise.resolve().then(() => this.onAutomaticQuotaResetConsumed?.(notification)).catch((error) => {
              logger.info('[ConnectedServiceQuotas] automatic quota reset notification failed', error);
            });
          }
          if (!consumed.basis.isCurrent()) return { ...unavailable('stale_basis'), receipt };
          const refreshed = await this.invokeQualifiedAccountQuota({
            profile, accountMode,
            expectedCredentialRevision: consumed.basis.credentialRevision,
            afterConfirmedReset: receipt.status === 'consumed' || receipt.status === 'already_consumed',
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          if (!refreshed?.result || !refreshed.basis.isCurrent()) return { ...unavailable('refresh_unavailable'), receipt };
          const snapshot = buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota({
            profile: refreshed.profile, quota: refreshed.result, staleAfterMs: this.polledQuotaStaleAfterMs,
            usageIdentity: refreshed.usageIdentity,
          });
          if (!await this.persistQualifiedConnectedAccountQuota({ accountMode, profile, snapshot, basis: refreshed.basis })) {
            return { ...unavailable('refresh_unavailable'), receipt };
          }
          controller.signal.throwIfAborted();
          const groupIds = new Set<string>(input.groupId ? [input.groupId] : []);
          for (const target of this.runtimeRegistry.listQuotaTargets()) {
            for (const binding of extractActiveBindings(target)) {
              if (binding.serviceId === input.serviceId && binding.groupId) groupIds.add(binding.groupId);
            }
          }
          const groupContexts: ConnectedServiceQuotaGroupContext[] = [];
          if (runtime.listGroupQuotaTargets) {
            for (const groupId of groupIds) {
              const targets = await runtime.listGroupQuotaTargets({ service, groupId, accountIds: [profileId], signal: controller.signal });
              controller.signal.throwIfAborted();
              const target = targets.find((candidate) => candidate.profile.ref.accountId === profileId
                && matchesQualifiedService(candidate.profile.ref.service, service)
                && candidate.profile.credentialRevision === refreshed.basis.credentialRevision);
              if (target) groupContexts.push({ groupId, groupGeneration: target.groupGeneration });
            }
          }
          if (!refreshed.basis.isCurrent()) return { ...unavailable('stale_basis'), receipt };
          if (input.groupId && !groupContexts.some((context) => context.groupId === input.groupId)) {
            return { ...unavailable('refresh_unavailable'), receipt };
          }
          await this.recordQualifiedPolledAccountUsageLocally({
            profile: refreshed.profile, snapshot,
            sourceProviderAccountId: refreshed.profile.providerIdentity?.accountId?.trim() ?? '',
            groupContexts, qualifiedGroupTargets: [], switchEvaluationTargets: [], emitLiveLifecycle: true,
          });
          if (receipt.status !== 'consumed' && receipt.status !== 'already_consumed') {
            return { ...unavailable(receipt.status), receipt };
          }
          return { ok: true, snapshot: null, receipt };
        } catch (error) {
          // Older plugins omit the marker, so retain their conservative uncertainty.
          // Only the provider's explicit pre-effect failure can release the hold.
          if (!receipt && error && typeof error === 'object'
            && 'recoveryCreditConsumeOutcomeUnknown' in error
            && error.recoveryCreditConsumeOutcomeUnknown === false) pendingReceipt = undefined;
          return {
            ...unavailable('failed'),
            error: error instanceof Error ? error.message : 'connected_service_quota_recovery_credit_failed',
            ...(receipt ?? pendingReceipt ? { receipt: receipt ?? pendingReceipt } : {}),
          };
        }
      };
      const promise = Promise.race([consume(), timeout]);
      this.recoveryCreditConsumeInFlightByKey.set(ledgerKey, {
        promise,
        automaticProviderLimitIds: !input.consumeRequest
          ? [...(input.automaticResetContext?.providerLimitIds ?? [])] : undefined,
      });
      try {
        const result = await promise;
        const automaticNoEffect = !input.consumeRequest
          && (result.receipt?.status === 'not_available' || result.receipt?.status === 'nothing_to_reset');
        if (result.receipt && !automaticNoEffect) this.recoveryCreditConsumeResultsByKey.set(ledgerKey, result);
        return result;
      } finally {
        this.recoveryCreditConsumeInFlightByKey.delete(ledgerKey);
      }
    };
    try {
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      return { ...unavailable('failed'), error: error instanceof Error ? error.message : 'connected_service_quota_recovery_credit_failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  public async consumeRecoveryCreditForProfile(input: Readonly<{
    serviceId: ConnectedAccountServiceKey | ConnectedServiceId;
    profileId: string;
    idempotencyKey: string;
    providerCreditId?: string;
  }>): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult> {
    const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(input.serviceId);
    if (!service) {
      return {
        ok: false,
        errorCode: 'connected_service_quota_recovery_credit_unavailable',
        error: 'connected_service_quota_recovery_credit_unavailable',
      };
    }
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
    const qualifiedServiceId: ConnectedAccountServiceKey = buildQualifiedPluginContributionKey(service);
    return await this.consumeAvailableRecoveryCreditForProfile({
      serviceId: qualifiedServiceId,
      profileId,
      consumeRequest: { idempotencyKey, ...(providerCreditId ? { providerCreditId } : {}) },
    });
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
    serviceId: ConnectedAccountServiceKey;
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
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
  }>): number | null {
    const target = this.findSpawnTargetForSession(input.sessionId);
    if (!target) return null;
    const binding = target.activeBindings.find((candidate) => (
      candidate.serviceId === input.serviceId && candidate.groupId === input.groupId
    ));
    return normalizeNullableGeneration(binding?.groupGeneration);
  }

  private buildCurrentGroupGenerationBySessionId(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
  }>): Map<string, number | null> {
    const generations = new Map<string, number | null>();
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
      if (!sessionId) continue;
      const binding = target.activeBindings.find((candidate) => (
        candidate.serviceId === input.serviceId && candidate.groupId === input.groupId
      ));
      generations.set(sessionId, normalizeNullableGeneration(binding?.groupGeneration));
    }
    return generations;
  }

  private hasActiveSpawnTargetForIdentity(entry: RuntimeAccountIdentityEntry): boolean {
    const target = this.findSpawnTargetForSession(entry.sessionId);
    if (!target) return false;
    const bindings = extractActiveBindings(target);
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
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
  }>): ActiveSameAccountFanoutCandidate[] {
    const candidates: ActiveSameAccountFanoutCandidate[] = [];
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = readNonEmptyString(target.sessionId);
      if (!sessionId || sessionId === input.sourceSessionId) continue;
      const binding = target.activeBindings.find((candidate) => (
        candidate.serviceId === input.serviceId && candidate.groupId === input.groupId
      ));
      if (!binding) continue;
      const activeProfileId = readNonEmptyString(binding.profileId);
      if (!activeProfileId) continue;
      candidates.push({
        sessionId,
        serviceId: input.serviceId,
        groupId: input.groupId,
        activeProfileId,
        ...(target.agentId ? { agentId: target.agentId } : {}),
        groupGeneration: normalizeNullableGeneration(binding.groupGeneration),
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
    return {
      candidate: input.candidate,
      accountLabel: match.accountLabel,
      observedProfileId: match.observedProfileId,
    };
  }

  private async resolveSameAccountFanoutCandidates(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    strategy: ConnectedServiceSameAccountFanoutStrategy;
    providerAccountId?: string | null;
    sourceGroupGeneration?: number | null;
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
    }).filter((candidate) => {
      if (indexedSessionIds.has(candidate.sessionId)) return false;
      if (input.strategy !== 'shared_group_auth_surface') return true;
      const sourceGeneration = normalizeNullableGeneration(input.sourceGroupGeneration)
        ?? currentGroupGenerationBySessionId.get(input.sourceSessionId)
        ?? null;
      const candidateGeneration = normalizeNullableGeneration(candidate.groupGeneration);
      const reason = sourceGeneration === null || candidateGeneration === null
        ? 'registry_binding_missing_group_generation'
        : candidateGeneration !== sourceGeneration ? 'registry_binding_group_generation_mismatch' : null;
      if (!reason) return true;
      this.recordSameAccountFanoutDiagnostic(reason, 'quota_work_suppressed', undefined, {
        sessionId: candidate.sessionId,
        expectedProfileId: candidate.activeProfileId,
        actualProfileId: candidate.activeProfileId,
        expectedGroupId: input.groupId,
        actualGroupId: candidate.groupId,
        expectedGroupGeneration: sourceGeneration,
        actualGroupGeneration: candidateGeneration,
      });
      return false;
    });
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
    serviceId: ConnectedAccountServiceKey;
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
    // Identity index entries are keyed by the canonical qualified service key: every consumer
    // (fanout lookup, spawn-target binding match, persisted reconciliation) projects ingress
    // through the canonical key, so a released scalar ingress must be canonicalized here at the
    // single record owner instead of storing a second, scalar-keyed identity family.
    const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(
      input.serviceId,
    );
    return this.runtimeAccountIdentities.record({
      ...input,
      serviceId: service
        ? buildQualifiedPluginContributionKey(service)
        : input.serviceId,
    });
  }

  public invalidateRuntimeAccountIdentityForSession(sessionId: string): void {
    this.runtimeAccountIdentities.invalidateSession(sessionId);
  }

  public async recordAccountExhaustionAndFanout(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedAccountServiceKey;
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
    const authGroupSwitchCoordinator = this.authGroupSwitchCoordinator;
    if (!authGroupSwitchCoordinator) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const sourceSessionId = typeof input.sourceSessionId === 'string' ? input.sourceSessionId.trim() : '';
    const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(input.serviceId);
    const groupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    const providerAccountId = typeof input.providerAccountId === 'string' ? input.providerAccountId.trim() : '';
    if (!serviceId || !sourceSessionId || !groupId) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const committedGeneration = input.committedGeneration ?? null;
    if (
      committedGeneration?.decisionCommittedTarget.serviceId !== serviceId
      || committedGeneration.decisionCommittedTarget.groupId !== groupId
    ) {
      this.recordSameAccountFanoutDiagnostic('hard_limit_committed_generation_missing');
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const generationTargets = this.listCommittedGenerationTargetsForGroup({
      serviceId,
      groupId,
      sourceSessionId,
      sourceProfileId: input.exhaustedProfileId,
      includeSource: input.sourceRequiresConvergence !== false,
    });
    const applyCommittedGeneration = async (): Promise<number> => await this.applyCommittedAuthGroupGeneration({
      committedGeneration,
      reason: 'same_provider_account_exhausted',
      targets: generationTargets,
    });
    const strategy = input.resolvedFanoutStrategy ?? await this.resolveSameAccountFanoutStrategy({
      sourceSessionId,
      serviceId,
      groupId,
    });
    if (strategy === 'none') {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: await applyCommittedGeneration() };
    }
    if (strategy === 'provider_account_id' && !providerAccountId) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: await applyCommittedGeneration() };
    }

    const candidates = await this.resolveSameAccountFanoutCandidates({
      sourceSessionId,
      serviceId,
      groupId,
      strategy,
      providerAccountId,
      sourceGroupGeneration: input.sourceGroupGeneration,
    });
    if (candidates.length === 0) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: await applyCommittedGeneration() };
    }

    const now = Math.max(0, Math.trunc(this.now()));
    const fanoutKey = this.makeSameAccountFanoutKey({
      serviceId,
      groupId,
      providerAccountId: strategy === 'provider_account_id'
        ? providerAccountId
        : `shared_group_auth_surface:${groupId}`,
      resetAtMs: input.resetAtMs,
    });
    if (this.shouldCoalesceSameAccountFanout({ key: fanoutKey, now })) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: await applyCommittedGeneration() };
    }

    for (const { candidate } of candidates) {
      this.runtimeAccountIdentities.invalidateSession(candidate.sessionId);
    }
    const fanoutRequests = await applyCommittedGeneration();
    return {
      status: 'recorded',
      fanoutCandidates: candidates.length,
      fanoutRequests,
    };
  }

  private listCommittedGenerationTargetsForGroup(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    sourceSessionId: string;
    sourceProfileId: string;
    includeSource: boolean;
  }>): ReadonlyArray<Readonly<{
    sessionId: string;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    fromProfileId: string;
  }>> {
    const targetsBySessionId = new Map<string, Readonly<{
      sessionId: string;
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
      fromProfileId: string;
    }>>();
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = target.sessionId?.trim() ?? '';
      if (!sessionId) continue;
      const binding = target.activeBindings.find((candidate) => (
        candidate.serviceId === input.serviceId && candidate.groupId === input.groupId
      ));
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
    } else if (!input.includeSource) {
      targetsBySessionId.delete(input.sourceSessionId);
    }
    return Array.from(targetsBySessionId.values());
  }

  private async decideAndApplyAuthGroupGeneration(input: Readonly<{
    signal?: AbortSignal;
    reason: 'soft_threshold';
    observedProfileId: string;
    targets: ReadonlyArray<Readonly<{
      sessionId: string;
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
      fromProfileId: string;
    }>>;
  }>): Promise<number> {
    const coordinator = this.authGroupSwitchCoordinator;
    const decisionTarget = input.targets[0];
    if (!coordinator || !decisionTarget) return 0;
    const rawDecision = await coordinator.switchBeforeTurn({
      signal: input.signal,
      sessionId: decisionTarget.sessionId,
      serviceId: decisionTarget.serviceId,
      groupId: decisionTarget.groupId,
      reason: input.reason,
      observedProfileId: input.observedProfileId,
    }).catch(() => {
      input.signal?.throwIfAborted();
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed', phase: 'soft_switch', reason: 'soft_switch_request_failed',
        sessionId: decisionTarget.sessionId, serviceId: decisionTarget.serviceId,
        groupId: decisionTarget.groupId, activeProfileId: input.observedProfileId,
      });
      return null;
    });
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
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
      fromProfileId: string;
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
    serviceId: ConnectedAccountServiceKey;
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
    const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(input.serviceId);
    const groupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    const exhaustedProfileId = typeof input.exhaustedProfileId === 'string' ? input.exhaustedProfileId.trim() : '';
    if (!serviceId || !sourceSessionId || !groupId || !exhaustedProfileId) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }

    const strategy = await this.resolveSameAccountFanoutStrategy({
      sourceSessionId,
      serviceId,
      groupId,
    });
    if (strategy === 'shared_group_auth_surface') {
      return await this.recordAccountExhaustionAndFanout({
        sourceSessionId,
        serviceId,
        groupId,
        exhaustedProfileId,
        sourceGroupGeneration: input.sourceGroupGeneration,
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
      return await this.recordAccountExhaustionAndFanout({
        sourceSessionId,
        serviceId,
        groupId,
        exhaustedProfileId,
        resetAtMs: input.resetAtMs,
        reason: 'usage_limit',
        committedGeneration: input.committedGeneration,
        sourceRequiresConvergence: input.sourceRequiresConvergence,
        resolvedFanoutStrategy: strategy,
      });
    }
    const sourceGroupGeneration = normalizeNullableGeneration(input.sourceGroupGeneration)
      ?? this.resolveGroupGenerationForSession({
        sessionId: sourceSessionId,
        serviceId,
        groupId,
      });
    this.runtimeAccountIdentities.record({
      sessionId: sourceSessionId,
      serviceId,
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
      serviceId,
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
  }>): QuotaProbeFreshProofResult {
    return resolveQuotaProbeFreshProof({
      nowMs: this.now(),
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
    group: ScalarQualifiedConnectedAccountGroup;
  }>): ConnectedServiceAccountUsageSwitchState | null {
    if (!this.accountUsageStore) return null;
    return buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group: scalarQualifiedGroupAccountUsageView(input.group),
      accountUsageStore: this.accountUsageStore,
    })?.state ?? null;
  }

  private async resolveSoftSwitchTargetEligibility(input: Readonly<{
    signal?: AbortSignal;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
  }>): Promise<GroupSwitchTargetEligibility> {
    const scalarGroup = await this.readQualifiedGroupForServiceKey({
      signal: input.signal,
      serviceId: input.serviceId,
      groupId: input.groupId,
    }).catch(error => { input.signal?.throwIfAborted(); return null; });
    input.signal?.throwIfAborted();
    if (!scalarGroup) {
      return { status: 'unknown', reason: 'group_resolution_failed' };
    }

    const now = this.now();
    const switchState = this.accountUsageStore
      ? this.buildSwitchStateFromAccountUsage({ group: scalarGroup })
      : null;
    if (!switchState) {
      return { status: 'unknown', reason: 'source_account_usage_unavailable' };
    }
    const activeProfileId = switchState.activeProfileId;
      const sourceEvidence = resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
        activeProfileId,
        policy: switchState.policy,
        memberStatesByProfileId: switchState.memberStatesByProfileId,
        nowMs: now,
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
      const selection = selectConnectedServiceAuthGroupCandidate({ ...switchState,
        requiredModelIds: this.resolveRequiredModelIds?.(input), nowMs: now, reason: 'soft_threshold',
      });
      if (!selection.selected) return { status: 'no_meaningfully_better_target', retryAfterMs: null,
        decisionTrace: selection.decisionTrace };
      if (sourceEvidence.status === 'above_threshold') {
        const primaryProfileId = switchState.policy.strategy === 'priority'
          && switchState.policy.autoRestorePrimaryWhenReset
          ? resolveConnectedServiceAuthGroupPriorityPrimaryProfileId(switchState.members)
          : null;
        if (primaryProfileId && primaryProfileId !== activeProfileId && selection.selected.profileId === primaryProfileId) {
          // Above-threshold backups normally need no soft switch. Primary restoration is the
          // explicit exception: let the canonical selector decide from its existing reset and
          // headroom evidence instead of duplicating that decision in this intake gate.
          return {
            status: 'eligible',
            sourceProfileId: activeProfileId,
            sourceRemainingPercent: sourceEvidence.remainingPercent,
            sourceThresholdPercent: sourceEvidence.thresholdPercent,
            decisionTrace: selection.decisionTrace,
          };
        }
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
        decisionTrace: selection.decisionTrace,
      };
  }

  private async shouldRunSoftSwitchForTarget(target: ActiveGroupQuotaSwitchTarget, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const guard = this.predictiveSwitchGuard;
    if (!guard) return true;
    let result: PredictiveSwitchGuardResult;
    try {
      result = await guard({
        signal,
        sessionId: target.sessionId,
        serviceId: target.serviceId,
        groupId: target.groupId,
        activeProfileId: target.activeProfileId,
        reason: 'soft_threshold',
      });
    } catch {
      signal?.throwIfAborted();
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'soft_switch',
        reason: 'quota_predictive_switch_policy_failed',
      });
      return false;
    }
    signal?.throwIfAborted();
    if (result.status === 'allow') return true;
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: result.reason.trim() || 'quota_predictive_switch_suppressed',
    });
    return false;
  }

  private resolveActiveSessionIdsForGroup(serviceId: ConnectedAccountServiceKey, groupId: string): string[] {
    const sessionIds: string[] = [];
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
      if (!sessionId || sessionIds.includes(sessionId)) continue;
      for (const entry of extractActiveBindings(target)) {
        if (entry.serviceId !== serviceId) continue;
        if ((entry.groupId ?? '') !== groupId) continue;
        sessionIds.push(sessionId);
        break;
      }
    }
    return sessionIds;
  }

  private async evaluateGroupQuotaLifecycle(input: Readonly<{
    group: ScalarQualifiedConnectedAccountGroup;
    changedProfileId?: string;
    now: number;
  }>): Promise<void> {
    const group = scalarQualifiedGroupAccountUsageView(input.group);
    const evaluation = this.evaluateGroupQuotaLifecycleFromAccountUsage({
      mode: 'cold_reconstruction',
      group: input.group,
      changedProfileId: input.changedProfileId ?? group.activeProfileId ?? '',
      changedGroupGeneration: group.generation,
      now: input.now,
    });
    this.recordQuotaLifecycleEvaluationState({
      serviceId: group.serviceId,
      groupId: group.groupId,
      nextState: evaluation.nextState,
    });
  }

  private async evaluateGroupQuotaLifecycleForGroup(input: Readonly<{
    signal?: AbortSignal;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    changedProfileId?: string;
    now: number;
  }>): Promise<void> {
    if (!this.onQuotaLifecycleTransition) return;
    const group = await this.readQualifiedGroupForServiceKey({
      signal: input.signal,
      serviceId: input.serviceId,
      groupId: input.groupId,
    }).catch(error => { input.signal?.throwIfAborted(); return null; });
    input.signal?.throwIfAborted();
    if (!group) return;
    await this.evaluateGroupQuotaLifecycle({
      group,
      ...(input.changedProfileId ? { changedProfileId: input.changedProfileId } : {}),
      now: input.now,
    });
  }

  private async evaluateGroupQuotaLifecycleForTargets(input: Readonly<{
    signal?: AbortSignal;
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
        signal: input.signal,
        serviceId: target.serviceId,
        groupId: target.groupId,
        now: input.now,
      }),
    ));
  }

  private makeQuotaLifecycleGroupKey(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
  }>): string {
    return `${input.serviceId}\u0000${input.groupId}`;
  }

  private readQuotaLifecycleState(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
  }>): ConnectedServiceAuthGroupQuotaLifecycleState {
    return this.quotaLifecycleStateByGroupKey.get(this.makeQuotaLifecycleGroupKey(input)) ?? { status: 'unblocked' };
  }

  private recordQuotaLifecycleEvaluationState(input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
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
    group: ScalarQualifiedConnectedAccountGroup;
    changedProfileId?: string | null;
    changedSnapshot?: ProviderAccountUsageSnapshotV1 | null;
    changedGroupGeneration?: number | null;
  }>): Map<string, ProviderAccountUsageSnapshotV1> {
    if (!this.accountUsageStore) return new Map();
    return resolveAccountUsageSnapshotsByGroupProfile({
      group: scalarQualifiedGroupAccountUsageView(input.group),
      ...(input.changedProfileId === undefined
        ? {}
        : { changedProfileId: input.changedProfileId }),
      ...(input.changedSnapshot === undefined
        ? {}
        : { changedSnapshot: input.changedSnapshot }),
      ...(input.changedGroupGeneration === undefined
        ? {}
        : { changedGroupGeneration: input.changedGroupGeneration }),
      accountUsageStore: this.accountUsageStore,
    });
  }

  private evaluateGroupQuotaLifecycleFromAccountUsage(input: Readonly<{
    mode: 'live_account_usage_change' | 'cold_reconstruction';
    group: ScalarQualifiedConnectedAccountGroup;
    changedProfileId: string;
    changedGroupGeneration: number;
    changedSnapshot?: ProviderAccountUsageSnapshotV1 | null;
    now: number;
  }>) {
    const group = scalarQualifiedGroupAccountUsageView(input.group);
    const snapshotsByProfileId = this.buildAccountUsageSnapshotsByGroupProfile({
      group: input.group,
      changedProfileId: input.changedProfileId,
      changedSnapshot: input.changedSnapshot ?? null,
    });
    return evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: input.mode,
      group,
      changedProfileId: input.changedProfileId,
      changedGroupGeneration: input.changedGroupGeneration,
      previousState: this.readQuotaLifecycleState({
        serviceId: group.serviceId,
        groupId: group.groupId,
      }),
      snapshotsByProfileId,
      activeSessionIds: this.resolveActiveSessionIdsForGroup(
        group.serviceId,
        group.groupId,
      ),
      nowMs: input.now,
    });
  }

  private async maybeRequestActiveGroupSwitchForSnapshot(input: Readonly<{
    signal?: AbortSignal;
    now: number;
    targets: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | undefined;
  }>): Promise<void> {
    input.signal?.throwIfAborted();
    await this.evaluateGroupQuotaLifecycleForTargets(input);
    input.signal?.throwIfAborted();

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
        signal: input.signal,
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
        if (await this.shouldRunSoftSwitchForTarget(target, input.signal)) {
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
        signal: input.signal,
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

  private applyFailureBackoff(params: Readonly<{ now: number; key: string; error?: unknown }>): void {
    const existing = this.failureStateByBindingKey.get(params.key);
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
    const providerRetryMs = resolveQuotaFetchFailureBackoffMs({
      error: params.error,
      now: params.now,
    });
    this.failureStateByBindingKey.set(params.key, {
      consecutiveFailures,
      nextAllowedAt: params.now + (providerRetryMs ?? this.probeIntervalMs),
      providerDirected: providerRetryMs !== null || (isRecord(params.error) && (params.error.status === 429 || params.error.quotaFetchErrorCode === 'provider_backoff')),
    });
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
    signal?: AbortSignal;
    sessionId: string;
    serviceId: ConnectedAccountServiceKey;
    profileId: string;
    groupId: string;
    groupGeneration: number;
    recordId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
    source?: 'poll' | 'in_band' | 'evidence_only';
  }>): Promise<void> {
    void input.recordId;
    const listener = this.onQuotaLifecycleTransition;
    if (!this.accountUsageStore) return;
    const groupId = input.groupId.trim();
    if (!groupId) return;
    const group = await this.readQualifiedGroupForServiceKey({
      signal: input.signal,
      serviceId: input.serviceId,
      groupId,
    }).catch(() => {
      input.signal?.throwIfAborted();
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed', phase: 'soft_switch', reason: 'soft_switch_group_read_failed',
        sessionId: input.sessionId, serviceId: input.serviceId, groupId,
      });
      return null;
    });
    input.signal?.throwIfAborted();
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
        await listener(evaluation.edge, input.signal);
        input.signal?.throwIfAborted();
      }
    }

    // A genuine in-band usage change evaluates measured quota through the same selector
    // as the poll. Poll and post-failure evidence reads already have their recovery owner;
    // they must not request a second switch here.
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
        signal: input.signal,
        now: this.now(),
        targets: [{
          sessionId: changedSessionId,
          serviceId: input.serviceId,
          groupId,
          activeProfileId: changedProfileId,
          groupGeneration: input.groupGeneration,
        }],
      }).catch(() => {
        input.signal?.throwIfAborted();
        this.recordDiagnostic?.({
          event: 'quota_work_suppressed', phase: 'soft_switch', reason: 'soft_switch_evaluation_failed',
          sessionId: changedSessionId, serviceId: input.serviceId, groupId, activeProfileId: changedProfileId,
        });
      });
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
    providerAccountUsageSnapshot?: ProviderAccountUsageSnapshotV1;
    materialFingerprint?: string;
  }>): Promise<void> {
    const profile = await this.resolveQualifiedProfileForScalarQuotaPersistence({
      serviceId: input.serviceId,
      profileId: input.profileId,
    });
    const incomingSnapshot = input.providerAccountUsageSnapshot
      ?? buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
        snapshot: input.snapshot,
        observedAtMs: input.snapshot.fetchedAtMs ?? input.snapshot.fetchedAt,
      });
    const subscription = mergeProviderAccountSubscription(
      this.accountUsageStore?.resolveRecordId(incomingSnapshot.recordId)?.subscription,
      incomingSnapshot.subscription,
    );
    const providerAccountUsageSnapshot = subscription
      ? { ...incomingSnapshot, subscription }
      : incomingSnapshot;
    const materialFingerprint = input.materialFingerprint
      ?? computeProviderAccountUsageSnapshotFingerprint(
        providerAccountUsageSnapshot,
        this.quotaSnapshotFingerprintKey,
      );
    const write = {
      source: {
        ref: profile.ref,
        bindingKind: 'account' as const,
      },
      expectedCredentialRevision: profile.credentialRevision,
      expectedConfigurationRevision: profile.configurationRevision,
      recordId: providerAccountUsageSnapshot.recordId,
      recordKey: providerAccountUsageSnapshot.recordKey,
      payloadMode: input.accountMode === 'plain'
        ? 'plain_json_v1' as const
        : 'sealed_account_scoped_v1' as const,
      status: deriveQuotaSnapshotStatus(input.snapshot),
      ...(input.accountMode === 'plain'
        ? { snapshot: providerAccountUsageSnapshot }
        : {
            sealedPayload: sealProviderAccountUsageSnapshot({
              material: requireQuotaCredentialOpenMaterial(
                this.resolveCredentialOpenMaterial(),
              ),
              snapshot: providerAccountUsageSnapshot,
              randomBytes: this.randomBytes,
            }),
          }),
      fetchedAt: providerAccountUsageSnapshot.fetchedAtMs,
      staleAfterMs: providerAccountUsageSnapshot.staleAfterMs,
      metadata: { materialFingerprint },
    };
    const key = `qualified-connected-account-pau:${qualifiedAccountQuotaKey(profile.ref)}`;
    const outcome = await this.serverWorkScheduler.enqueue({
      key,
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      payload: write,
      payloadBytes: Buffer.byteLength(JSON.stringify(write), 'utf8'),
      run: async (payload) => {
        // The queued payload may be a canonical V4 PAU write, but it was produced under legacy
        // fetch authority. Recheck currentness against the LIVE peer class immediately before
        // resolving the qualified writer: once the peer flips to advertised V4, this queued
        // write must not land. A plain protocol error classifies as nonretryable.
        if (!this.shouldRunLegacyQuotaFetcher(
          input.serviceId,
          this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null,
          'provider_account_usage_write',
        )) {
          throw new Error(
            'Queued provider-account usage write is stale for the legacy transport',
          );
        }
        const writeProviderAccountUsage =
          this.qualifiedConnectedAccountRuntime?.writeProviderAccountUsage
          ?? writeQualifiedProviderAccountUsageV4;
        await persistProviderAccountUsageWithDaySummaries({
          writer: writeProviderAccountUsage,
          nowMs: this.now(), randomBytes: this.randomBytes,
          token: this.credentials.token,
          write: payload,
          ...(input.accountMode === 'e2ee' ? { material: requireQuotaCredentialOpenMaterial(this.resolveCredentialOpenMaterial()) } : {}),
        });
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

  private async resolveQualifiedProfileForScalarQuotaPersistence(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<QualifiedConnectedAccountProfileV4> {
    const runtime = this.qualifiedConnectedAccountRuntime;
    const service =
      resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput(
        input.serviceId,
      );
    if (!runtime?.listAccounts || !service) {
      throw new Error('Qualified provider-account usage persistence target is unavailable');
    }
    const profiles = await runtime.listAccounts({ service });
    const profile = profiles.find((candidate) => (
      candidate.ref.accountId === input.profileId
      && matchesQualifiedService(candidate.ref.service, service)
    ));
    if (
      !profile
      || profile.revisionSemantics !== 'revisioned'
      || profile.credentialRevision === null
    ) {
      throw new Error('Qualified provider-account usage persistence target is not current');
    }
    return profile;
  }

  /** Merge accepted Home observations through the usage store's recency owner; no provider or credential work. */
  public async hydrateQualifiedGroupQuotaSnapshots(input: Readonly<{
    signal?: AbortSignal;
    group: QualifiedConnectedAccountGroupV4;
    profiles: readonly QualifiedConnectedAccountProfileV4[];
  }>): Promise<void> {
    const store = this.accountUsageStore;
    if (!store || this.qualifiedConnectedAccountRuntime?.resolvePeerClass() !== 'advertised_v4') return;
    const serviceId = buildQualifiedPluginContributionKey(input.group.ref.service);
    const profilesById = new Map(input.profiles.map(profile => [profile.ref.accountId, profile]));
    await Promise.all(input.group.members.filter(member => member.enabled).map(async member => {
      const profile = profilesById.get(member.connectedAccountId);
      if (!profile || !isConnectedServiceCredentialHealthStatusUsable(profile.status)) return;
      try {
        const usageIdentity = await this.qualifiedConnectedAccountRuntime?.resolveUsageIdentity?.(profile.ref.service, input.signal);
        input.signal?.throwIfAborted();
        const { response, snapshot } = await this.readStoredQualifiedAccountQuota(profile, usageIdentity, input.signal);
        if (!response || !snapshot) return;
        await this.recordQualifiedPolledAccountUsageLocally({
          signal: input.signal, profile, snapshot: buildProviderAccountUsageSnapshotFromQualifiedQuotaRow({ ref: profile.ref, quota: snapshot }),
          sourceProviderAccountId: response.sourceResolution.providerAccountId,
          groupContexts: [{ groupId: input.group.ref.groupId, groupGeneration: input.group.generation }],
          qualifiedGroupTargets: [], switchEvaluationTargets: [], emitLiveLifecycle: false,
        });
      } catch {
        input.signal?.throwIfAborted();
        logger.info('[ConnectedServices] Accepted pool quota unavailable', { code: 'quota_observation_unavailable', serviceId, profileId: member.connectedAccountId });
      }
    }));
  }

  public async probeGroupQuotaSnapshots(input: Readonly<{
    signal?: AbortSignal;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    profileIds: ReadonlyArray<string>;
  }>): Promise<ConnectedServiceAuthGroupQuotaProbeResult> {
    input.signal?.throwIfAborted();
    const serviceId = input.serviceId;
    const groupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    const profileIds = Array.from(new Set(input.profileIds
      .map((profileId) => String(profileId ?? '').trim())
      .filter((profileId) => profileId.length > 0)));
    let retryAtMs: number | undefined;
    const deferredProfiles = new Map<string, number>();
    const retainRetryBoundary = (profile: QualifiedConnectedAccountProfileV4): void => {
      const failure = this.failureStateByBindingKey.get(`qualified:${qualifiedAccountQuotaKey(profile.ref)}`);
      const boundary = failure?.nextAllowedAt;
      if (boundary !== undefined && boundary > this.now()) {
        if (failure?.providerDirected) deferredProfiles.set(profile.ref.accountId, boundary);
        retryAtMs = retryAtMs === undefined ? boundary : Math.min(retryAtMs, boundary);
      }
    };
    const incomplete = (
      completedProfileCount: number,
      reason: 'deadline_exceeded' | 'probe_unavailable',
    ): ConnectedServiceAuthGroupQuotaProbeResult => ({
      status: 'incomplete',
      requestedProfileCount: profileIds.length,
      completedProfileCount,
      reason,
      ...(retryAtMs === undefined ? {} : { retryAtMs }),
      ...(deferredProfiles.size ? { deferredProfiles: Array.from(deferredProfiles, ([profileId, retryAtMs]) => ({ profileId, retryAtMs })) } : {}),
    });
    if (profileIds.length === 0) return { status: 'complete', requestedProfileCount: 0, completedProfileCount: 0 };
    if (!groupId) return incomplete(0, 'probe_unavailable');
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const timeoutHandle = this.fetchTimeoutMs === null ? undefined
      : setTimeout(() => controller.abort('quota-group-probe-deadline'), this.fetchTimeoutMs);
    timeoutHandle?.unref?.();
    const completedProfileIds = new Set<string>();
    try {
    const qualifiedPeerClass =
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null;
    if (qualifiedPeerClass === 'advertised_v4') {
      const runtime = this.qualifiedConnectedAccountRuntime;
      const service =
        resolveQualifiedConnectedAccountServiceForIngressServiceId(
          serviceId,
        );
      if (!service) return incomplete(0, 'probe_unavailable');
      const accountUsageStore = this.accountUsageStore;
      if (!runtime?.listGroupQuotaTargets || !accountUsageStore) return incomplete(0, 'probe_unavailable');
      const accountMode = await resolveConnectedServiceAccountMode(this.api, { signal });
      signal.throwIfAborted();
      if (accountMode === 'unknown') return incomplete(0, 'probe_unavailable');
      const profiles = await runtime.listGroupQuotaTargets({
        service,
        groupId,
        accountIds: profileIds,
        signal,
      });
      signal.throwIfAborted();
      const targetsByAccountId = new Map(profiles.map((target) => [target.profile.ref.accountId, target]));
      let nextProfileIndex = 0;
      const worker = async (): Promise<void> => {
        while (!signal.aborted) {
          const profileIndex = nextProfileIndex;
          nextProfileIndex += 1;
          const profileId = profileIds[profileIndex];
          if (!profileId) return;
          const target = targetsByAccountId.get(profileId);
          const profile = target?.profile;
          if (!target || !profile) continue;
          if (!isConnectedServiceCredentialHealthStatusUsable(profile.status)) {
            completedProfileIds.add(profileId);
            continue;
          }
          try {
            const invocation = await this.invokeQualifiedAccountQuota({
              profile, accountMode,
              signal,
              cancellationSignal: input.signal,
            });
            signal.throwIfAborted();
            if (!invocation?.result || !invocation.basis.isCurrent()) {
              retainRetryBoundary(profile);
              continue;
            }
            const snapshot = buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota({
              profile: invocation.profile,
              quota: invocation.result,
              staleAfterMs: this.polledQuotaStaleAfterMs,
              usageIdentity: invocation.usageIdentity,
            });
            await this.recordQualifiedPolledAccountUsageLocally({
              signal,
              profile: invocation.profile, snapshot,
              sourceProviderAccountId: invocation.profile.providerIdentity?.accountId?.trim() ?? '',
              groupContexts: [{ groupId, groupGeneration: target.groupGeneration }],
              qualifiedGroupTargets: [], switchEvaluationTargets: [], emitLiveLifecycle: false,
            });
            completedProfileIds.add(profileId);
          } catch {
            if (signal.aborted) return;
            retainRetryBoundary(profile);
          }
        }
      };
      const workerCount = Math.min(
        CONNECTED_SERVICE_GROUP_QUOTA_PROBE_MAX_CONCURRENCY,
        profileIds.length,
      );
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      input.signal?.throwIfAborted();
      if (signal.aborted) return incomplete(completedProfileIds.size, 'deadline_exceeded');
      if (completedProfileIds.size + deferredProfiles.size !== profileIds.length) return incomplete(completedProfileIds.size, 'probe_unavailable');
      return { status: 'complete', requestedProfileCount: profileIds.length, completedProfileCount: completedProfileIds.size,
        ...(deferredProfiles.size ? { deferredProfiles: Array.from(deferredProfiles, ([profileId, retryAtMs]) => ({ profileId, retryAtMs })) } : {}) };
    }
    return incomplete(0, 'probe_unavailable');
    } catch {
      input.signal?.throwIfAborted();
      return incomplete(
        completedProfileIds.size,
        signal.aborted ? 'deadline_exceeded' : 'probe_unavailable',
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private shouldRunLegacyQuotaFetcher(
    serviceId: ConnectedServiceId,
    peerClass: QualifiedConnectedAccountPeerClass | null,
    operation: BuiltInLegacyConnectedAccountOperation = 'quota_poll',
  ): boolean {
    const service =
      resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput(
        serviceId,
      );
    if (!service) return false;
    const resolveOperationTransport =
      this.qualifiedConnectedAccountRuntime?.resolveOperationTransport;
    if (resolveOperationTransport) {
      try {
        const transport = resolveOperationTransport({
          service,
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
    signal?: AbortSignal;
    accountMode: 'e2ee' | 'plain';
    profile: QualifiedConnectedAccountProfileV4;
    snapshot: ProviderAccountUsageSnapshotV1;
    basis: Pick<QualifiedConnectedAccountEstablishedInvocationBasis,
      'credentialRevision' | 'credentialConfigurationRevision'> & Readonly<{
        isCurrent(): boolean | Promise<boolean>;
      }>;
  }>): Promise<boolean> {
    input.signal?.throwIfAborted();
    const runtime = this.qualifiedConnectedAccountRuntime;
    if (
      !runtime
      || !await input.basis.isCurrent()
      || !this.shouldRunQualifiedQuotaOperation(
        input.profile,
        'provider_account_usage_write',
      )
    ) {
      return false;
    }
    input.signal?.throwIfAborted();
    const expectedConfigurationRevision =
      input.basis.credentialConfigurationRevision;
    const subscription = mergeProviderAccountSubscription(
      this.accountUsageStore?.resolveRecordId(input.snapshot.recordId)?.subscription,
      input.snapshot.subscription,
    );
    const snapshot = subscription
      ? { ...input.snapshot, subscription }
      : input.snapshot;
    const keyPrefix = `${this.buildQualifiedQuotaPersistenceKey(input.profile.ref)}\u0000`;
    const materialFingerprint =
      computeProviderAccountUsageSnapshotFingerprint(
        snapshot,
        this.quotaSnapshotFingerprintKey,
      );
    const key = `${keyPrefix}${JSON.stringify([input.accountMode, snapshot.recordId,
      input.basis.credentialRevision, expectedConfigurationRevision])}`;
    const status = snapshot.state === 'error_last_known_good'
      ? 'error' as const
      : snapshot.state === 'not_loaded'
        || snapshot.meters.length > 0 && snapshot.meters.every(meter => meter.status === 'unavailable')
      ? 'unavailable' as const
      : 'ok' as const;
    const materialState: QuotaPersistenceMaterialState = {
      // History's material fingerprint deliberately excludes independent
      // subscription facets. Local publication also fences its exact basis.
      fingerprint: JSON.stringify([materialFingerprint, snapshot.subscription ?? null]),
      fetchedAt: snapshot.fetchedAtMs,
      staleAfterMs: snapshot.staleAfterMs,
      status,
    };
    const decision = shouldPersistQuotaSnapshot({
      previous: this.quotaPersistenceStateByKey.get(key) ?? null,
      next: materialState,
      nowMs: this.now(),
      minFreshnessMs: this.quotaPersistenceMinFreshnessMs,
    });
    if (!decision.persist) return decision.reason === 'unchanged_fresh';
    const write = {
      source: {
        ref: input.profile.ref,
        bindingKind: 'account' as const,
      },
      expectedCredentialRevision: input.basis.credentialRevision,
      expectedConfigurationRevision,
      recordId: snapshot.recordId,
      recordKey: snapshot.recordKey,
      payloadMode: input.accountMode === 'plain'
        ? 'plain_json_v1' as const
        : 'sealed_account_scoped_v1' as const,
      status,
      ...(input.accountMode === 'plain'
        ? { snapshot }
        : {
            sealedPayload: sealProviderAccountUsageSnapshot({
              material: requireQuotaCredentialOpenMaterial(
                this.resolveCredentialOpenMaterial(),
              ),
              snapshot,
              randomBytes: this.randomBytes,
            }),
          }),
      fetchedAt: snapshot.fetchedAtMs,
      staleAfterMs: snapshot.staleAfterMs,
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
      signal: input.signal,
      run: async (payload) => {
        input.signal?.throwIfAborted();
        if (!await input.basis.isCurrent()) {
          throw new Error(
            'Qualified Connected Account quota basis is no longer current',
          );
        }
        await persistProviderAccountUsageWithDaySummaries({
          writer: writeProviderAccountUsage,
          nowMs: this.now(), randomBytes: this.randomBytes,
          signal: input.signal,
          token: this.credentials.token,
          write: payload,
          ...(input.accountMode === 'e2ee' ? { material: requireQuotaCredentialOpenMaterial(this.resolveCredentialOpenMaterial()) } : {}),
        });
        input.signal?.throwIfAborted();
        if (!await input.basis.isCurrent()) {
          throw new Error(
            'Qualified Connected Account quota generation changed during persistence',
          );
        }
        return { status: 'written' as const };
      },
    });
    input.signal?.throwIfAborted();
    if (outcome.status === 'written') {
      for (const previousKey of this.quotaPersistenceStateByKey.keys()) {
        if (previousKey.startsWith(keyPrefix) && previousKey !== key) this.quotaPersistenceStateByKey.delete(previousKey);
      }
      this.quotaPersistenceStateByKey.set(key, materialState);
      return true;
    }
    if (outcome.status === 'suppressed') return false;
    throw new InBandQuotaPersistenceRetryError(outcome.status === 'failed'
      ? { reason: outcome.classification.kind, retryable: outcome.classification.retryable,
          retryAfterMs: outcome.classification.retryAfterMs }
      : { reason: outcome.reason, retryable: true, retryAfterMs: outcome.retryAfterMs });
  }

  private buildQualifiedQuotaPersistenceKey(ref: QualifiedConnectedAccountRef): string {
    this.refreshQuotaPersistenceAccountScope();
    return JSON.stringify(['qualified', this.quotaPersistenceServerScope,
      accountScopeFingerprintMaterial(this.quotaPersistenceAccountScope), qualifiedAccountQuotaKey(ref)]);
  }

  private buildUnloadedQualifiedAccountQuotaSnapshot(
    profile: QualifiedConnectedAccountProfileV4,
    usageIdentity?: PluginConnectedAccountDescriptorContributionV2['usageIdentity'],
  ) {
    return { ...buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota({
      profile, quota: { observedAtMs: 0, limits: [],
        ...(profile.providerIdentity?.organizationId ? { providerOrganizationId: profile.providerIdentity.organizationId } : {}) },
      staleAfterMs: this.polledQuotaStaleAfterMs,
      usageIdentity,
    }), state: 'not_loaded' as const, confidence: 'unknown' as const };
  }

  /** Publish completion usage or make the first Refresh addressable without provider quota work. */
  async initializeQualifiedAccountQuotaSource(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    credentialRevision: string;
    configurationRevision: string | null;
    accountMode: 'plain' | 'e2ee';
    completionObservation?: ConnectedAccountCompletionObservation;
  }>): Promise<void> {
    const runtime = this.qualifiedConnectedAccountRuntime;
    if (!runtime) return;
    if (!runtime.listAccounts) throw new Error('Qualified quota source inventory is unavailable');
    const profiles = await runtime.listAccounts({ service: input.account.service });
    const profile = profiles.find((candidate) => (
      matchesQualifiedService(candidate.ref.service, input.account.service)
      && candidate.ref.accountId === input.account.accountId
      && candidate.credentialRevision === input.credentialRevision
      && candidate.configurationRevision === input.configurationRevision
      && candidate.status === 'connected'
    ));
    if (!profile) return;
    if (!input.completionObservation) {
      const existing = await this.readQualifiedAccountQuota(profile);
      if (existing.response && existing.snapshot) return;
    }
    await this.initializeQualifiedAccountQuotaSourceForProfile({ ...input, profile });
  }

  private async initializeQualifiedAccountQuotaSourceForProfile(input: Readonly<{
    profile: QualifiedConnectedAccountProfileV4;
    accountMode: 'plain' | 'e2ee';
    completionObservation?: ConnectedAccountCompletionObservation;
    signal?: AbortSignal;
  }>): Promise<ProviderAccountUsageSnapshotV1 | null> {
    const runtime = this.qualifiedConnectedAccountRuntime;
    const { profile } = input;
    if (!runtime || !profile.credentialRevision
      || !this.shouldRunQualifiedQuotaOperation(profile, 'quota_read')
      || !this.shouldRunQualifiedQuotaOperation(profile, 'provider_account_usage_write')) return null;
    // Home's configurationReady only reports sidecar presence. The established
    // owner admits the selected mode, including modes with no configuration.
    const basis = await runtime.establishedRuntimeOwner.readQuotaSourceSnapshot({
      account: profile.ref, credentialRevision: profile.credentialRevision,
      configurationRevision: profile.configurationRevision, accountMode: input.accountMode,
      operation: input.completionObservation ? 'completionPublication' : 'quotaFetch', signal: input.signal,
    });
    if (!basis || !await basis.isCurrent()) return null;
    if (input.completionObservation) {
      const usageIdentity = await runtime.resolveUsageIdentity?.(profile.ref.service, input.signal);
      const owned = buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota({
        profile, quota: { observedAtMs: input.completionObservation.observedAtMs, limits: [],
          ...(profile.providerIdentity?.organizationId ? { providerOrganizationId: profile.providerIdentity.organizationId } : {}) },
        staleAfterMs: this.polledQuotaStaleAfterMs,
        usageIdentity: usageIdentity ?? undefined,
      });
      const snapshot: ProviderAccountUsageSnapshotV1 = { ...owned, ...input.completionObservation,
        providerId: owned.providerId, recordId: owned.recordId, recordKey: owned.recordKey,
        accountSubject: owned.accountSubject, staleAfterMs: owned.staleAfterMs };
      if (!await this.persistQualifiedConnectedAccountQuota({ accountMode: input.accountMode, profile, snapshot, basis, signal: input.signal })) {
        throw new Error('Qualified completion observation could not be published');
      }
      await this.recordQualifiedPolledAccountUsageLocally({ profile, snapshot,
        sourceProviderAccountId: profile.providerIdentity?.accountId?.trim() ?? '',
        groupContexts: [], qualifiedGroupTargets: [], switchEvaluationTargets: [], emitLiveLifecycle: true });
      return snapshot;
    }
    const snapshot = this.buildUnloadedQualifiedAccountQuotaSnapshot(profile,
      await runtime.resolveUsageIdentity?.(profile.ref.service, input.signal) ?? undefined);
    if (!await this.persistQualifiedConnectedAccountQuota({
      accountMode: input.accountMode, profile, snapshot, basis, signal: input.signal,
    })) throw new Error('Qualified quota source could not be initialized');
    return snapshot;
  }

  private qualifiedProfileOrganizationContext(profile: QualifiedConnectedAccountProfileV4) {
    return { providerAccountId: profile.providerIdentity?.accountId?.trim() || null,
      providerOrganizationId: profile.providerIdentity?.organizationId?.trim() || null };
  }

  private retainQualifiedAccountUsageContext(profile: QualifiedConnectedAccountProfileV4,
    usageIdentity: PluginConnectedAccountDescriptorContributionV2['usageIdentity']): void {
    const serviceId = buildQualifiedPluginContributionKey(profile.ref.service);
    const context = this.qualifiedProfileOrganizationContext(profile);
    this.accountUsageStore?.retainSourcesForProfile({ serviceId, profileId: profile.ref.accountId, context, usageIdentity });
    if (usageIdentity?.requiredContext === 'organization') {
      this.runtimeQuotaSnapshots?.retainProfileSnapshots({ serviceId, profileId: profile.ref.accountId, context });
    }
  }

  private async prepareQualifiedAccountQuotaProfile(profile: QualifiedConnectedAccountProfileV4, signal?: AbortSignal): Promise<QualifiedConnectedAccountProfileV4> {
    signal?.throwIfAborted();
    const runtime = this.qualifiedConnectedAccountRuntime;
    const usageIdentity = await runtime?.resolveUsageIdentity?.(profile.ref.service, signal);
    signal?.throwIfAborted();
    if (!runtime || !usageIdentity) return profile;
    let current = profile;
    if (usageIdentity.requiredContext === 'organization' && !profile.providerIdentity?.organizationId?.trim() && profile.credentialRevision && runtime.enrichCredentialContext) {
      try {
        const result = await runtime.enrichCredentialContext({ account: profile.ref, expectedCredentialRevision: profile.credentialRevision, signal });
        signal?.throwIfAborted();
        if (result.status !== 'unavailable' && runtime.listAccounts) {
          const profiles = await runtime.listAccounts({ service: profile.ref.service, signal });
          signal?.throwIfAborted();
          current = profiles.find((candidate) => candidate.ref.accountId === profile.ref.accountId
            && matchesQualifiedService(candidate.ref.service, profile.ref.service)
            && (!result.credentialRevision || candidate.credentialRevision === result.credentialRevision)) ?? profile;
        }
      } catch {
        signal?.throwIfAborted();
        logger.info('[ConnectedServices] Provider quota context enrichment unavailable', { service: profile.ref.service, accountId: profile.ref.accountId });
      }
    }
    this.retainQualifiedAccountUsageContext(current, usageIdentity);
    return current;
  }

  private async readQualifiedAccountQuota(profile: QualifiedConnectedAccountProfileV4, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const usageIdentity = await this.qualifiedConnectedAccountRuntime?.resolveUsageIdentity?.(profile.ref.service, signal);
    signal?.throwIfAborted();
    const context = this.qualifiedProfileOrganizationContext(profile);
    if (usageIdentity) this.retainQualifiedAccountUsageContext(profile, usageIdentity);
    const serviceId = buildQualifiedPluginContributionKey(profile.ref.service);
    const localEntry = this.runtimeQuotaSnapshots?.getSnapshotEntry({ serviceId, profileId: profile.ref.accountId });
    let localSnapshot: ConnectedServiceQuotaSnapshotV1 | null = null;
    if (localEntry && !localEntry.snapshot.providerOrganizationId && localEntry.verifiedCredentialFingerprint) {
      let proof: Awaited<ReturnType<NonNullable<QualifiedConnectedAccountQuotaRuntime['resolveCurrentCredentialProof']>>> = null;
      try {
        proof = await this.qualifiedConnectedAccountRuntime?.resolveCurrentCredentialProof?.(profile.ref, signal) ?? null;
        signal?.throwIfAborted();
      } catch {
        signal?.throwIfAborted();
        logger.info('[ConnectedServices] Credential lookup unavailable while validating quota context', {
          code: 'quota_credential_lookup_unavailable', service: profile.ref.service, accountId: profile.ref.accountId,
        });
      }
      // Missing proof preserves the accepted entry through transient transport failures,
      // but never admits it. An authoritative null fingerprint clears obsolete local proof.
      this.runtimeQuotaSnapshots?.retainProfileSnapshots({ serviceId, profileId: profile.ref.accountId,
        context: proof ?? context, verifiedCredentialFingerprint: proof ? proof.credentialFingerprint : undefined });
      if (matchesCurrentQuotaObservationCredential({ credential: proof,
        providerAccountId: localEntry.snapshot.activeAccountId ?? '',
        credentialFingerprint: localEntry.verifiedCredentialFingerprint })) localSnapshot = localEntry.snapshot;
    }
    const { response, snapshot } = await this.readStoredQualifiedAccountQuota(profile, usageIdentity, signal);
    const newerCloudSnapshot = snapshot && localSnapshot
      && compareConnectedServiceQuotaObservationRecency({ existingObservedAtMs: localSnapshot.fetchedAtMs ?? localSnapshot.fetchedAt,
        incomingObservedAtMs: snapshot.fetchedAtMs ?? snapshot.fetchedAt, nowMs: this.now() }) === 'incoming_newer';
    return { response, snapshot, localSnapshot: newerCloudSnapshot ? null : localSnapshot };
  }

  private async readStoredQualifiedAccountQuota(
    profile: QualifiedConnectedAccountProfileV4,
    usageIdentity: Awaited<ReturnType<ProviderAccountUsageUsageIdentityResolver>> | undefined,
    signal?: AbortSignal,
  ) {
    const readQuota = this.qualifiedConnectedAccountRuntime?.readQuota ?? readQualifiedConnectedAccountQuotaV4;
    const response = await readQuota({ token: this.credentials.token, ref: profile.ref,
      requestPurpose: 'connected-accounts:quota-qualification', signal });
    signal?.throwIfAborted();
    const material = response?.content.t === 'encrypted'
      ? requireQuotaCredentialOpenMaterial(this.resolveCredentialOpenMaterial())
      : this.resolveCredentialOpenMaterial();
    const snapshot = response ? openQualifiedConnectedAccountQuotaResponseV4({
      response, expectedRef: profile.ref, material,
    }) : null;
    const keyPrefix = `${this.buildQualifiedQuotaPersistenceKey(profile.ref)}\u0000`;
    for (const [key, previous] of this.quotaPersistenceStateByKey) {
      if (!key.startsWith(keyPrefix)) continue;
      if (!response || response.metadata.fetchedAt !== previous.fetchedAt
        || response.metadata.staleAfterMs !== previous.staleAfterMs || response.metadata.status !== previous.status) {
        this.quotaPersistenceStateByKey.delete(key);
      } else {
        this.quotaPersistenceStateByKey.set(key, { ...previous,
          refreshRequestedAt: response.metadata.refreshRequestedAt });
      }
    }
    const admitted = !snapshot || isProviderAccountUsageIdentityMatch(snapshot, this.qualifiedProfileOrganizationContext(profile), usageIdentity);
    return { response, snapshot: admitted ? snapshot : null };
  }

  /** All qualified quota producers share admission, source bootstrap and failure publication. */
  private async invokeQualifiedAccountQuota(input: Readonly<{
    profile: QualifiedConnectedAccountProfileV4;
    accountMode: 'plain' | 'e2ee';
    previousSnapshot?: ProviderAccountUsageSnapshotV1 | null;
    afterConfirmedReset?: boolean;
    refreshRequestedAt?: number;
    expectedCredentialRevision?: string;
    signal?: AbortSignal;
    cancellationSignal?: AbortSignal;
    fetchTimeoutMs?: number | null;
    scheduledHealth?: Readonly<{ work: ScheduledQualifiedAccountHealth; dispatched(): void }>;
  }>) {
    const runtime = this.qualifiedConnectedAccountRuntime;
    if (!runtime) return null;
    input.signal?.throwIfAborted();
    const profile = await this.prepareQualifiedAccountQuotaProfile(input.profile, input.signal);
    input = { ...input, profile };
    const key = `qualified:${qualifiedAccountQuotaKey(input.profile.ref)}`;
    const isDeferredByBackoff = (): boolean => {
      const retry = this.failureStateByBindingKey.get(key);
      return Boolean(retry && this.now() < retry.nextAllowedAt
        && (!input.afterConfirmedReset || retry.providerDirected));
    };
    // Avoid source/runtime work when already deferred; provider admission happens at its leaf.
    if (isDeferredByBackoff() && input.refreshRequestedAt === undefined) return null;
    const previous = input.previousSnapshot === undefined
      ? (await this.readQualifiedAccountQuota(input.profile, input.signal)).snapshot
      : null;
    const previousSnapshot = input.previousSnapshot === undefined
      ? previous && buildProviderAccountUsageSnapshotFromQualifiedQuotaRow({ ref: input.profile.ref, quota: previous })
      : input.previousSnapshot;
    const usageIdentity = await runtime.resolveUsageIdentity?.(input.profile.ref.service, input.signal) ?? undefined;
    input.signal?.throwIfAborted();
    const empty = this.buildUnloadedQualifiedAccountQuotaSnapshot(input.profile, usageIdentity);
    const lastKnown = previousSnapshot?.recordId === empty.recordId ? previousSnapshot : empty;
    let admittedBasis: Pick<QualifiedConnectedAccountEstablishedInvocationBasis,
      'credentialRevision' | 'credentialConfigurationRevision' | 'isCurrent'> | undefined;
    let providerDeferred: Error | undefined;
    try {
      const invocation = await invokeQuota({
        runtime: runtime.establishedRuntimeOwner,
        profile: input.profile,
        expectedCredentialRevision: input.expectedCredentialRevision,
        signal: input.signal,
        cancellationSignal: input.cancellationSignal,
        fetchTimeoutMs: input.fetchTimeoutMs === undefined
          ? input.signal ? null : this.fetchTimeoutMs
          : input.fetchTimeoutMs,
        scheduledHealth: input.scheduledHealth,
        recoverUnauthorized: async signal => {
          signal?.throwIfAborted();
          if (!admittedBasis?.credentialRevision || !admittedBasis.isCurrent()
            || !this.qualifiedHealth?.refreshQualifiedConnectedAccountCredentialForRequestAuth) return false;
          return this.qualifiedHealth.refreshQualifiedConnectedAccountCredentialForRequestAuth({
            account: input.profile.ref, expectedCredentialRevision: admittedBasis.credentialRevision,
            ...(signal ? { signal } : {}),
          });
        },
        assertProviderCallAllowed: () => {
          if (!isDeferredByBackoff()) return;
          providerDeferred = new Error('Qualified quota invocation deferred by provider backoff');
          throw providerDeferred;
        },
        beforeInvoke: async (basis, signal) => {
          signal?.throwIfAborted();
          if (!previousSnapshot && !await this.persistQualifiedConnectedAccountQuota({
            accountMode: input.accountMode, profile: input.profile, snapshot: empty, basis, signal,
          })) throw new Error('Qualified quota source could not be initialized');
          admittedBasis = basis;
        },
        onTimeout: () => this.recordDiagnostic?.({
          event: 'quota_work_suppressed', phase: 'tick', reason: 'quota_fetch_timeout',
          serviceId: buildQualifiedPluginContributionKey(input.profile.ref.service),
          activeProfileId: input.profile.ref.accountId,
        }),
      });
      if (invocation.basis.isCurrent()) this.failureStateByBindingKey.delete(key);
      return { ...invocation, profile, usageIdentity };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const deferred = providerDeferred !== undefined && error === providerDeferred;
      if (deferred && input.refreshRequestedAt === undefined) return null;
      if (!admittedBasis?.isCurrent()) throw error;
      const now = this.now();
      if (!deferred) this.applyFailureBackoff({ now, key, error });
      const failure = isRecord(error) ? error : null;
      const previousFailure = lastKnown.diagnostics?.filter(diagnostic => diagnostic.kind === 'provider_http')
        .reduce<(NonNullable<ProviderAccountUsageSnapshotV1['diagnostics']>)[number] | undefined>(
          (latest, diagnostic) => (diagnostic.observedAtMs ?? -1) > (latest?.observedAtMs ?? -1) ? diagnostic : latest, undefined);
      const status = providerHttpStatusForHealth(deferred ? previousFailure?.status : failure?.status);
      const code = deferred ? previousFailure?.code
        ?? (this.failureStateByBindingKey.get(key)?.providerDirected ? 'provider_backoff' : undefined)
        : failure?.providerCode ?? failure?.quotaFetchErrorCode ?? failure?.code;
      // Keep the producer's typed cause. The usage diagnostic schema owns validation;
      // provider messages and response content are never copied into publication.
      const safeCode = typeof code === 'string' ? code : undefined;
      const snapshot: ProviderAccountUsageSnapshotV1 = { ...lastKnown, state: 'error_last_known_good', diagnostics: [{
        kind: 'provider_http', ...(safeCode ? { code: safeCode } : {}),
        ...(status === undefined ? {} : { status }), observedAtMs: now,
        retryAtMs: this.failureStateByBindingKey.get(key)?.nextAllowedAt,
      }] };
      try {
        await this.persistQualifiedConnectedAccountQuota({
          accountMode: input.accountMode, profile: input.profile, snapshot, basis: admittedBasis,
          signal: input.signal,
        });
      } catch {
        logger.warn('[DAEMON RUN] Qualified quota refresh failure outcome could not be published');
      }
      if (deferred) return null;
      throw error;
    }
  }

  /**
   * Currentness gate for poll-driven lifecycle/switch side effects: every async group/account
   * read above this point can observe a stale world. Re-project the runtime registry's exact
   * current qualified facts (sessionId, qualified service, group, active profile, generation)
   * and keep only pending targets that still match one current fact exactly.
   */
  private resolveCurrentQualifiedGroupSwitchTargets(
    targets: ReadonlyArray<ActiveGroupQuotaSwitchTarget>,
  ): ActiveGroupQuotaSwitchTarget[] {
    const currentTargets: ActiveGroupQuotaSwitchTarget[] = [];
    for (const registryTarget of this.runtimeRegistry.listQuotaTargets()) {
      const sessionId = typeof registryTarget.sessionId === 'string' ? registryTarget.sessionId.trim() : '';
      if (!sessionId) continue;
      for (const entry of extractActiveBindings(registryTarget)) {
        const groupId = typeof entry.groupId === 'string' ? entry.groupId.trim() : '';
        if (!groupId) continue;
        const currentTarget: ActiveGroupQuotaSwitchTarget = {
          sessionId,
          serviceId: entry.serviceId,
          groupId,
          activeProfileId: entry.profileId.trim(),
          groupGeneration: entry.groupGeneration ?? null,
        };
        if (!currentTargets.some((candidate) => sameGroupSwitchTarget(candidate, currentTarget))) {
          currentTargets.push(currentTarget);
        }
      }
    }
    return targets.filter((target) => currentTargets.some((candidate) =>
      sameGroupSwitchTarget(candidate, target)
      && normalizeNullableGeneration(candidate.groupGeneration) === normalizeNullableGeneration(target.groupGeneration)
    ));
  }

  private async recordQualifiedPolledAccountUsageLocally(input: Readonly<{
    signal?: AbortSignal;
    profile: QualifiedConnectedAccountProfileV4;
    snapshot: ProviderAccountUsageSnapshotV1;
    /**
     * Explicit proven provider-account identity feeding the source-link decision
     * below: the authoritative server row's validated `sourceResolution` for a
     * fresh-row hydration, or the live profile's `providerIdentity` for a freshly
     * written poll row. Never inferred from the snapshot itself.
     */
    sourceProviderAccountId: string;
    groupContexts: ReadonlyArray<ConnectedServiceQuotaGroupContext>;
    qualifiedGroupTargets: ReadonlyArray<ActiveGroupQuotaSwitchTarget>;
    switchEvaluationTargets: ActiveGroupQuotaSwitchTarget[];
    /**
     * Freshly written rows emit the live lifecycle edge; a freshly opened authoritative server
     * row only hydrates the local store passively and must stay cold (no live edge, no provider
     * invocation, no server rewrite).
     */
    emitLiveLifecycle: boolean;
  }>): Promise<void> {
    const store = this.accountUsageStore;
    if (!store) return;
    const serviceId = buildQualifiedPluginContributionKey(input.profile.ref.service);
    const accountId = input.profile.ref.accountId.trim();
    // Same source-link algebra as the legacy fetch path: sources are recorded only when the
    // snapshot's account subject is the confirmed fetched identity.
    const usageIdentity = await this.qualifiedConnectedAccountRuntime?.resolveUsageIdentity?.(input.profile.ref.service, input.signal);
    input.signal?.throwIfAborted();
    const canPersistSourceLinks = canPersistUsageSourceLinkWithProviderIdentity({
      sourceProviderAccountId: input.sourceProviderAccountId,
      recordKey: input.snapshot.recordKey,
    }) && isProviderAccountUsageIdentityMatch(input.snapshot.recordKey, this.qualifiedProfileOrganizationContext(input.profile), usageIdentity);
    const sources: ConnectedServiceUsageSourceV1[] = [];
    if (canPersistSourceLinks && accountId) {
      sources.push({
        serviceId,
        profileId: accountId,
        bindingKind: 'profile',
      });
      for (const context of input.groupContexts) {
        sources.push({
          serviceId,
          profileId: accountId,
          bindingKind: 'group_member',
          groupId: context.groupId,
          ...(context.groupGeneration === null
            ? {}
            : { groupGeneration: context.groupGeneration }),
        });
      }
    }
    const previous = store.resolveRecordId(input.snapshot.recordId);
    const mutation = store.recordSnapshot(input.snapshot, { sources });
    if (input.emitLiveLifecycle && mutation.snapshotAdvanced && canPersistSourceLinks && accountId) {
      await this.clearPersistedMemberRuntimeBlockersWithQuotaEvidence({
        serviceId, profileId: accountId,
        quotaEvidence: projectProviderAccountUsageSnapshotToAuthGroupRuntimeState(input.snapshot)?.quotaSnapshot ?? null,
        now: this.now(), authenticatedProbe: true, groupContexts: input.groupContexts, signal: input.signal,
      });
      input.signal?.throwIfAborted();
    }
    if (input.emitLiveLifecycle && mutation.snapshotAdvanced && this.onAccountUsageSnapshotAccepted) {
      await this.onAccountUsageSnapshotAccepted({ phase: 'observed', serviceId, profileId: accountId,
        previous, snapshot: store.resolveRecordId(mutation.recordId) ?? input.snapshot }, input.signal);
      input.signal?.throwIfAborted();
    }
    if (!accountId) return;

    // Currentness gate before ANY lifecycle/switch side effect: all async group/account reads
    // have settled above, so re-project the registry's exact current facts now and drop targets
    // whose session/service/group/active profile/generation no longer matches.
    const currentTargets = this.resolveCurrentQualifiedGroupSwitchTargets(
      input.qualifiedGroupTargets,
    );
    const lifecycleWorkByKey = new Map<
      string,
      ActiveGroupQuotaSwitchTarget & Readonly<{ groupGeneration: number }>
    >();
    for (const context of input.groupContexts) {
      if (context.groupGeneration === null) continue;
      for (const target of currentTargets) {
        if (
          target.serviceId !== serviceId
          || target.groupId.trim() !== context.groupId
          || target.activeProfileId !== accountId
          // Exact generation agreement is required: a target whose generation is null or
          // diverges from the resolved group context receives no lifecycle/switch authority.
          || target.groupGeneration === null
          || target.groupGeneration !== context.groupGeneration
        ) {
          continue;
        }
        if (!input.switchEvaluationTargets.some((candidate) => sameGroupSwitchTarget(candidate, target))) {
          input.switchEvaluationTargets.push(target);
        }
        // One deterministic representative per {service, group, profile, generation} performs
        // the live lifecycle work; every exact-current session target still enters the single
        // switch evaluation above.
        const workKey = `${serviceId}\u0000${context.groupId}\u0000${accountId}\u0000${context.groupGeneration}`;
        const representative = lifecycleWorkByKey.get(workKey);
        if (!representative || target.sessionId < representative.sessionId) {
          lifecycleWorkByKey.set(workKey, {
            ...target,
            groupGeneration: context.groupGeneration,
          });
        }
      }
    }
    if (!input.emitLiveLifecycle) return;
    for (const target of lifecycleWorkByKey.values()) {
      // Prior representative handles suspend across async lifecycle/switch work, so the world can
      // move between the shared currentness gate above and this call. Re-fence each singleton
      // target against the registry's exact current facts immediately before its handle.
      const stillCurrent = this.resolveCurrentQualifiedGroupSwitchTargets([target]);
      if (stillCurrent.length === 0) continue;
      await this.handleAccountUsageChanged({
        sessionId: target.sessionId,
        serviceId: target.serviceId,
        groupId: target.groupId,
        profileId: accountId,
        groupGeneration: target.groupGeneration,
        recordId: input.snapshot.recordId,
        snapshot: input.snapshot,
        // The poll performs its OWN soft-switch check once, after the account windows
        // settle; suppress the duplicate in-band evaluation so one poll emits one
        // switch request, mirroring the legacy poll ordering.
        source: 'poll',
        signal: input.signal,
      });
    }
  }

  private async pollQualifiedConnectedAccountQuotas(input: Readonly<{
    signal?: AbortSignal;
    accountMode: 'e2ee' | 'plain';
    now: number;
    qualifiedGroupTargets: ReadonlyArray<ActiveGroupQuotaSwitchTarget>;
    v4Support: QualifiedConnectedAccountV4Support;
    scheduleAt: (deadline: number) => void;
  }>): Promise<void> {
    const runtime = this.qualifiedConnectedAccountRuntime;
    if (!runtime || input.v4Support !== 'advertised') return;
    let profiles: readonly QualifiedConnectedAccountProfileV4[];
    try {
      input.signal?.throwIfAborted();
      profiles = await runtime.listScheduledAccounts(undefined, input.signal);
      input.signal?.throwIfAborted();
    } catch {
      input.signal?.throwIfAborted();
      input.scheduleAt(input.now + this.probeIntervalMs);
      return;
    }
    this.qualifiedHealth?.retainScheduledQualifiedHealthAccounts(profiles);

    // Canonical qualified target view: current session targets grouped deterministically by
    // qualified service + group. The legacy scalar projection is intentionally not consulted
    // here — source links and group facts stay canonical end to end.
    const groupViewsByKey = new Map<string, {
      service: QualifiedConnectedAccountServiceRef;
      groupId: string;
    }>();
    for (const target of input.qualifiedGroupTargets) {
      const service = parseQualifiedPluginContributionKey(target.serviceId);
      const groupId = target.groupId.trim();
      if (!service || !groupId) continue;
      const key = `${target.serviceId}\u0000${groupId}`;
      if (!groupViewsByKey.has(key)) groupViewsByKey.set(key, { service, groupId });
    }

    // Resolve the canonical current (profile, groupGeneration) facts for each distinct current
    // group through the existing qualified runtime owner.
    const groupContextsByAccountKey = new Map<string, ConnectedServiceQuotaGroupContext[]>();
    const listGroupQuotaTargets = runtime.listGroupQuotaTargets;
    if (listGroupQuotaTargets) {
      for (const view of groupViewsByKey.values()) {
        input.signal?.throwIfAborted();
        const controller = new AbortController();
        const timeoutHandle = this.fetchTimeoutMs === null ? undefined : setTimeout(
          () => controller.abort('qualified-quota-group-targets-deadline'),
          this.fetchTimeoutMs,
        );
        timeoutHandle?.unref?.();
        try {
          const resolvedTargets = await listGroupQuotaTargets({
            service: view.service,
            groupId: view.groupId,
            signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
          });
          input.signal?.throwIfAborted();
          for (const resolvedTarget of resolvedTargets) {
            const accountId = resolvedTarget.profile.ref.accountId.trim();
            if (!accountId) continue;
            const accountKey = qualifiedAccountQuotaKey(resolvedTarget.profile.ref);
            const contexts = groupContextsByAccountKey.get(accountKey) ?? [];
            if (!contexts.some((context) =>
              context.groupId === view.groupId
              && context.groupGeneration === resolvedTarget.groupGeneration
            )) {
              contexts.push({
                groupId: view.groupId,
                groupGeneration: resolvedTarget.groupGeneration,
              });
            }
            groupContextsByAccountKey.set(accountKey, contexts);
          }
        } catch {
          input.signal?.throwIfAborted();
          // Best-effort: those accounts keep polling without group source links.
          continue;
        } finally {
          clearTimeout(timeoutHandle);
        }
      }
    }

    const switchEvaluationTargets: ActiveGroupQuotaSwitchTarget[] = [];
    const poolSessionRunning = input.qualifiedGroupTargets.length > 0;
    const currentKeys = new Set(profiles.map(profile => `qualified:${qualifiedAccountQuotaKey(profile.ref)}`));
    for (const key of this.qualifiedQuotaScheduleByKey.keys()) {
      if (!currentKeys.has(key)) this.qualifiedQuotaScheduleByKey.delete(key);
    }
    for (const listedProfile of profiles) {
      input.signal?.throwIfAborted();
      let profile = listedProfile;
      const health = this.qualifiedHealth?.prepareScheduledQualifiedHealth(profile, input.now);
      let healthDispatched = false;
      const settleHealth = async () => {
        input.signal?.throwIfAborted();
        if (health?.due && !healthDispatched) {
          healthDispatched = true;
          try {
            const receipt = await runtime.establishedRuntimeOwner.invokeScheduledWithReceipts({ account: profile.ref, status: { signal: input.signal }, signal: input.signal });
            input.signal?.throwIfAborted();
            if (receipt.status) await health.settle(receipt.status, input.signal);
            input.signal?.throwIfAborted();
          } catch { input.signal?.throwIfAborted(); logger.warn('[DAEMON RUN] Qualified Connected Account health deadline failed'); }
        }
        const deadline = health?.nextDeadline();
        if (deadline !== null && deadline !== undefined) input.scheduleAt(deadline);
      };
      const key =
        `qualified:${qualifiedAccountQuotaKey(profile.ref)}`;
      // Ruling 2026-11-04 (5): staleness re-reads only while a pool Session runs on this Machine.
      // Reset deadlines, explicit refresh requests and limit signals still observe the Account.
      const refreshWhenStale = poolSessionRunning;
      const basis = JSON.stringify([profile.credentialRevision, profile.configurationRevision,
        profile.authenticationModeId, profile.status, profile.kind, profile.expiresAt,
        profile.providerIdentity?.accountId, profile.providerIdentity?.organizationId,
        groupContextsByAccountKey.get(qualifiedAccountQuotaKey(profile.ref)) ?? [],
        this.shouldRunQualifiedQuotaOperation(profile, 'quota_read'),
        this.shouldRunQualifiedQuotaOperation(profile, 'quota_poll'), refreshWhenStale]);
      let schedule = this.qualifiedQuotaScheduleByKey.get(key);
      if (!schedule || schedule.basis !== basis) {
        const identity = { credentialRevision: profile.credentialRevision, configurationRevision: profile.configurationRevision,
          providerAccountId: profile.providerIdentity?.accountId ?? null,
          providerOrganizationId: profile.providerIdentity?.organizationId ?? null };
        if (schedule && (schedule.credentialRevision !== identity.credentialRevision
          || schedule.configurationRevision !== identity.configurationRevision
          || schedule.providerAccountId !== identity.providerAccountId
          || schedule.providerOrganizationId !== identity.providerOrganizationId)
          && !this.failureStateByBindingKey.get(key)?.providerDirected) {
          this.failureStateByBindingKey.delete(key);
        }
        schedule = { basis, ...identity, at: -Infinity, recordId: null };
        this.qualifiedQuotaScheduleByKey.set(key, schedule);
      }
      if (schedule.at === null || schedule.at > input.now) {
        if (schedule.at !== null) input.scheduleAt(schedule.at);
        await settleHealth();
        continue;
      }
      let nextProbeAt: number | null = null;
      let recordId = schedule.recordId;
      try {
        const usageIdentity = await this.qualifiedConnectedAccountRuntime?.resolveUsageIdentity?.(profile.ref.service, input.signal);
        input.signal?.throwIfAborted();
        if (usageIdentity) this.retainQualifiedAccountUsageContext(profile, usageIdentity);
        const failureState = this.failureStateByBindingKey.get(key);
        if (!this.shouldRunQualifiedQuotaOperation(
          profile,
          'quota_read',
        )) {
          continue;
        }
        const canProbe = this.shouldRunQualifiedQuotaOperation(profile, 'quota_poll');
        const { response: existing, snapshot: existingSnapshot, localSnapshot } = await this.readQualifiedAccountQuota(profile, input.signal);
        recordId = existing?.sourceResolution.recordId ?? recordId;
        // A reload must upgrade retained days even when no new observation is
        // needed, provider credentials need reauthentication, or this Account's
        // plugin has no quota acquisition capability. Account keys own history;
        // provider credential health only gates acquiring another observation.
        if (existing && existingSnapshot) {
          await maintainProviderAccountUsageDaySummariesForRecord({
            token: this.credentials.token, recordId: existing.sourceResolution.recordId,
            accountMode: input.accountMode, nowMs: Math.max(input.now, existing.metadata.fetchedAt),
            randomBytes: this.randomBytes, signal: input.signal,
            ...(input.accountMode === 'e2ee' ? { material: requireQuotaCredentialOpenMaterial(this.resolveCredentialOpenMaterial()) } : {}),
          });
        }
        if (!isConnectedServiceCredentialHealthStatusUsable(profile.status)) continue;
        // Register saved Accounts as well as newly settled ones. Home Refresh is
        // source-addressed, so this must not depend on provider acquisition succeeding.
        const initializedSource = !existingSnapshot
          ? await this.initializeQualifiedAccountQuotaSourceForProfile({ profile, accountMode: input.accountMode, signal: input.signal })
          : null;
        const refreshRequestedAt = existing?.metadata.refreshRequestedAt;
        const pendingRefresh = refreshRequestedAt !== undefined && refreshRequestedAt > (existing?.metadata.fetchedAt ?? 0);
        if (failureState && input.now < failureState.nextAllowedAt && !pendingRefresh) {
          input.scheduleAt(failureState.nextAllowedAt);
          continue;
        }
        const localProbeAt = localSnapshot ? quotaObservationProbeAt({ fetchedAt: localSnapshot.fetchedAt, refreshIntervalMs: this.quotaPersistenceMinFreshnessMs,
          staleAfterMs: localSnapshot.staleAfterMs, resetsAt: localSnapshot.meters.map(meter => meter.resetsAt), refreshWhenStale }) : null;
        if (localSnapshot && localSnapshot.fetchedAt > 0 && localProbeAt !== null && localProbeAt > input.now
          && isConnectedServiceQuotaObservationFresh({ observedAtMs: localSnapshot.fetchedAt, nowMs: input.now,
            maxAgeMs: localSnapshot.staleAfterMs })
          && (existing?.metadata.refreshRequestedAt === undefined || existing.metadata.refreshRequestedAt <= localSnapshot.fetchedAt)) {
          nextProbeAt = canProbe ? localProbeAt : null;
          this.failureStateByBindingKey.delete(key);
          continue;
        }
        const existingProbeAt = existing && existingSnapshot ? quotaObservationProbeAt({
          refreshIntervalMs: this.quotaPersistenceMinFreshnessMs,
          fetchedAt: existing.metadata.fetchedAt, staleAfterMs: existing.metadata.staleAfterMs,
          resetsAt: existingSnapshot.meters.map(meter => meter.resetsAt),
          refreshWhenStale,
        }) : null;
        if (
          existing
          && existingSnapshot
          && existing.metadata.status !== 'error'
          && existing.metadata.fetchedAt > 0
          && existingProbeAt !== null && existingProbeAt > input.now
          && isConnectedServiceQuotaObservationFresh({
            observedAtMs: existing.metadata.fetchedAt,
            nowMs: input.now,
            maxAgeMs: existing.metadata.staleAfterMs,
          })
          && (
            existing.metadata.refreshRequestedAt === undefined
            || existing.metadata.refreshRequestedAt
              <= existing.metadata.fetchedAt
          )
        ) {
          nextProbeAt = canProbe ? existingProbeAt : null;
          this.failureStateByBindingKey.delete(key);
          // Fresh authoritative server row: hydrate the local canonical store passively
          // (profile + qualified group_member sources), let the row participate in the later
          // cold switch evaluation, and keep reconstruction cold — no live lifecycle edge,
          // no provider invocation, and no server rewrite for a fresh row.
          await this.recordQualifiedPolledAccountUsageLocally({
            signal: input.signal,
            profile,
            snapshot: buildProviderAccountUsageSnapshotFromQualifiedQuotaRow({
              ref: profile.ref,
              quota: existingSnapshot,
            }),
            // The opened authoritative V4 response already validated its provider identity
            // through sourceResolution (it must equal the row's activeAccountId).
            sourceProviderAccountId: existing.sourceResolution.providerAccountId,
            groupContexts:
              groupContextsByAccountKey.get(qualifiedAccountQuotaKey(profile.ref)) ?? [],
            qualifiedGroupTargets: input.qualifiedGroupTargets,
            switchEvaluationTargets,
            emitLiveLifecycle: false,
          });
          continue;
        }
        if (!canProbe) {
          continue;
        }
        const invocation =
          await this.invokeQualifiedAccountQuota({
            signal: input.signal,
            cancellationSignal: input.signal,
            fetchTimeoutMs: this.fetchTimeoutMs,
            profile, accountMode: input.accountMode,
            ...(pendingRefresh ? { refreshRequestedAt } : {}),
            ...(health?.due ? { scheduledHealth: { work: health, dispatched: () => { healthDispatched = true; } } } : {}),
            previousSnapshot: existingSnapshot ? buildProviderAccountUsageSnapshotFromQualifiedQuotaRow({
              ref: profile.ref, quota: existingSnapshot,
            }) : initializedSource,
          });
        if (invocation && invocation.basis.isCurrent() && invocation.result === null) {
          // The trusted invoker returns null only when the optional quota leaf is absent.
          nextProbeAt = null;
          continue;
        }
        if (!invocation?.result || !invocation.basis.isCurrent()) continue;
        profile = invocation.profile;
        const incomingSnapshot =
          buildProviderAccountUsageSnapshotFromPluginConnectedAccountQuota({
            profile: invocation.profile,
            quota: invocation.result,
            staleAfterMs: this.polledQuotaStaleAfterMs,
            usageIdentity: invocation.usageIdentity,
          });
        const subscription = mergeProviderAccountSubscription(
          existing?.sourceResolution.recordId === incomingSnapshot.recordId
            ? existingSnapshot?.subscription
            : undefined,
          incomingSnapshot.subscription,
        );
        const snapshot = {
          ...incomingSnapshot,
          ...(subscription ? { subscription } : {}),
        };
        recordId = snapshot.recordId;
        const observedProbeAt = quotaObservationProbeAt({ fetchedAt: snapshot.observedAtMs, refreshIntervalMs: this.quotaPersistenceMinFreshnessMs,
          staleAfterMs: snapshot.staleAfterMs, resetsAt: snapshot.meters.map(meter => meter.resetsAt), refreshWhenStale });
        if (observedProbeAt > input.now) nextProbeAt = observedProbeAt;
        const written = await this.persistQualifiedConnectedAccountQuota({
          signal: input.signal,
          accountMode: input.accountMode,
          profile,
          snapshot,
          basis: invocation.basis,
        });
        if (!written) continue;
        await this.recordQualifiedPolledAccountUsageLocally({
          signal: input.signal,
          profile,
          snapshot,
          // Live observation proof: the polled profile's own provider identity.
          sourceProviderAccountId: profile.providerIdentity?.accountId?.trim() ?? '',
          groupContexts: groupContextsByAccountKey.get(qualifiedAccountQuotaKey(profile.ref)) ?? [],
          qualifiedGroupTargets: input.qualifiedGroupTargets,
          switchEvaluationTargets,
          emitLiveLifecycle: true,
        });
        this.failureStateByBindingKey.delete(key);
      } catch (error) {
        input.signal?.throwIfAborted();
        const failedAt = this.now();
        if ((this.failureStateByBindingKey.get(key)?.nextAllowedAt ?? 0) <= failedAt) {
          this.applyFailureBackoff({ now: failedAt, key, error });
        }
      } finally {
        await settleHealth();
        const deadline = this.failureStateByBindingKey.get(key)?.nextAllowedAt ?? nextProbeAt;
        // A Refresh arriving during the async probe replaces this schedule. Do not
        // overwrite that pending demand with the completed probe's deadline.
        if (this.qualifiedQuotaScheduleByKey.get(key) === schedule) {
          this.qualifiedQuotaScheduleByKey.set(key, { ...schedule, at: deadline, recordId });
        }
        if (deadline !== null) input.scheduleAt(deadline);
      }
    }

    // The single existing convergence owner runs once, over deduped current qualified targets,
    // only after the poll's account windows have settled. Every window above is async and can
    // observe a stale world, so re-fence the accumulated targets against the registry's exact
    // current facts right before the final evaluation.
    if (switchEvaluationTargets.length > 0) {
      await this.maybeRequestActiveGroupSwitchForSnapshot({
        signal: input.signal,
        now: input.now,
        targets: this.resolveCurrentQualifiedGroupSwitchTargets(switchEvaluationTargets),
      });
    }
  }

  public async tickOnce(signal?: AbortSignal): Promise<SingleFlightLoopSchedule> {
    signal?.throwIfAborted();
    const now = Math.max(0, Math.trunc(this.now()));
    let nextRunAt: number | null = null;
    const scheduleAt = (deadline: number): void => {
      if (Number.isFinite(deadline)) nextRunAt = nextRunAt === null ? deadline : Math.min(nextRunAt, deadline);
    };
    const accountMode = await resolveConnectedServiceAccountMode(this.api, { signal });
    signal?.throwIfAborted();
    if (accountMode === 'unknown') return { nextAutomaticRunAfterMs: this.probeIntervalMs };
    const qualifiedPeerClass =
      this.qualifiedConnectedAccountRuntime?.resolvePeerClass() ?? null;

    const qualifiedGroupTargets: ActiveGroupQuotaSwitchTarget[] = [];
    for (const target of this.runtimeRegistry.listQuotaTargets()) {
      for (const entry of extractActiveBindings(target)) {
        const profileId = String(entry.profileId ?? '').trim();
        if (!profileId) continue;
        const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
        const groupId = typeof entry.groupId === 'string' ? entry.groupId.trim() : '';
        // Every current registry entry participates in qualified poll-driven convergence.
        if (sessionId && groupId) {
          const qualifiedTarget = {
            sessionId,
            serviceId: entry.serviceId,
            groupId,
            activeProfileId: profileId,
            groupGeneration: entry.groupGeneration ?? null,
          };
          if (!qualifiedGroupTargets.some((candidate) => sameGroupSwitchTarget(candidate, qualifiedTarget))) {
            qualifiedGroupTargets.push(qualifiedTarget);
          }
        }
      }
    }

    if (this.discoveryEnabled && typeof this.api.listConnectedServiceProfiles === 'function') {
      const hasLegacyDiscovery = [...this.quotaFetchersByServiceId.keys()].some(serviceId =>
        this.shouldRunLegacyQuotaFetcher(serviceId, qualifiedPeerClass));
      const discoveryDue = this.lastDiscoveryAt <= 0 || now - this.lastDiscoveryAt >= this.discoveryIntervalMs;
      if (discoveryDue) {
        let discoverySucceeded = true;
        for (const serviceId of this.quotaFetchersByServiceId.keys()) {
          if (!this.shouldRunLegacyQuotaFetcher(serviceId, qualifiedPeerClass)) {
            continue;
          }
          try {
            signal?.throwIfAborted();
            const result = await this.api.listConnectedServiceProfiles({ serviceId, signal });
            signal?.throwIfAborted();
            const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
            const usableProfileIds = new Set<string>();
            for (const prof of profiles) {
              if (!prof || typeof prof !== 'object') continue;
              if (!isConnectedServiceCredentialHealthStatusUsable(prof.status)) continue;
              const profileId = typeof prof.profileId === 'string' ? String(prof.profileId).trim() : '';
              if (!profileId) continue;
              usableProfileIds.add(profileId);
            }
            this.legacyDiscoveredProfileIdsByServiceId.set(serviceId, usableProfileIds);
          } catch {
            signal?.throwIfAborted();
            discoverySucceeded = false;
            continue;
          }
        }
        if (discoverySucceeded) this.lastDiscoveryAt = now;
        else if (hasLegacyDiscovery) scheduleAt(now + this.probeIntervalMs);
      }
      // Supported scalar peers lack the qualified inventory's complete mutation producer.
      if (hasLegacyDiscovery) scheduleAt(this.lastDiscoveryAt > 0 ? this.lastDiscoveryAt + this.discoveryIntervalMs : now + this.discoveryIntervalMs);
    }

    await this.pollQualifiedConnectedAccountQuotas({
      signal,
      accountMode,
      now,
      scheduleAt,
      qualifiedGroupTargets,
      v4Support:
        qualifiedPeerClass === 'advertised_v4'
          ? 'advertised'
          : qualifiedPeerClass === 'revisioned_v2_v3'
            || qualifiedPeerClass === 'exact_v0_2_1'
            ? 'absent'
            : 'indeterminate',
    });
    signal?.throwIfAborted();
    return { nextAutomaticRunAfterMs: nextRunAt === null ? null : Math.max(1, nextRunAt - this.now()) };
  }
}
