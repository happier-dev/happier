import {
  ConnectedServiceCredentialRevisionV1Schema,
  QualifiedConnectedServiceUsageSourceV4Schema,
  ProviderAccountUsageSnapshotV1Schema,
  sealProviderAccountUsageSnapshotCiphertext,
  type ConnectedServiceCredentialRevisionV1,
  type QualifiedConnectedServiceUsageSourceV4,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import {
  QualifiedConnectedAccountCompatibilityError,
  writeQualifiedProviderAccountUsageV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { StoredCredentials } from '@/persistence';
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
}>;

/**
 * Caller-proven V4 source and currentness basis. The scheduler owns only the
 * PAU envelope/write; it deliberately cannot recreate identity or revisions
 * from a scalar runtime observation after that observation may have gone stale.
 */
export type QualifiedProviderAccountUsagePersistenceTarget = Readonly<{
  source: QualifiedConnectedServiceUsageSourceV4;
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
  expectedConfigurationRevision: string | null;
}>;

type ProviderAccountUsagePersistencePayload = Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  target: QualifiedProviderAccountUsagePersistenceTarget;
  status: 'ok' | 'unavailable' | 'estimated' | 'error';
  materialFingerprint: string;
  materialState: QuotaPersistenceMaterialState;
}>;

export type ProviderAccountUsagePersistenceScheduler = Readonly<{
  recordInBandSnapshot(
    snapshot: ProviderAccountUsageSnapshotV1,
    options?: Readonly<{
      targets?: readonly QualifiedProviderAccountUsagePersistenceTarget[];
    }>,
  ): Promise<
    | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
    | Readonly<{ status: 'already_persisted'; reason: string }>
    | Readonly<{ status: 'not_persisted'; reason: 'no_current_qualified_source' }>
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

function qualifiedTargetPersistenceKey(
  target: QualifiedProviderAccountUsagePersistenceTarget,
): string {
  const source = QualifiedConnectedServiceUsageSourceV4Schema.parse(target.source);
  const expectedCredentialRevision =
    ConnectedServiceCredentialRevisionV1Schema.parse(
      target.expectedCredentialRevision,
    );
  const expectedConfigurationRevision =
    normalizeExpectedConfigurationRevision(
      target.expectedConfigurationRevision,
    );
  return JSON.stringify([
    source.ref.service.pluginId,
    source.ref.service.localId,
    source.ref.accountId,
    source.bindingKind,
    source.bindingKind === 'group_member' ? source.groupId : null,
    source.bindingKind === 'group_member'
      ? source.groupGeneration ?? null
      : null,
    expectedCredentialRevision,
    expectedConfigurationRevision,
  ]);
}

function normalizeExpectedConfigurationRevision(
  value: unknown,
): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error('Qualified provider account usage configuration revision is invalid');
}

function normalizePersistenceTargets(
  options: Readonly<{
    targets?: readonly QualifiedProviderAccountUsagePersistenceTarget[];
  }> | undefined,
): readonly QualifiedProviderAccountUsagePersistenceTarget[] {
  const byKey = new Map<string, QualifiedProviderAccountUsagePersistenceTarget>();
  for (const rawTarget of options?.targets ?? []) {
    const source = QualifiedConnectedServiceUsageSourceV4Schema.parse(
      rawTarget.source,
    );
    const expectedCredentialRevision =
      ConnectedServiceCredentialRevisionV1Schema.parse(
        rawTarget.expectedCredentialRevision,
      );
    const expectedConfigurationRevision = normalizeExpectedConfigurationRevision(
      rawTarget.expectedConfigurationRevision,
    );
    const target: QualifiedProviderAccountUsagePersistenceTarget = {
      source,
      expectedCredentialRevision,
      expectedConfigurationRevision,
    };
    byKey.set(qualifiedTargetPersistenceKey(target), target);
  }
  return [...byKey.values()];
}

function resolveFingerprintKey(params: Readonly<{
  fingerprintKey?: ProviderAccountUsageFingerprintKey;
  credentials: StoredCredentials;
  serverScope?: string;
  accountScope?: string;
}>): ProviderAccountUsageFingerprintKey {
  if (params.fingerprintKey) return params.fingerprintKey;
  return deriveProviderAccountUsageFingerprintKey({
    credentials: params.credentials,
    serverScope: params.serverScope ?? 'active-server',
    accountScope: params.accountScope ?? 'active-account',
  });
}

