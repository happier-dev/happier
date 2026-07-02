import {
  ConnectedServiceIdSchema,
  openConnectedServiceCredentialCiphertext,
  openConnectedServiceQuotaSnapshotCiphertext,
  ConnectedServiceQuotaSnapshotV1Schema,
  sealConnectedServiceQuotaSnapshotCiphertext,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import {
  createKeyedBackoffTracker,
  type KeyedBackoffTracker,
} from '@/api/connection/scheduling';
import type { Credentials } from '@/persistence';
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
import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  buildQuotaPersistenceKey as buildQuotaPersistenceKeyValue,
  resolveQuotaPersistenceAccountScope,
  type QuotaPersistenceAccountScope,
} from './quotaPersistenceKey';
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
import type { ConnectedServiceQuotaFetcher } from './types';

const DEFAULT_QUOTA_PERSISTENCE_MIN_FRESHNESS_MS = 60_000;

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
    | null
    | Readonly<{
        sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
        metadata: Readonly<{ kind: string }>;
      }>
  >;
  getConnectedServiceCredentialPlain?: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
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
          status: 'connected' | 'refreshing' | 'needs_reauth' | 'refresh_failed_retryable';
        }>
      >;
    }>
  >;
  registerConnectedServiceQuotaSnapshotSealed: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
    metadata: Readonly<{ fetchedAt: number; staleAfterMs: number; status: 'ok' | 'unavailable' | 'estimated' | 'error'; materialFingerprint?: string }>;
  }>) => Promise<void>;
  registerConnectedServiceQuotaSnapshotPlain?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    content: Readonly<{ t: 'plain'; v: ConnectedServiceQuotaSnapshotV1 }>;
    metadata: Readonly<{ fetchedAt: number; staleAfterMs: number; status: 'ok' | 'unavailable' | 'estimated' | 'error'; materialFingerprint?: string }>;
  }>) => Promise<void>;
  acquireConnectedServiceRefreshLease?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    machineId: string;
    ownerId?: string;
    leaseMs: number;
  }>) => Promise<Readonly<{ acquired: boolean; leaseUntil: number }>>;
}>;

type ExistingQuotaSnapshotResponse =
  | Awaited<ReturnType<QuotaApi['getConnectedServiceQuotaSnapshotSealed']>>
  | Awaited<ReturnType<NonNullable<QuotaApi['getConnectedServiceQuotaSnapshotPlain']>>>;

type SpawnTarget = Readonly<{
  pid: number;
  sessionId?: string;
  bindings: ConnectedServicesBindingsV1Like;
  connectedServiceSelectionsEnv?: Readonly<Record<string, string | undefined>>;
}>;

type ActiveConnectedServiceBinding = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId?: string;
}>;
type ActiveGroupQuotaSwitchTarget = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string;
}>;
type QuotaWorkPhase = 'tick' | 'hydrate_group' | 'probe_group' | 'soft_switch';
export type ConnectedServiceQuotaCoordinatorDiagnostic = Readonly<{
  event: 'quota_work_deferred' | 'quota_work_suppressed';
  phase: QuotaWorkPhase;
  reason: string;
  retryAfterMs?: number;
}>;
type QuotaCredentialOpenMaterial =
  | Readonly<{ type: 'legacy'; secret: Uint8Array }>
  | Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
type ResolvedQuotaFetchCredential = Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  credentialStorageMode: 'e2ee' | 'plain';
}>;
type AuthGroupSwitchCoordinator = Readonly<{
  switchBeforeTurn(input: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    observedProfileId?: string | null;
  }>): Promise<unknown>;
}>;
type SoftSwitchRecoveryGuardResult =
  | Readonly<{ status: 'allow' }>
  | Readonly<{ status: 'suppress' | 'fold'; reason: string }>;
export type ConnectedServiceQuotaSoftSwitchRecoveryGuard = (
  input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    reason: 'soft_threshold';
  }>,
) => SoftSwitchRecoveryGuardResult | Promise<SoftSwitchRecoveryGuardResult>;

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
    out.push({
      serviceId: parsedServiceId.data,
      profileId,
      ...(groupId ? { groupId } : {}),
    });
  }
  return out;
}

