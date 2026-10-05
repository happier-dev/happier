import type {
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import { compareConnectedServiceQuotaObservationRecency } from '@happier-dev/protocol';

import { buildConnectedServiceAuthGroupRuntimeStateFromMeters } from './projection';
import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';

type SnapshotKeyInput = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  groupGeneration?: number | null;
}>;

type ProfileSnapshotKeyInput = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
}>;

function snapshotKey(input: SnapshotKeyInput): string {
  return `${input.serviceId}\0${input.groupId}\0${input.profileId}`;
}

function profileSnapshotKey(input: ProfileSnapshotKeyInput): string {
  return `${input.serviceId}\0${input.profileId}`;
}

function readFetchedAt(snapshot: ConnectedServiceQuotaSnapshotV1 | null | undefined): number {
  const fetchedAt = Number(snapshot?.fetchedAt ?? 0);
  return Number.isFinite(fetchedAt) && fetchedAt >= 0 ? fetchedAt : 0;
}

function selectFreshestSnapshot(
  first: ConnectedServiceQuotaSnapshotV1 | null | undefined,
  second: ConnectedServiceQuotaSnapshotV1 | null | undefined,
  nowMs: number,
): ConnectedServiceQuotaSnapshotV1 | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return compareConnectedServiceQuotaObservationRecency({
    existingObservedAtMs: readFetchedAt(first),
    incomingObservedAtMs: readFetchedAt(second),
    nowMs,
  }) === 'incoming_newer' ? second : first;
}

function shouldRecordSnapshot(
  existing: ConnectedServiceQuotaSnapshotV1 | null | undefined,
  incoming: ConnectedServiceQuotaSnapshotV1,
  nowMs: number,
): boolean {
  if (!existing) return true;
  const recency = compareConnectedServiceQuotaObservationRecency({
    existingObservedAtMs: readFetchedAt(existing),
    incomingObservedAtMs: readFetchedAt(incoming),
    nowMs,
  });
  return recency === 'incoming_newer' || recency === 'same';
}

type BurnObservation = Readonly<{
  remainingPct: number;
  atMs: number;
  groupGeneration: number | null;
  effectiveMeterId: string;
  providerLimitId: string | null;
  resetAtMs: number | null;
}>;
type BurnHistory = Readonly<{ prev: BurnObservation | null; latest: BurnObservation }>;

export type ConnectedServiceAuthGroupRuntimeQuotaBurn = Readonly<{
  /** Positive consumption velocity of the effective meter's remaining%, in percent per ms. */
  remainingPercentPerMs: number;
  observedAtMs: number;
  remainingPercent: number;
  groupGeneration: number | null;
  effectiveMeterId: string;
  providerLimitId: string | null;
  resetAtMs: number | null;
}>;

function readBurnObservation(
  snapshot: ConnectedServiceQuotaSnapshotV1,
  groupGeneration: number | null | undefined,
): BurnObservation | null {
  const quotaSnapshot = buildMemberState(snapshot).quotaSnapshot;
  const remainingPct = quotaSnapshot?.effectiveRemainingPercent;
  const effectiveMeterId = quotaSnapshot?.effectiveMeterId;
  if (typeof remainingPct !== 'number' || !Number.isFinite(remainingPct) || !effectiveMeterId) return null;
  const effectiveMeter = quotaSnapshot.meters?.find((meter) => meter.meterId === effectiveMeterId) ?? null;
  return {
    remainingPct,
    atMs: readFetchedAt(snapshot),
    groupGeneration: typeof groupGeneration === 'number' && Number.isFinite(groupGeneration)
      ? Math.max(0, Math.trunc(groupGeneration))
      : null,
    effectiveMeterId,
    providerLimitId: effectiveMeter?.providerLimitId ?? null,
    resetAtMs: effectiveMeter?.resetAtMs ?? null,
  };
}

function isSameBurnContext(left: BurnObservation, right: BurnObservation): boolean {
  return left.groupGeneration === right.groupGeneration
    && left.effectiveMeterId === right.effectiveMeterId
    && left.providerLimitId === right.providerLimitId
    && left.resetAtMs === right.resetAtMs;
}

export class ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore {
  private readonly snapshotsByKey = new Map<string, ConnectedServiceQuotaSnapshotV1>();
  private readonly snapshotsByProfileKey = new Map<string, ConnectedServiceQuotaSnapshotV1>();
  private readonly burnHistoryByKey = new Map<string, BurnHistory>();

  recordSnapshot(input: SnapshotKeyInput & Readonly<{ snapshot: ConnectedServiceQuotaSnapshotV1 }>): void {
    const key = snapshotKey(input);
    const nowMs = Date.now();
    if (shouldRecordSnapshot(this.snapshotsByKey.get(key), input.snapshot, nowMs)) {
      this.snapshotsByKey.set(key, input.snapshot);
      this.recordBurnObservation(key, input.snapshot, input.groupGeneration, nowMs);
    }
    this.recordProfileSnapshot(input);
  }

  private recordBurnObservation(
    key: string,
    snapshot: ConnectedServiceQuotaSnapshotV1,
    groupGeneration: number | null | undefined,
    nowMs: number,
  ): void {
    const observation = readBurnObservation(snapshot, groupGeneration);
    if (!observation) return;
    const existing = this.burnHistoryByKey.get(key);
    // Only advance the history when this observation is strictly newer than the latest one; a
    // duplicate/stale fetchedAt would otherwise poison the delta with a zero time window.
    if (existing && compareConnectedServiceQuotaObservationRecency({
      existingObservedAtMs: existing.latest.atMs,
      incomingObservedAtMs: observation.atMs,
      nowMs,
    }) !== 'incoming_newer') return;
    this.burnHistoryByKey.set(key, {
      prev: existing && isSameBurnContext(existing.latest, observation) ? existing.latest : null,
      latest: observation,
    });
  }

