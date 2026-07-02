import {
  sealProviderAccountUsageSnapshotCiphertext,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
  type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
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
  registerProviderAccountUsageSnapshotPlain?: (args: Readonly<{
    recordId: ProviderAccountUsageRecordId;
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
    sealed: SealedProviderAccountUsageSnapshotV1;
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
  status: 'ok' | 'unavailable' | 'estimated' | 'error';
  materialFingerprint: string;
  materialState: QuotaPersistenceMaterialState;
}>;

export type ProviderAccountUsagePersistenceScheduler = Readonly<{
  recordInBandSnapshot(snapshot: ProviderAccountUsageSnapshotV1): Promise<
    | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
    | Readonly<{ status: 'suppressed'; reason: string }>
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

function resolveFingerprintKey(params: Readonly<{
  fingerprintKey?: ProviderAccountUsageFingerprintKey;
  credentials?: Credentials;
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
  credentials?: Credentials;
  randomBytes?: (length: number) => Uint8Array;
  serverScope?: string;
  accountScope?: string;
  minFreshnessMs?: number;
}>): ProviderAccountUsagePersistenceScheduler {
  const fingerprintKey = resolveFingerprintKey(params);
  const minFreshnessMs = Math.max(
    0,
    Math.trunc(params.minFreshnessMs ?? DEFAULT_PROVIDER_ACCOUNT_USAGE_PERSISTENCE_MIN_FRESHNESS_MS),
  );
  const stateByRecordId = new Map<string, QuotaPersistenceMaterialState>();

  async function persistPayload(_key: string, payload: ProviderAccountUsagePersistencePayload): Promise<void> {
    const accountMode = await params.api.getAccountEncryptionMode();
    if (accountMode === 'plain' && params.api.registerProviderAccountUsageSnapshotPlain) {
      await params.api.registerProviderAccountUsageSnapshotPlain({
        recordId: payload.recordId,
        content: { t: 'plain', v: payload.snapshot },
        metadata: {
          fetchedAt: payload.snapshot.fetchedAtMs,
          staleAfterMs: payload.snapshot.staleAfterMs,
          status: payload.status,
          materialFingerprint: payload.materialFingerprint,
        },
      });
      stateByRecordId.set(payload.recordId, payload.materialState);
      return;
    }
    if (accountMode !== 'e2ee' || !params.api.registerProviderAccountUsageSnapshotSealed) {
      throw new Error('Provider account usage persistence route unavailable for account mode');
    }
    if (!params.credentials || !params.randomBytes) {
      throw new Error('Provider account usage sealed persistence requires credentials and randomBytes');
    }
    const encryption = params.credentials.encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });
    const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
      material,
      payload: payload.snapshot,
      randomBytes: params.randomBytes,
    });
    await params.api.registerProviderAccountUsageSnapshotSealed({
      recordId: payload.recordId,
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: {
        fetchedAt: payload.snapshot.fetchedAtMs,
        staleAfterMs: payload.snapshot.staleAfterMs,
        status: payload.status,
        materialFingerprint: payload.materialFingerprint,
      },
    });
    stateByRecordId.set(payload.recordId, payload.materialState);
  }

  const scheduler = createConnectedServiceQuotaPersistenceScheduler<string, ProviderAccountUsagePersistencePayload>({
    run: persistPayload,
    maxConcurrent: 2,
    minKeyIntervalMs: 0,
    maxKeys: 500,
    maxKeyAgeMs: 60 * 60_000,
    maxPendingPayloadAgeMs: 10 * 60_000,
    now: params.now,
  });

  return {
    recordInBandSnapshot: async (snapshot) => {
      const status = deriveProviderAccountUsageStatus(snapshot);
      const materialFingerprint = computeProviderAccountUsageSnapshotFingerprint(snapshot, fingerprintKey);
      const materialState: QuotaPersistenceMaterialState = {
        fingerprint: materialFingerprint,
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        status,
      };
      const decision = shouldPersistQuotaSnapshot({
        previous: stateByRecordId.get(snapshot.recordId) ?? null,
        next: materialState,
        nowMs: Math.max(0, Math.trunc(params.now())),
        minFreshnessMs,
      });
      if (!decision.persist) return { status: 'suppressed', reason: decision.reason };
      const enqueue = scheduler.enqueue(snapshot.recordId, {
        recordId: snapshot.recordId,
        snapshot,
        status,
        materialFingerprint,
        materialState,
      });
      if (enqueue.type === 'suppressed') return { status: 'suppressed', reason: enqueue.reason };
      return { status: 'enqueued', enqueue: enqueue.type };
    },
    flush: async (timeoutMs) => {
      await scheduler.flushAll(timeoutMs);
    },
    dispose: () => scheduler.dispose(),
  };
}
