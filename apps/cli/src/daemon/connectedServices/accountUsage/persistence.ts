import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  ConnectedServiceUsageSourceV1Schema,
  ProviderAccountUsageRecordIdSchema,
  ProviderAccountUsageSnapshotV1Schema,
  projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1,
  sealProviderAccountUsageSnapshotCiphertext,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
  type SealedConnectedServiceQuotaSnapshotV1,
  type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import {
  sealLegacyConnectedServiceQuotaSnapshotCompatibilityCiphertext,
} from '@happier-dev/protocol/host/legacyConnectedServiceQuotaCompatibility';

import {
  QualifiedConnectedAccountCompatibilityError,
  resolveProviderAccountUsageWriteTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import type {
  SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import { createConnectedServiceQuotaPersistenceScheduler } from '../quotas/createConnectedServiceQuotaPersistenceScheduler';
import {
  shouldPersistQuotaSnapshot,
  type QuotaPersistenceMaterialState,
} from '../quotas/shouldPersistQuotaSnapshot';
import {
  computeProviderAccountUsageSnapshotFingerprint,
  deriveProviderAccountUsageFingerprintKey,
  type ProviderAccountUsageFingerprintKey,
} from './fingerprint';

const DEFAULT_PROVIDER_ACCOUNT_USAGE_PERSISTENCE_MIN_FRESHNESS_MS = 60_000;

type AccountUsageApi = Readonly<{
  getAccountEncryptionMode: () => Promise<'plain' | 'e2ee' | 'unknown'>;
  getServerFeaturesSnapshot: (
    options?: Readonly<{ refresh?: boolean }>,
  ) => Promise<CliServerFeaturesSnapshot | undefined>;
  getProviderAccountUsageWriteRouteAvailability: (args: Readonly<{
    recordId: ProviderAccountUsageRecordId;
  }>) => Promise<'available' | 'absent' | 'indeterminate'>;
  registerProviderAccountUsageSnapshotPlain?: (args: Readonly<{
    recordId: ProviderAccountUsageRecordId;
    source?: ConnectedServiceUsageSourceV1;
    content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }>) => Promise<void>;
  registerProviderAccountUsageSnapshotSealed?: (args: Readonly<{
    recordId: ProviderAccountUsageRecordId;
    recordKey: ProviderAccountUsageSnapshotV1['recordKey'];
    source?: ConnectedServiceUsageSourceV1;
    sealed: SealedProviderAccountUsageSnapshotV1;
    legacyQuotaCompatibility?: SealedConnectedServiceQuotaSnapshotV1;
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }>) => Promise<void>;
}>;

type ProviderAccountUsagePersistencePayload = Readonly<{
  recordId: ProviderAccountUsageRecordId;
  snapshot: ProviderAccountUsageSnapshotV1;
  source?: ConnectedServiceUsageSourceV1;
  status: 'ok' | 'unavailable' | 'estimated' | 'error';
  materialFingerprint: string;
  materialState: QuotaPersistenceMaterialState;
}>;

export type ProviderAccountUsagePersistenceScheduler = Readonly<{
  recordInBandSnapshot(
    snapshot: ProviderAccountUsageSnapshotV1,
    options?: Readonly<{ source?: ConnectedServiceUsageSourceV1; sources?: readonly ConnectedServiceUsageSourceV1[] }>,
  ): Promise<
    | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
    | Readonly<{ status: 'already_persisted'; reason: string }>
  >;
  flush(timeoutMs: number): Promise<void>;
  dispose(): void;
}>;

function deriveProviderAccountUsageStatus(
  snapshot: ProviderAccountUsageSnapshotV1,
): 'ok' | 'unavailable' | 'estimated' | 'error' {
  if (snapshot.state === 'error_last_known_good') return 'error';
  const meters = Array.isArray(snapshot.meters) ? snapshot.meters : [];
  if (meters.length === 0) return 'ok';
  const statuses = meters.map((meter) => meter.status);
  if (statuses.every((status) => status === 'unavailable')) return 'unavailable';
  if (statuses.some((status) => status === 'estimated')) return 'estimated';
  return 'ok';
}

function sourcePersistenceKey(source: ConnectedServiceUsageSourceV1 | undefined): string {
  if (!source) return 'record';
  if (source.bindingKind === 'group_member') {
    return JSON.stringify([
      'group_member',
      source.serviceId,
      source.profileId,
      source.groupId ?? '',
      source.groupGeneration ?? null,
    ]);
  }
  return JSON.stringify(['profile', source.serviceId, source.profileId]);
}

function normalizePersistenceSources(
  options: Readonly<{ source?: ConnectedServiceUsageSourceV1; sources?: readonly ConnectedServiceUsageSourceV1[] }> | undefined,
): readonly (ConnectedServiceUsageSourceV1 | undefined)[] {
  const sources = [
    ...(options?.source ? [options.source] : []),
    ...(options?.sources ?? []),
  ];
  if (sources.length === 0) return [undefined];

  const byKey = new Map<string, ConnectedServiceUsageSourceV1>();
  for (const source of sources) {
    const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
    byKey.set(sourcePersistenceKey(parsed), parsed);
  }
  return [...byKey.values()];
}

function resolveFingerprintKey(params: Readonly<{
  fingerprintKey?: ProviderAccountUsageFingerprintKey;
  credentials?: StoredCredentials;
  serverScope?: string;
  accountScope?: string;
}>): ProviderAccountUsageFingerprintKey {
  if (params.fingerprintKey) return params.fingerprintKey;
  if (!params.credentials) {
    throw new Error('Provider account usage persistence requires credentials or a fingerprint key');
  }
  return deriveProviderAccountUsageFingerprintKey({
    credentials: params.credentials,
    serverScope: params.serverScope ?? 'active-server',
    accountScope: params.accountScope ?? 'active-account',
  });
}

export function createProviderAccountUsagePersistenceScheduler(params: Readonly<{
  api: AccountUsageApi;
  now: () => number;
  fingerprintKey?: ProviderAccountUsageFingerprintKey;
  credentials?: StoredCredentials;
  randomBytes?: (length: number) => Uint8Array;
  serverScope?: string;
  accountScope?: string;
  minFreshnessMs?: number;
  resolveServerContract?: () =>
    SessionSyncPendingInputServerContractResult | null;
}>): ProviderAccountUsagePersistenceScheduler {
  const fingerprintKey = resolveFingerprintKey(params);
  const minFreshnessMs = Math.max(
    0,
    Math.trunc(params.minFreshnessMs ?? DEFAULT_PROVIDER_ACCOUNT_USAGE_PERSISTENCE_MIN_FRESHNESS_MS),
  );
  const stateByPersistenceKey = new Map<string, QuotaPersistenceMaterialState>();

  async function persistPayload(_key: string, payload: ProviderAccountUsagePersistencePayload): Promise<void> {
    const serverFeatures = await params.api.getServerFeaturesSnapshot({
      refresh: true,
    });
    const providerAccountUsageRoute =
      await params.api.getProviderAccountUsageWriteRouteAvailability({
        recordId: payload.recordId,
      });
    const transport = resolveProviderAccountUsageWriteTransport({
      snapshot: serverFeatures,
      serverContract: params.resolveServerContract?.() ?? null,
      providerAccountUsageRoute,
      ...(payload.source ? { source: payload.source } : {}),
    });
    const accountMode = await params.api.getAccountEncryptionMode();
    if (accountMode === 'plain') {
      if (!params.api.registerProviderAccountUsageSnapshotPlain) {
        throw new Error('Provider account usage plaintext persistence route unavailable');
      }
      await params.api.registerProviderAccountUsageSnapshotPlain({
        recordId: payload.recordId,
        ...(payload.source ? { source: payload.source } : {}),
        content: { t: 'plain', v: payload.snapshot },
        metadata: {
          fetchedAt: payload.snapshot.fetchedAtMs,
          staleAfterMs: payload.snapshot.staleAfterMs,
          status: payload.status,
          materialFingerprint: payload.materialFingerprint,
        },
      });
      stateByPersistenceKey.set(_key, payload.materialState);
      return;
    }
    if (accountMode !== 'e2ee') {
      throw new Error('Provider account usage persistence route unavailable for account mode');
    }
    if (!params.credentials || !params.randomBytes) {
      throw new Error('Provider account usage sealed persistence requires credentials and randomBytes');
    }
    const encryption =
      requireAccountEncryptionCredentials(params.credentials).encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });
    if (!params.api.registerProviderAccountUsageSnapshotSealed) {
      throw new Error('Provider account usage sealed persistence route unavailable');
    }
    const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
      material,
      payload: payload.snapshot,
      randomBytes: params.randomBytes,
    });
    const legacyQuotaCompatibility = (() => {
      if (!transport.legacyQuotaCompatibility) return undefined;
      if (payload.source?.bindingKind !== 'profile') return undefined;
      const compatibility =
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
          payload.source.serviceId
        ];
      if (
        compatibility?.exactV0_2_1ReaderQuotaProjection
        !== true
      ) {
        return undefined;
      }
      const quotaSnapshot =
        projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
          snapshot: payload.snapshot,
          source: payload.source,
        });
      if (!quotaSnapshot) return undefined;
      return {
        format: 'account_scoped_v1' as const,
        ciphertext:
          sealLegacyConnectedServiceQuotaSnapshotCompatibilityCiphertext({
            material,
            payload: quotaSnapshot,
            randomBytes: params.randomBytes!,
          }),
      };
    })();
    await params.api.registerProviderAccountUsageSnapshotSealed({
      recordId: payload.recordId,
      recordKey: payload.snapshot.recordKey,
      ...(payload.source ? { source: payload.source } : {}),
      sealed: { format: 'account_scoped_v1', ciphertext },
      ...(legacyQuotaCompatibility ? { legacyQuotaCompatibility } : {}),
      metadata: {
        fetchedAt: payload.snapshot.fetchedAtMs,
        staleAfterMs: payload.snapshot.staleAfterMs,
        status: payload.status,
        materialFingerprint: payload.materialFingerprint,
      },
    });
    stateByPersistenceKey.set(_key, payload.materialState);
  }

  const scheduler = createConnectedServiceQuotaPersistenceScheduler<string, ProviderAccountUsagePersistencePayload>({
    run: persistPayload,
    maxConcurrent: 2,
    minKeyIntervalMs: 0,
    maxKeys: 500,
    maxKeyAgeMs: 60 * 60_000,
    maxPendingPayloadAgeMs: 10 * 60_000,
    now: params.now,
    shouldRetry: (error) =>
      !(error instanceof QualifiedConnectedAccountCompatibilityError),
    shouldPauseAfterFailure: (error) =>
      !(error instanceof QualifiedConnectedAccountCompatibilityError),
  });

  return {
    recordInBandSnapshot: async (inputSnapshot, options) => {
      const snapshot = ProviderAccountUsageSnapshotV1Schema.parse(inputSnapshot);
      const status = deriveProviderAccountUsageStatus(snapshot);
      const materialFingerprint = computeProviderAccountUsageSnapshotFingerprint(snapshot, fingerprintKey);
      const materialState: QuotaPersistenceMaterialState = {
        fingerprint: materialFingerprint,
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        status,
      };
      let accepted = false;
      let coalesced = false;
      let lastSuppressionReason = 'unchanged_fresh';
      for (const source of normalizePersistenceSources(options)) {
        const persistenceKey = `${snapshot.recordId}\u0000${sourcePersistenceKey(source)}`;
        const decision = shouldPersistQuotaSnapshot({
          previous: stateByPersistenceKey.get(persistenceKey) ?? null,
          next: materialState,
          nowMs: Math.max(0, Math.trunc(params.now())),
          minFreshnessMs,
        });
        if (!decision.persist) {
          lastSuppressionReason = decision.reason;
          continue;
        }
        const enqueue = scheduler.enqueue(persistenceKey, {
          recordId: snapshot.recordId,
          snapshot,
          ...(source ? { source } : {}),
          status,
          materialFingerprint,
          materialState,
        });
        if (enqueue.type === 'accepted') accepted = true;
        if (enqueue.type === 'coalesced') coalesced = true;
        if (enqueue.type === 'suppressed') {
          throw new Error(`provider_account_usage_persistence_${enqueue.reason}`);
        }
      }
      if (accepted || coalesced) return { status: 'enqueued', enqueue: accepted ? 'accepted' : 'coalesced' };
      return { status: 'already_persisted', reason: lastSuppressionReason };
    },
    flush: async (timeoutMs) => {
      await scheduler.flushAll(timeoutMs);
    },
    dispose: () => scheduler.dispose(),
  };
}