  /**
   * Recent consumption velocity of the effective meter's remaining% for a member, derived from the
   * two most recent distinct-time in-band snapshots this store retained. Only a DECREASING remaining%
   * (real burn) yields a value; a flat or increasing remaining% (a reset/replenish) returns null so
   * the predictive projection fails closed. This is the fast-burn signal the poll-driven soft-switch
   * cannot see between quota polls.
   */
  getRecentBurn(input: SnapshotKeyInput & Readonly<{
    nowMs?: number;
    maxAgeMs?: number;
    currentQuotaSnapshot?: ConnectedServiceAuthGroupMemberRuntimeState['quotaSnapshot'];
  }>): ConnectedServiceAuthGroupRuntimeQuotaBurn | null {
    const history = this.burnHistoryByKey.get(snapshotKey(input));
    if (!history || !history.prev) return null;
    if (
      typeof input.groupGeneration === 'number'
      && history.latest.groupGeneration !== Math.max(0, Math.trunc(input.groupGeneration))
    ) return null;
    if (typeof input.nowMs === 'number' && typeof input.maxAgeMs === 'number') {
      const ageMs = input.nowMs - history.latest.atMs;
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > Math.max(0, input.maxAgeMs)) return null;
    }
    if (
      typeof input.nowMs === 'number'
      && Number.isFinite(input.nowMs)
      && typeof history.latest.resetAtMs === 'number'
      && Number.isFinite(history.latest.resetAtMs)
      && input.nowMs >= history.latest.resetAtMs
    ) return null;
    const currentQuotaSnapshot = input.currentQuotaSnapshot;
    if (currentQuotaSnapshot) {
      if (history.latest.atMs !== currentQuotaSnapshot.capturedAtMs) return null;
      if (history.latest.remainingPct !== currentQuotaSnapshot.effectiveRemainingPercent) return null;
      if (history.latest.effectiveMeterId !== currentQuotaSnapshot.effectiveMeterId) return null;
      const currentMeter = currentQuotaSnapshot.meters?.find(
        (meter) => meter.meterId === currentQuotaSnapshot.effectiveMeterId,
      ) ?? null;
      if (
        history.latest.providerLimitId !== (currentMeter?.providerLimitId ?? null)
        || history.latest.resetAtMs !== (currentMeter?.resetAtMs ?? null)
      ) return null;
    }
    const deltaRemaining = history.prev.remainingPct - history.latest.remainingPct;
    const deltaMs = history.latest.atMs - history.prev.atMs;
    if (deltaRemaining <= 0 || deltaMs <= 0) return null;
    return {
      remainingPercentPerMs: deltaRemaining / deltaMs,
      observedAtMs: history.latest.atMs,
      remainingPercent: history.latest.remainingPct,
      groupGeneration: history.latest.groupGeneration,
      effectiveMeterId: history.latest.effectiveMeterId,
      providerLimitId: history.latest.providerLimitId,
      resetAtMs: history.latest.resetAtMs,
    };
  }

  recordProfileSnapshot(input: ProfileSnapshotKeyInput & Readonly<{ snapshot: ConnectedServiceQuotaSnapshotV1 }>): void {
    const key = profileSnapshotKey(input);
    if (shouldRecordSnapshot(this.snapshotsByProfileKey.get(key), input.snapshot, Date.now())) {
      this.snapshotsByProfileKey.set(key, input.snapshot);
    }
  }

  getSnapshot(input: SnapshotKeyInput): ConnectedServiceQuotaSnapshotV1 | null {
    return selectFreshestSnapshot(
      this.snapshotsByKey.get(snapshotKey(input)),
      this.snapshotsByProfileKey.get(profileSnapshotKey(input)),
      Date.now(),
    );
  }

  buildMemberStates(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    capturedAtMs: number;
  }>): Map<string, ConnectedServiceAuthGroupMemberRuntimeState> {
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
    const prefix = `${input.serviceId}\0${input.groupId}\0`;
    for (const [key, snapshot] of this.snapshotsByKey.entries()) {
      if (!key.startsWith(prefix)) continue;
      const profileId = key.slice(prefix.length);
      const profileSnapshot = this.snapshotsByProfileKey.get(profileSnapshotKey({
        serviceId: input.serviceId,
        profileId,
      }));
      states.set(profileId, buildMemberState(
        selectFreshestSnapshot(snapshot, profileSnapshot, input.capturedAtMs) ?? snapshot,
      ));
    }
    const profilePrefix = `${input.serviceId}\0`;
    for (const [key, snapshot] of this.snapshotsByProfileKey.entries()) {
      if (!key.startsWith(profilePrefix)) continue;
      const profileId = key.slice(profilePrefix.length);
      if (states.has(profileId)) continue;
      states.set(profileId, buildMemberState(snapshot));
    }
    return states;
  }
}

function buildMemberState(snapshot: ConnectedServiceQuotaSnapshotV1): ConnectedServiceAuthGroupMemberRuntimeState {
  return buildConnectedServiceAuthGroupRuntimeStateFromMeters({
    capturedAtMs: snapshot.fetchedAt,
    meters: snapshot.meters,
    subscription: snapshot.subscription,
  });
}
