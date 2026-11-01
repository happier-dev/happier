import {
  ConnectedServiceUsageSourceV1Schema,
  compareConnectedServiceQuotaObservationRecency,
  mergeProviderAccountSubscription,
  isProviderAccountUsageOrganizationContextMatch,
  ProviderAccountUsageSnapshotV1Schema,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
  type ProviderAccountUsageOrganizationContext,
} from '@happier-dev/protocol';

import { computeProviderAccountUsageSnapshotMaterialRevision } from './fingerprint';

export type ProviderAccountUsageObservation = Readonly<{
  sources?: readonly ConnectedServiceUsageSourceV1[];
}>;

export type ProviderAccountUsageStoreMutationStatus =
  | 'snapshot_advanced'
  | 'source_linked'
  | 'duplicate'
  | 'older';

export type ProviderAccountUsageStoreMutationResult = Readonly<{
  status: ProviderAccountUsageStoreMutationStatus;
  recordId: ProviderAccountUsageRecordId;
  snapshotAdvanced: boolean;
  sourceLinked: boolean;
}>;

export function isProviderAccountUsageStoreMutationAccepted(
  result: Readonly<{ status: string }>,
): boolean {
  return result.status === 'snapshot_advanced' || result.status === 'source_linked';
}

export type ProviderAccountUsageStore = Readonly<{
  recordSnapshot(
    snapshot: ProviderAccountUsageSnapshotV1,
    observation?: ProviderAccountUsageObservation,
  ): ProviderAccountUsageStoreMutationResult;
  resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
  resolveBySource(source: ConnectedServiceUsageSourceV1): ProviderAccountUsageSnapshotV1 | null;
  listSnapshots(): readonly ProviderAccountUsageSnapshotV1[];
  retainSourcesForProfile(input: Readonly<{
    serviceId: ConnectedServiceUsageSourceV1['serviceId'];
    profileId: string;
    context: ProviderAccountUsageOrganizationContext | null;
  }>): void;
}>;

function sourceKey(source: ConnectedServiceUsageSourceV1): string {
  const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
  return parsed.bindingKind === 'profile'
    ? JSON.stringify(['profile', parsed.serviceId, parsed.profileId])
    : JSON.stringify([
      'group_member',
      parsed.serviceId,
      parsed.profileId,
      parsed.groupId,
      parsed.groupGeneration ?? null,
    ]);
}

function normalizeObservation(
  rawSnapshot: ProviderAccountUsageSnapshotV1,
  observation?: ProviderAccountUsageObservation,
): Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  sources: readonly ConnectedServiceUsageSourceV1[];
}> {
  const sourceMap = new Map<string, ConnectedServiceUsageSourceV1>();
  for (const source of observation?.sources ?? []) {
    const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
    sourceMap.set(sourceKey(parsed), parsed);
  }

  return {
    snapshot: ProviderAccountUsageSnapshotV1Schema.parse(rawSnapshot),
    sources: [...sourceMap.values()],
  };
}

