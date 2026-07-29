import type {
  ConnectedServiceId,
  ConnectedServiceLimitCategoryV1,
  ConnectedServiceQuotaMeterV1,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import { readConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol';

import {
  normalizeQuotaMeter,
  selectEffectiveQuotaMeter,
  type NormalizedQuotaMeter,
} from '../../quotas/normalization';
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
): ConnectedServiceQuotaSnapshotV1 | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return readFetchedAt(second) > readFetchedAt(first) ? second : first;
}

function shouldRecordSnapshot(
  existing: ConnectedServiceQuotaSnapshotV1 | null | undefined,
  incoming: ConnectedServiceQuotaSnapshotV1,
): boolean {
  if (!existing) return true;
  return readFetchedAt(incoming) >= readFetchedAt(existing);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readLimitCategory(value: unknown): ConnectedServiceLimitCategoryV1 {
  return readConnectedServiceLimitCategoryV1(value) ?? 'usage_limit';
}

function isReliableMeter(meter: ConnectedServiceQuotaMeterV1): boolean | undefined {
  if (meter.status === 'unavailable') return false;
  if (meter.confidence === 'stale' || meter.confidence === 'unknown' || meter.confidence === 'estimated') return false;
  if (meter.status === 'estimated') return false;
  return undefined;
}

function normalizeSnapshotMeter(meter: ConnectedServiceQuotaMeterV1): NormalizedQuotaMeter {
  const details = isRecord(meter.details) ? meter.details : {};
  const meterRecord = meter as unknown as Record<string, unknown>;
  return normalizeQuotaMeter({
    meterId: meter.meterId,
    label: meter.label,
    limitCategory: readLimitCategory(meterRecord.limitCategory ?? details.limitCategory),
    remainingPct: meter.remainingPct,
    utilizationPct: meter.utilizationPct,
    used: meter.used,
    limit: meter.limit,
    resetAtMs: meter.resetAtMs ?? meter.resetsAt,
    providerLimitId: readString(meter.providerLimitId) ?? readString(details.providerLimitId),
    reliable: isReliableMeter(meter),
    applicable: meter.status !== 'unavailable',
  });
}

function readProviderResetsAtMs(snapshot: ConnectedServiceQuotaSnapshotV1): number | null {
  const resetValues = snapshot.meters
    .map((meter) => meter.resetAtMs ?? meter.resetsAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return resetValues.length > 0 ? Math.min(...resetValues) : null;
}

function isExhausted(snapshot: ConnectedServiceQuotaSnapshotV1): boolean {
  const effective = selectEffectiveQuotaMeter(snapshot.meters.map(normalizeSnapshotMeter));
  if (effective?.remainingPct !== null && effective?.remainingPct !== undefined) {
    return effective.remainingPct <= 0;
  }
  return false;
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
    if (shouldRecordSnapshot(this.snapshotsByKey.get(key), input.snapshot)) {
      this.snapshotsByKey.set(key, input.snapshot);
      this.recordBurnObservation(key, input.snapshot, input.groupGeneration);
    }
    this.recordProfileSnapshot(input);
  }

  private recordBurnObservation(
    key: string,
    snapshot: ConnectedServiceQuotaSnapshotV1,
    groupGeneration: number | null | undefined,
  ): void {
    const observation = readBurnObservation(snapshot, groupGeneration);
    if (!observation) return;
    const existing = this.burnHistoryByKey.get(key);
    // Only advance the history when this observation is strictly newer than the latest one; a
    // duplicate/stale fetchedAt would otherwise poison the delta with a zero time window.
    if (existing && observation.atMs <= existing.latest.atMs) return;
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
    if (shouldRecordSnapshot(this.snapshotsByProfileKey.get(key), input.snapshot)) {
      this.snapshotsByProfileKey.set(key, input.snapshot);
    }
  }

  getSnapshot(input: SnapshotKeyInput): ConnectedServiceQuotaSnapshotV1 | null {
    return selectFreshestSnapshot(
      this.snapshotsByKey.get(snapshotKey(input)),
      this.snapshotsByProfileKey.get(profileSnapshotKey(input)),
    );
  }

  buildMemberStates(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    capturedAtMs: number;
  }>): Map<string, ConnectedServiceAuthGroupMemberRuntimeState> {
    void input.capturedAtMs;
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
    const prefix = `${input.serviceId}\0${input.groupId}\0`;
    for (const [key, snapshot] of this.snapshotsByKey.entries()) {
      if (!key.startsWith(prefix)) continue;
      const profileId = key.slice(prefix.length);
      const profileSnapshot = this.snapshotsByProfileKey.get(profileSnapshotKey({
        serviceId: input.serviceId,
        profileId,
      }));
      states.set(profileId, buildMemberState(selectFreshestSnapshot(snapshot, profileSnapshot) ?? snapshot));
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
  const normalizedMeters = snapshot.meters.map(normalizeSnapshotMeter);
  const effectiveMeter = selectEffectiveQuotaMeter(normalizedMeters);
  return {
    providerResetsAtMs: effectiveMeter?.resetAtMs ?? readProviderResetsAtMs(snapshot),
    quotaSnapshot: {
      capturedAtMs: snapshot.fetchedAt,
      effectiveMeterId: effectiveMeter?.meterId ?? null,
      effectiveRemainingPercent: effectiveMeter?.remainingPct ?? null,
      meters: normalizedMeters.map((meter) => ({
        meterId: meter.meterId,
        limitCategory: meter.limitCategory,
        remainingPct: meter.remainingPct,
        resetAtMs: meter.resetAtMs,
        providerLimitId: meter.providerLimitId,
      })),
      exhausted: isExhausted(snapshot),
      planUnavailable: snapshot.meters.length > 0 && snapshot.meters.every((meter) => meter.status === 'unavailable'),
    },
  };
}