function deriveQuotaSnapshotStatus(snapshot: ConnectedServiceQuotaSnapshotV1): 'ok' | 'unavailable' | 'estimated' {
  const meters = Array.isArray(snapshot.meters) ? snapshot.meters : [];
  if (meters.length === 0) return 'ok';
  const statuses = meters.map((m: any) => (typeof m?.status === 'string' ? m.status : ''));
  if (statuses.every((s) => s === 'unavailable')) return 'unavailable';
  if (statuses.some((s) => s === 'estimated')) return 'estimated';
  return 'ok';
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
  private readonly machineIdProvider: (() => string | null | undefined) | null;
  private readonly ownerIdProvider: (() => string | null | undefined) | null;
  private readonly quotaFetchLeaseMs: number;
  private readonly quotaFetchLeaseContentionWaitMaxMs: number;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly authGroupSwitchCoordinator: AuthGroupSwitchCoordinator | null;
  private readonly softSwitchRecoveryGuard: ConnectedServiceQuotaSoftSwitchRecoveryGuard | null;
  private readonly groupSwitchCheckMinIntervalMs: number;
  private readonly groupSwitchCheckJitterMs: number;
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
  private readonly spawnTargetsByPid = new Map<number, SpawnTarget>();
  private readonly failureStateByBindingKey = new Map<string, FailureState>();
  private readonly groupSwitchCheckAtByKey = new Map<string, number>();
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
    machineIdProvider?: () => string | null | undefined;
    ownerIdProvider?: () => string | null | undefined;
    quotaFetchLeaseMs?: number;
    quotaFetchLeaseContentionWaitMaxMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
    authGroupSwitchCoordinator?: AuthGroupSwitchCoordinator | null;
    softSwitchRecoveryGuard?: ConnectedServiceQuotaSoftSwitchRecoveryGuard | null;
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
    this.softSwitchRecoveryGuard = params.softSwitchRecoveryGuard ?? null;
    this.groupSwitchCheckMinIntervalMs =
      typeof params.groupSwitchCheckMinIntervalMs === 'number' && Number.isFinite(params.groupSwitchCheckMinIntervalMs)
        ? Math.max(0, Math.trunc(params.groupSwitchCheckMinIntervalMs))
        : 60_000;
    this.groupSwitchCheckJitterMs =
      typeof params.groupSwitchCheckJitterMs === 'number' && Number.isFinite(params.groupSwitchCheckJitterMs)
        ? Math.max(0, Math.trunc(params.groupSwitchCheckJitterMs))
        : 5_000;
    this.quotaWorkGate = params.quotaWorkGate ?? null;
    this.recordDiagnostic = params.recordDiagnostic ?? null;
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
    connectedServicesBindingsRaw: ConnectedServicesBindingsV1Like;
    connectedServiceSelectionsEnv?: Readonly<Record<string, string | undefined>>;
  }>): void {
    const pid = Math.trunc(Number(params.pid));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    this.spawnTargetsByPid.set(pid, {
      pid,
      ...(sessionId ? { sessionId } : {}),
      bindings: params.connectedServicesBindingsRaw ?? {},
      ...(params.connectedServiceSelectionsEnv ? { connectedServiceSelectionsEnv: { ...params.connectedServiceSelectionsEnv } } : {}),
    });
  }

  public unregisterPid(pidRaw: number): void {
    const pid = Math.trunc(Number(pidRaw));
    if (!Number.isFinite(pid) || pid <= 0) return;
    this.spawnTargetsByPid.delete(pid);
  }

  public transferPid(fromPidRaw: number, toPidRaw: number): void {
    const fromPid = Math.trunc(Number(fromPidRaw));
    const toPid = Math.trunc(Number(toPidRaw));
    if (!Number.isFinite(fromPid) || fromPid <= 0 || !Number.isFinite(toPid) || toPid <= 0) return;
    const target = this.spawnTargetsByPid.get(fromPid);
    if (!target) return;
    this.spawnTargetsByPid.delete(fromPid);
    this.spawnTargetsByPid.set(toPid, {
      ...target,
      pid: toPid,
    });
  }

  private makeBindingKey(params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>): string {
    return `${params.serviceId}\u0000${params.profileId}`;
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
      const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(input.existing.content.v);
      return parsed.success ? parsed.data : null;
    }
    if (!('sealed' in input.existing) || !input.existing.sealed?.ciphertext) return null;
    const opened = openConnectedServiceQuotaSnapshotCiphertext({
      material: input.material,
      ciphertext: input.existing.sealed.ciphertext,
    });
    const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(opened?.value);
    return parsed.success ? parsed.data : null;
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

  public async hydratePersistedQuotaSnapshotsForGroup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileIds: ReadonlyArray<string>;
  }>): Promise<void> {
    if (!this.runtimeQuotaSnapshots) return;
    const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
    const groupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    if (!groupId) return;
    const profileIds = Array.from(new Set(input.profileIds
      .map((profileId) => String(profileId ?? '').trim())
      .filter((profileId) => profileId.length > 0)));
    if (profileIds.length === 0) return;

    const accountMode = await resolveConnectedServiceAccountMode(this.api);
    if (accountMode === 'unknown') return;
    const material = this.resolveCredentialOpenMaterial();

    for (const profileId of profileIds) {
      const existing = await this.readExistingQuotaSnapshot({
        accountMode,
        serviceId,
        profileId,
      }).catch(() => null);
      if (!existing) continue;
      const snapshot = this.openExistingQuotaSnapshot({
        accountMode,
        existing,
        material,
      });
      if (!snapshot) continue;
      this.runtimeQuotaSnapshots.recordSnapshot({
        serviceId,
        groupId,
        profileId,
        snapshot,
      });
    }
  }

  private async readCredentialRecordForQuotaFetch(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    material: QuotaCredentialOpenMaterial;
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<ResolvedQuotaFetchCredential | null> {
    let record: ConnectedServiceCredentialRecordV1 | null = null;
    let credentialStorageMode: 'e2ee' | 'plain' = 'e2ee';

    if (input.accountMode !== 'e2ee') {
      if (typeof this.api.getConnectedServiceCredentialPlain === 'function') {
        const plainCred = await this.api.getConnectedServiceCredentialPlain({
          serviceId: input.serviceId,
          profileId: input.profileId,
        }).catch(() => null);
        if (plainCred?.content?.t === 'plain') {
          record = plainCred.content.v;
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

      const opened = openConnectedServiceCredentialCiphertext({
        material: input.material,
        ciphertext: sealedCred.sealed.ciphertext,
      });
      record = (opened?.value as ConnectedServiceCredentialRecordV1 | null | undefined) ?? null;
    }
    if (!record) return null;
    return { record, credentialStorageMode };
  }

  private async fetchQuotaSnapshotForProfile(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    material: QuotaCredentialOpenMaterial;
    fetcher: ConnectedServiceQuotaFetcher;
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<Readonly<{
    snapshot: ConnectedServiceQuotaSnapshotV1;
    credentialStorageMode: 'e2ee' | 'plain';
  }> | null> {
    const credential = await this.readCredentialRecordForQuotaFetch(input);
    if (!credential) return null;

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
    };
  }

  private makeGroupSwitchCheckKey(input: ActiveGroupQuotaSwitchTarget): string {
    return `${input.serviceId}\u0000${input.groupId}\u0000${input.activeProfileId}`;
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
    const guard = this.softSwitchRecoveryGuard;
    if (!guard) return true;
    let result: SoftSwitchRecoveryGuardResult;
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
        reason: 'quota_soft_switch_recovery_guard_failed',
      });
      return false;
    }
    if (result.status === 'allow') return true;
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: result.reason.trim() || 'quota_soft_switch_suppressed_recovery_pending',
    });
    return false;
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
      const allowedTargets: ActiveGroupQuotaSwitchTarget[] = [];
      for (const target of targets) {
        if (await this.shouldRunSoftSwitchForTarget(target)) {
          allowedTargets.push(target);
        }
      }
      await Promise.all(allowedTargets.map((target) =>
        authGroupSwitchCoordinator.switchBeforeTurn({
          sessionId: target.sessionId,
          serviceId: target.serviceId,
          groupId: target.groupId,
          reason: 'soft_threshold',
          observedProfileId: target.activeProfileId,
        }).catch(() => {
          // Best-effort only. Runtime failure recovery remains the authoritative fallback.
        }),
      ));
    }
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

  private applyFailureBackoff(params: Readonly<{ now: number; key: string }>): void {
    const existing = this.failureStateByBindingKey.get(params.key);
    const consecutiveFailures = Math.min((existing?.consecutiveFailures ?? 0) + 1, 30);
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

  public disposeInBandQuotaPersistence(): void {
    this.inBandQuotaPersistenceScheduler.dispose();
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
  }>): Promise<void> {
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
  }>): Promise<void> {
    const status = deriveQuotaSnapshotStatus(input.snapshot);
    if (input.accountMode === 'plain' && typeof this.api.registerConnectedServiceQuotaSnapshotPlain === 'function') {
      await this.api.registerConnectedServiceQuotaSnapshotPlain({
        serviceId: input.serviceId,
        profileId: input.profileId,
        content: { t: 'plain', v: input.snapshot },
        metadata: {
          fetchedAt: input.snapshot.fetchedAt,
          staleAfterMs: input.snapshot.staleAfterMs,
          status,
          ...(input.materialFingerprint ? { materialFingerprint: input.materialFingerprint } : {}),
        },
      });
      return;
    }

    const encryption = this.credentials.encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });
    const sealed = sealConnectedServiceQuotaSnapshotCiphertext({
      material,
      payload: input.snapshot,
      randomBytes: this.randomBytes,
    });
    await this.api.registerConnectedServiceQuotaSnapshotSealed({
      serviceId: input.serviceId,
      profileId: input.profileId,
      sealed: { format: 'account_scoped_v1', ciphertext: sealed },
      metadata: {
        fetchedAt: input.snapshot.fetchedAt,
        staleAfterMs: input.snapshot.staleAfterMs,
        status,
        ...(input.materialFingerprint ? { materialFingerprint: input.materialFingerprint } : {}),
      },
    });
  }

  private async readExistingQuotaSnapshot(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<ExistingQuotaSnapshotResponse> {
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
    });
    if (lease.acquired) return { type: 'acquired' };
    return { type: 'contended', leaseUntil: Number(lease.leaseUntil ?? 0) };
  }

  private async waitForContendedQuotaFetch(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    serviceId: ConnectedServiceId;
    profileId: string;
    now: number;
    leaseUntil: number;
  }>): Promise<boolean> {
    const maxWaitMs = this.quotaFetchLeaseContentionWaitMaxMs;
    if (maxWaitMs > 0) {
      const waitMs = Math.min(maxWaitMs, Math.max(0, Math.trunc(input.leaseUntil - input.now)));
      if (waitMs > 0) await this.sleepMs(waitMs);
    }
    const observed = await this.readExistingQuotaSnapshot(input).catch(() => null);
    return this.isExistingQuotaSnapshotFresh({
      existing: observed,
      now: this.now(),
      forcedRefresh: this.shouldForceQuotaRefresh(observed),
    });
  }

  public async probeGroupQuotaSnapshots(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileIds: ReadonlyArray<string>;
  }>): Promise<void> {
    const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
    const groupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    if (!groupId) return;
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
      try {
        const bindingKey = this.makeBindingKey({ serviceId, profileId });
        const failureState = this.failureStateByBindingKey.get(bindingKey);
        if (failureState && now < failureState.nextAllowedAt) continue;

        const lease = await this.acquireQuotaFetchLease({ serviceId, profileId });
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
        });
        if (!fetched) continue;
        this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: fetched.snapshot });
        await this.persistQuotaSnapshotWithServerWork({
          accountMode: fetched.credentialStorageMode,
          serviceId,
          profileId,
          snapshot: fetched.snapshot,
          materialFingerprint: this.computeQuotaMaterialFingerprint(fetched.snapshot),
        });
        this.failureStateByBindingKey.delete(bindingKey);
      } catch {
        const bindingKey = this.makeBindingKey({ serviceId, profileId });
        this.applyFailureBackoff({ now, key: bindingKey });
      }
    }
  }

  public async tickOnce(): Promise<void> {
    const now = Math.max(0, Math.trunc(this.now()));
    const accountMode = await resolveConnectedServiceAccountMode(this.api);
    if (accountMode === 'unknown') return;
    const material = this.resolveCredentialOpenMaterial();

    const bindingsByServiceId = new Map<ConnectedServiceId, Set<string>>();
    const groupSwitchTargetsByBindingKey = new Map<string, ActiveGroupQuotaSwitchTarget[]>();
    for (const target of this.spawnTargetsByPid.values()) {
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
            targets.push({
              sessionId,
              serviceId: entry.serviceId,
              groupId,
              activeProfileId: profileId,
            });
          }
          groupSwitchTargetsByBindingKey.set(bindingKey, targets);
        }
      }
    }

    if (this.discoveryEnabled && typeof this.api.listConnectedServiceProfiles === 'function') {
      const discoveryDue = this.lastDiscoveryAt <= 0 || now - this.lastDiscoveryAt >= this.discoveryIntervalMs;
      if (discoveryDue) {
        this.lastDiscoveryAt = now;
        for (const serviceId of this.quotaFetchersByServiceId.keys()) {
          try {
            const result = await this.api.listConnectedServiceProfiles({ serviceId });
            const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
            for (const prof of profiles) {
              if (!prof || typeof prof !== 'object') continue;
              if (prof.status !== 'connected') continue;
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
      const fetcher = this.quotaFetchersByServiceId.get(serviceId);
      if (!fetcher) continue;

      for (const profileId of profileIds) {
        try {
          const bindingKey = this.makeBindingKey({ serviceId, profileId });
          const existing = await this.readExistingQuotaSnapshot({ accountMode, serviceId, profileId });
          const forcedRefresh = this.shouldForceQuotaRefresh(existing);
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

          const failureState = this.failureStateByBindingKey.get(bindingKey);
          if (failureState && now < failureState.nextAllowedAt) {
            continue;
          }

          if (this.isExistingQuotaSnapshotFresh({ existing, now, forcedRefresh })) {
            await this.maybeRequestActiveGroupSwitchForSnapshot({
              now,
              targets: groupSwitchTargetsByBindingKey.get(bindingKey),
            });
            this.failureStateByBindingKey.delete(bindingKey);
            continue;
          }

          const lease = await this.acquireQuotaFetchLease({ serviceId, profileId });
          if (lease.type === 'contended') {
            const observedFresh = await this.waitForContendedQuotaFetch({
              accountMode,
              serviceId,
              profileId,
              now,
              leaseUntil: lease.leaseUntil,
            });
            if (observedFresh) {
              await this.maybeRequestActiveGroupSwitchForSnapshot({
                now,
                targets: groupSwitchTargetsByBindingKey.get(bindingKey),
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
          });
          if (!fetched) continue;

          this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: fetched.snapshot });
          await this.maybeRequestActiveGroupSwitchForSnapshot({
            now,
            targets: groupSwitchTargetsByBindingKey.get(bindingKey),
          });
          await this.persistQuotaSnapshotWithServerWork({
            accountMode: fetched.credentialStorageMode,
            serviceId,
            profileId,
            snapshot: fetched.snapshot,
            materialFingerprint: this.computeQuotaMaterialFingerprint(fetched.snapshot),
          });
          this.failureStateByBindingKey.delete(bindingKey);
        } catch {
          const bindingKey = this.makeBindingKey({ serviceId, profileId });
          this.applyFailureBackoff({ now, key: bindingKey });
          // Best-effort only.
          continue;
        }
      }
    }
  }
}