export function createProviderAccountUsageStore(): ProviderAccountUsageStore {
  const snapshotsByRecordId = new Map<string, ProviderAccountUsageSnapshotV1>();
  const redirectsByRecordId = new Map<string, string>();
  const stableRecordKeysByRecordId = new Map<string, ProviderAccountUsageRecordKeyV1>();
  const sourcesByRecordId = new Map<string, readonly ConnectedServiceUsageSourceV1[]>();
  const sourceRecordIdsByKey = new Map<string, string>();

  function resolveRedirect(recordId: string): string {
    let current = recordId;
    const seen = new Set<string>();
    while (redirectsByRecordId.has(current) && !seen.has(current)) {
      seen.add(current);
      current = redirectsByRecordId.get(current) ?? current;
    }
    return current;
  }

  function setRecordSources(recordId: string, sources: readonly ConnectedServiceUsageSourceV1[]): void {
    sourcesByRecordId.set(recordId, sources);
    for (const source of sources) {
      sourceRecordIdsByKey.set(sourceKey(source), recordId);
    }
  }

  function mergeSources(
    left: readonly ConnectedServiceUsageSourceV1[],
    right: readonly ConnectedServiceUsageSourceV1[],
  ): readonly ConnectedServiceUsageSourceV1[] {
    const merged = new Map<string, ConnectedServiceUsageSourceV1>();
    for (const source of [...left, ...right]) {
      const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
      merged.set(sourceKey(parsed), parsed);
    }
    return [...merged.values()];
  }

  function recordSnapshot(
    rawSnapshot: ProviderAccountUsageSnapshotV1,
    observation?: ProviderAccountUsageObservation,
  ): ProviderAccountUsageStoreMutationResult {
    const normalized = normalizeObservation(rawSnapshot, observation);
    const parsed = normalized.snapshot;
    const targetRecordId = resolveRedirect(parsed.recordId);
    const existing = snapshotsByRecordId.get(targetRecordId);
    const targetRecordKey =
      targetRecordId === parsed.recordId
        ? parsed.recordKey
        : existing?.recordKey ?? stableRecordKeysByRecordId.get(targetRecordId);

    if (!targetRecordKey) {
      throw new Error(`Missing provider account usage adoption target key for ${targetRecordId}`);
    }

    const existingSources = sourcesByRecordId.get(targetRecordId) ?? [];
    const existingSourceKeys = new Set(existingSources.map(sourceKey));
    const sourceLinked = normalized.sources.some((source) => !existingSourceKeys.has(sourceKey(source)));
    const sources = sourceLinked
      ? mergeSources(existingSources, normalized.sources)
      : existingSources;

    const recency = existing
      ? compareConnectedServiceQuotaObservationRecency({
          existingObservedAtMs: existing.fetchedAtMs,
          incomingObservedAtMs: parsed.fetchedAtMs,
          nowMs: Date.now(),
        })
      : 'incoming_newer';
    const olderUsage = recency === 'incoming_older' || recency === 'incoming_future';
    const usage = olderUsage && existing ? existing : parsed;
    const subscription = mergeProviderAccountSubscription(existing?.subscription, parsed.subscription);
    const next = ProviderAccountUsageSnapshotV1Schema.parse({
      ...usage,
      ...(subscription ? { subscription } : {}),
      recordId: targetRecordId,
      recordKey: targetRecordKey,
      providerId: targetRecordKey.providerId,
      accountSubject: targetRecordId === parsed.recordId
        ? usage.accountSubject
        : existing?.accountSubject ?? {
          kind: 'providerSubject',
          id: targetRecordKey.accountSubjectId,
        },
    });
    const snapshotAdvanced = !existing
      || recency === 'incoming_newer'
      || (
        recency !== 'incoming_future'
        && computeProviderAccountUsageSnapshotMaterialRevision(next)
          !== computeProviderAccountUsageSnapshotMaterialRevision(existing)
      );
    if (snapshotAdvanced) snapshotsByRecordId.set(targetRecordId, next);
    if (sourceLinked || !existing) setRecordSources(targetRecordId, sources);
    if (targetRecordId !== parsed.recordId) {
      snapshotsByRecordId.delete(parsed.recordId);
      sourcesByRecordId.delete(parsed.recordId);
    }
    return {
      status: snapshotAdvanced ? 'snapshot_advanced' : sourceLinked ? 'source_linked' : olderUsage ? 'older' : 'duplicate',
      recordId: targetRecordId as ProviderAccountUsageRecordId,
      snapshotAdvanced,
      sourceLinked,
    };
  }

  function resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null {
    return snapshotsByRecordId.get(resolveRedirect(recordId)) ?? null;
  }

  function listSnapshots(): readonly ProviderAccountUsageSnapshotV1[] {
    return [...snapshotsByRecordId.entries()]
      .filter(([recordId]) => resolveRedirect(recordId) === recordId)
      .map(([, snapshot]) => snapshot)
      .sort((left, right) => left.recordId.localeCompare(right.recordId));
  }

  function resolveBySource(source: ConnectedServiceUsageSourceV1): ProviderAccountUsageSnapshotV1 | null {
    const recordId = sourceRecordIdsByKey.get(sourceKey(source));
    if (!recordId) return null;
    return snapshotsByRecordId.get(resolveRedirect(recordId)) ?? null;
  }

  function retainSourcesForProfile(input: Parameters<ProviderAccountUsageStore['retainSourcesForProfile']>[0]): void {
    for (const [recordId, sources] of sourcesByRecordId) {
      const snapshot = snapshotsByRecordId.get(recordId);
      if (snapshot && isProviderAccountUsageOrganizationContextMatch(snapshot.recordKey, input.context)) continue;
      const retained = sources.filter((source) => {
        if (source.serviceId !== input.serviceId || source.profileId !== input.profileId) return true;
        const key = sourceKey(source);
        if (sourceRecordIdsByKey.get(key) === recordId) sourceRecordIdsByKey.delete(key);
        return false;
      });
      if (retained.length !== sources.length) sourcesByRecordId.set(recordId, retained);
    }
  }

  return {
    recordSnapshot,
    resolveRecordId,
    resolveBySource,
    listSnapshots,
    retainSourcesForProfile,
  };
}
