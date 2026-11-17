import { ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedProviderAccountUsageWriteV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { sealProviderAccountUsageSnapshot } from '@happier-dev/protocol/connect/accountUsage';
import { mergeProviderAccountSubscription, type ProviderAccountSubscriptionV1 } from '@happier-dev/protocol/connect/accountSubscription';
import type { ConnectedServiceCredentialRevisionV1, QualifiedConnectedServiceUsageSourceV4, ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';

import {
  QualifiedConnectedAccountCompatibilityError,
  writeQualifiedProviderAccountUsageV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { AccountEncryptionModeReadOptions } from '@/api/client/connectedServiceCredentialApi';
import type { StoredCredentials } from '@/persistence';
import type { RequesterSessionRuntimeContext } from '../../sessionEncryption/requesterSessionCredentials';
import { createConnectedServiceQuotaPersistenceScheduler } from '../quotas/createConnectedServiceQuotaPersistenceScheduler';
import { createQuotaPersistenceBackoff } from '../quotas/createQuotaPersistenceBackoff';
import { DEFAULT_CONNECTED_SERVICE_QUOTA_FRESHNESS_MS } from '../quotas/resolveConnectedServiceQuotasDaemonOptions';
import { maintainProviderAccountUsageDaySummaries } from './dailySummaryPersistence';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { logger } from '@/ui/logger';
import {
  shouldPersistQuotaSnapshot,
  type QuotaPersistenceMaterialState,
} from '../quotas/shouldPersistQuotaSnapshot';
import {
  computeProviderAccountUsageSnapshotFingerprint,
  deriveProviderAccountUsageFingerprintKey,
  type ProviderAccountUsageFingerprintKey,
} from './fingerprint';

type AccountUsageApi = Readonly<{
  getAccountEncryptionMode: (options?: AccountEncryptionModeReadOptions) => Promise<'plain' | 'e2ee' | 'unknown'>;
}>;

/** One publication owner for all key-holding CLI quota producers. A failed
 * summary leaves accepted detail intact for the next maintenance pass. */
export async function persistProviderAccountUsageWithDaySummaries(input: Readonly<{
  token: string; write: Parameters<typeof writeQualifiedProviderAccountUsageV4>[0]['write'];
  material?: AccountScopedCryptoMaterial; signal?: AbortSignal; nowMs: number;
  randomBytes?: (length: number) => Uint8Array;
  writer?: typeof writeQualifiedProviderAccountUsageV4;
}>) {
  const result = await (input.writer ?? writeQualifiedProviderAccountUsageV4)({ token: input.token, write: input.write,
    ...(input.material ? { material: input.material } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  const write = QualifiedProviderAccountUsageWriteV4Schema.parse(input.write);
  const dailySummary = await maintainProviderAccountUsageDaySummariesForRecord({ ...input, recordId: write.recordId,
    accountMode: write.payloadMode === 'plain_json_v1' ? 'plain' : 'e2ee', nowMs: Math.max(input.nowMs, write.fetchedAt ?? 0) });
  return { ...result, dailySummary };
}

/** Saved-account passes and new observations share optional maintenance and its diagnostics. */
export async function maintainProviderAccountUsageDaySummariesForRecord(
  input: Parameters<typeof maintainProviderAccountUsageDaySummaries>[0],
) {
  try {
    const dailySummary = await maintainProviderAccountUsageDaySummaries(input);
    if (dailySummary.status === 'partial') logger.warnLocalFile('Provider account usage daily summary maintenance unavailable',
      { phase: 'daily_summary', reason: 'content_unavailable', writtenDays: dailySummary.days, unavailableDays: dailySummary.unavailableDays.length });
    else if (dailySummary.status === 'conflict') logger.warnLocalFile('Provider account usage daily summary maintenance unavailable',
      { phase: 'daily_summary', reason: 'coverage_changed', writtenDays: dailySummary.days });
    else if (dailySummary.status === 'unavailable') logger.warnLocalFile('Provider account usage daily summary maintenance unavailable',
      { phase: 'daily_summary', reason: dailySummary.reason, writtenDays: dailySummary.days });
    return dailySummary;
  } catch (error) {
    input.signal?.throwIfAborted();
    const reason = readHttpStatus(error) === 401 || readHttpStatus(error) === 403 ? 'authority_unavailable' as const : 'write_failed' as const;
    logger.warnLocalFile('Provider account usage daily summary maintenance unavailable', { phase: 'daily_summary', reason, writtenDays: 0 });
    return { status: 'unavailable' as const, reason };
  }
}

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

export class ProviderAccountUsageSourceQualificationError extends Error {
  constructor(
    readonly reason: 'qualified_account_listing_failed' | 'credential_resolution_failed',
    cause: unknown,
  ) {
    super('Provider account usage source qualification failed', { cause });
    this.name = 'ProviderAccountUsageSourceQualificationError';
  }
}

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

/** Existing daemon reconnect flush, supplied by its retained exact Session custody. */
export async function flushProviderAccountUsagePersistenceForTrackedSessions(input: Readonly<{
  ownedScheduler: ProviderAccountUsagePersistenceScheduler;
  trackedSessions: Iterable<Readonly<{ happySessionId?: string | null }>>;
  withSessionAccountContext: <T>(sessionId: string | null, operation: (context: Pick<RequesterSessionRuntimeContext, 'providerAccountUsagePersistence'> | null) => Promise<T>) => Promise<T>;
  timeoutMs: number;
}>): Promise<void> {
  const flushes = new Map<ProviderAccountUsagePersistenceScheduler, Promise<void>>();
  const flushScheduler = (scheduler: ProviderAccountUsagePersistenceScheduler) => {
    let flush = flushes.get(scheduler);
    if (!flush) {
      flush = scheduler.flush(input.timeoutMs);
      flushes.set(scheduler, flush);
    }
    return flush;
  };
  await Promise.all([flushScheduler(input.ownedScheduler), ...[...input.trackedSessions].map(async tracked => {
    if (!tracked.happySessionId) return;
    let flush: Promise<void> | undefined;
    try {
      await input.withSessionAccountContext(tracked.happySessionId, async context => {
        if (!context) return;
        flush = flushScheduler(context.providerAccountUsagePersistence);
        // Retain requester ownership until the write settles. Propagate a flush
        // failure below, outside the lost-custody acquisition catch.
        await flush.catch(() => undefined);
      });
    } catch {
      // Lost requester custody is not ordinary Account authority. Other retained
      // schedulers still reconnect, and each requester checks currentness at write.
    }
    await flush;
  })]);
}

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
        ?? DEFAULT_CONNECTED_SERVICE_QUOTA_FRESHNESS_MS,
    ),
  );
  const stateByPersistenceKey = new Map<string, QuotaPersistenceMaterialState & Readonly<{ subscription?: ProviderAccountSubscriptionV1 }>>();
  const writeProviderAccountUsage =
    params.writeQualifiedProviderAccountUsage
    ?? writeQualifiedProviderAccountUsageV4;

  async function persistPayload(
    persistenceKey: string,
    payload: ProviderAccountUsagePersistencePayload,
  ): Promise<void> {
    // An identical observation can enter the latest-work queue while the
    // preceding HTTP write is still pending. Reconcile with its committed
    // result before sealing or sending that queued payload.
    const previous = stateByPersistenceKey.get(persistenceKey);
    const subscription = mergeProviderAccountSubscription(previous?.subscription, payload.snapshot.subscription);
    const snapshot = subscription === payload.snapshot.subscription ? payload.snapshot : { ...payload.snapshot, subscription };
    const materialFingerprint = snapshot === payload.snapshot ? payload.materialFingerprint
      : computeProviderAccountUsageSnapshotFingerprint(snapshot, fingerprintKey);
    payload = { ...payload, snapshot, materialFingerprint, materialState: { ...payload.materialState, fingerprint: materialFingerprint } };
    const decision = shouldPersistQuotaSnapshot({ previous: previous ?? null, next: payload.materialState,
      nowMs: Math.max(0, Math.trunc(params.now())), minFreshnessMs });
    if (!decision.persist && !(decision.reason === 'unchanged_fresh'
      && JSON.stringify(subscription) !== JSON.stringify(previous?.subscription))) return;
    const accountMode = await params.api.getAccountEncryptionMode({ usage: 'fresh-authority' });
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
            sealedPayload: sealProviderAccountUsageSnapshot({
                material: requireAccountEncryptionCredentials(
                  params.credentials,
                ).encryption,
                snapshot: payload.snapshot,
                randomBytes: params.randomBytes
                  ?? (() => {
                    throw new Error(
                      'Provider account usage sealed persistence requires randomBytes',
                    );
                  }),
            }),
          }),
      fetchedAt: payload.snapshot.fetchedAtMs,
      staleAfterMs: payload.snapshot.staleAfterMs,
      metadata: { materialFingerprint: payload.materialFingerprint },
    };
    await persistProviderAccountUsageWithDaySummaries({ token: params.credentials.token, write, writer: writeProviderAccountUsage,
      nowMs: params.now(), randomBytes: params.randomBytes,
      ...(accountMode === 'e2ee' ? { material: requireAccountEncryptionCredentials(params.credentials).encryption } : {}) });
    stateByPersistenceKey.set(persistenceKey, { ...payload.materialState, ...(payload.snapshot.subscription ? { subscription: payload.snapshot.subscription } : {}) });
  }

  const scheduler = createConnectedServiceQuotaPersistenceScheduler<
    string,
    ProviderAccountUsagePersistencePayload
  >({
    run: persistPayload,
    maxConcurrent: 2,
    minKeyIntervalMs: 0,
    backoff: createQuotaPersistenceBackoff({ now: params.now }),
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
      const inputMaterialFingerprint = computeProviderAccountUsageSnapshotFingerprint(snapshot, fingerprintKey);
      let accepted = false;
      let coalesced = false;
      let lastSuppressionReason = 'unchanged_fresh';
      for (const target of targets) {
        const persistenceKey = `${snapshot.recordId}\u0000${qualifiedTargetPersistenceKey(target)}`;
        const previous = stateByPersistenceKey.get(persistenceKey);
        const subscription = mergeProviderAccountSubscription(previous?.subscription, snapshot.subscription);
        const mergedSnapshot = subscription === snapshot.subscription ? snapshot : { ...snapshot, subscription };
        const materialFingerprint = mergedSnapshot === snapshot ? inputMaterialFingerprint : computeProviderAccountUsageSnapshotFingerprint(mergedSnapshot, fingerprintKey);
        const materialState: QuotaPersistenceMaterialState = { fingerprint: materialFingerprint, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status };
        // Publish independently advanced facets without changing the material
        // fingerprint used by the accepted history owner.
        const subscriptionAdvanced = JSON.stringify(subscription) !== JSON.stringify(previous?.subscription);
        const decision = shouldPersistQuotaSnapshot({
          previous: previous ?? null,
          next: materialState,
          nowMs: Math.max(0, Math.trunc(params.now())),
          minFreshnessMs,
        });
        if (!decision.persist && !(decision.reason === 'unchanged_fresh' && subscriptionAdvanced)) {
          lastSuppressionReason = decision.reason;
          continue;
        }
        const enqueue = scheduler.enqueue(persistenceKey, {
          snapshot: mergedSnapshot,
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