export function createProviderAccountUsagePersistenceScheduler(params: Readonly<{
  api: AccountUsageApi;
  credentials: StoredCredentials;
  now: () => number;
  fingerprintKey?: ProviderAccountUsageFingerprintKey;
  randomBytes?: (length: number) => Uint8Array;
  serverScope?: string;
  accountScope?: string;
  minFreshnessMs?: number;
  writeQualifiedProviderAccountUsage?: typeof writeQualifiedProviderAccountUsageV4;
}>): ProviderAccountUsagePersistenceScheduler {
  const fingerprintKey = resolveFingerprintKey(params);
  const minFreshnessMs = Math.max(
    0,
    Math.trunc(
      params.minFreshnessMs
        ?? DEFAULT_PROVIDER_ACCOUNT_USAGE_PERSISTENCE_MIN_FRESHNESS_MS,
    ),
  );
  const stateByPersistenceKey = new Map<string, QuotaPersistenceMaterialState>();
  const writeProviderAccountUsage =
    params.writeQualifiedProviderAccountUsage
    ?? writeQualifiedProviderAccountUsageV4;

  async function persistPayload(
    persistenceKey: string,
    payload: ProviderAccountUsagePersistencePayload,
  ): Promise<void> {
    const accountMode = await params.api.getAccountEncryptionMode();
    if (accountMode !== 'plain' && accountMode !== 'e2ee') {
      throw new Error(
        'Provider account usage persistence route unavailable for account mode',
      );
    }
    const write = {
      source: payload.target.source,
      expectedCredentialRevision: payload.target.expectedCredentialRevision,
      expectedConfigurationRevision:
        payload.target.expectedConfigurationRevision,
      recordId: payload.snapshot.recordId,
      recordKey: payload.snapshot.recordKey,
      payloadMode: accountMode === 'plain'
        ? 'plain_json_v1' as const
        : 'sealed_account_scoped_v1' as const,
      status: payload.status,
      ...(accountMode === 'plain'
        ? { snapshot: payload.snapshot }
        : {
            sealedPayload: {
              format: 'account_scoped_v1' as const,
              ciphertext: sealProviderAccountUsageSnapshotCiphertext({
                material: requireAccountEncryptionCredentials(
                  params.credentials,
                ).encryption,
                payload: payload.snapshot,
                randomBytes: params.randomBytes
                  ?? (() => {
                    throw new Error(
                      'Provider account usage sealed persistence requires randomBytes',
                    );
                  }),
              }),
            },
          }),
      fetchedAt: payload.snapshot.fetchedAtMs,
      staleAfterMs: payload.snapshot.staleAfterMs,
      metadata: { materialFingerprint: payload.materialFingerprint },
    };
    await writeProviderAccountUsage({
      token: params.credentials.token,
      write,
    });
    stateByPersistenceKey.set(persistenceKey, payload.materialState);
  }

  const scheduler = createConnectedServiceQuotaPersistenceScheduler<
    string,
    ProviderAccountUsagePersistencePayload
  >({
    run: persistPayload,
    maxConcurrent: 2,
    minKeyIntervalMs: 0,
    maxKeys: 500,
    maxKeyAgeMs: 60 * 60_000,
    maxPendingPayloadAgeMs: 10 * 60_000,
    now: params.now,
    shouldRetry: (error) =>
      !(error instanceof QualifiedConnectedAccountCompatibilityError)
      && readHttpStatus(error) !== 409,
    shouldPauseAfterFailure: (error) =>
      !(error instanceof QualifiedConnectedAccountCompatibilityError)
      && readHttpStatus(error) !== 409,
  });

  return {
    recordInBandSnapshot: async (inputSnapshot, options) => {
      const snapshot = ProviderAccountUsageSnapshotV1Schema.parse(inputSnapshot);
      const targets = normalizePersistenceTargets(options);
      if (targets.length === 0) {
        return {
          status: 'not_persisted' as const,
          reason: 'no_current_qualified_source' as const,
        };
      }
      const status = deriveProviderAccountUsageStatus(snapshot);
      const materialFingerprint = computeProviderAccountUsageSnapshotFingerprint(
        snapshot,
        fingerprintKey,
      );
      const materialState: QuotaPersistenceMaterialState = {
        fingerprint: materialFingerprint,
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        status,
      };
      let accepted = false;
      let coalesced = false;
      let lastSuppressionReason = 'unchanged_fresh';
      for (const target of targets) {
        const persistenceKey = `${snapshot.recordId}\u0000${qualifiedTargetPersistenceKey(target)}`;
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
          snapshot,
          target,
          status,
          materialFingerprint,
          materialState,
        });
        if (enqueue.type === 'accepted') accepted = true;
        if (enqueue.type === 'coalesced') coalesced = true;
        if (enqueue.type === 'suppressed') {
          throw new Error(
            `provider_account_usage_persistence_${enqueue.reason}`,
          );
        }
      }
      if (accepted || coalesced) {
        return {
          status: 'enqueued' as const,
          enqueue: accepted ? 'accepted' as const : 'coalesced' as const,
        };
      }
      return {
        status: 'already_persisted' as const,
        reason: lastSuppressionReason,
      };
    },
    flush: async (timeoutMs) => {
      await scheduler.flushAll(timeoutMs);
    },
    dispose: () => scheduler.dispose(),
  };
}
