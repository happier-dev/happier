import type {
  ConnectedServiceAuthGroupQuotaLimitSelectionV1,
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
  ProviderAccountUsageOrganizationContext,
} from '@happier-dev/protocol';
import { compareConnectedServiceQuotaObservationRecency, isProviderAccountUsageOrganizationContextMatch } from '@happier-dev/protocol';

import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { buildConnectedServiceAuthGroupRuntimeStateFromMeters } from './projection';

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

export type ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry = Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1;
  verifiedCredentialFingerprint?: string | null;
}>;

type SnapshotCurrentContext = Readonly<{
  context: ProviderAccountUsageOrganizationContext | null;
  verifiedCredentialFingerprint?: string | null;
}>;

function selectFreshestSnapshotEntry(
  first: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry | null | undefined,
  second: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry | null | undefined,
  nowMs: number,
): ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return compareConnectedServiceQuotaObservationRecency({
    existingObservedAtMs: readFetchedAt(first.snapshot),
    incomingObservedAtMs: readFetchedAt(second.snapshot),
    nowMs,
  }) === 'incoming_newer' ? second : first;
}

function isSnapshotEntryCurrent(
  entry: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry,
  current: SnapshotCurrentContext,
): boolean {
  if (entry.snapshot.providerOrganizationId) {
    return isProviderAccountUsageOrganizationContextMatch(entry.snapshot, current.context);
  }
  return Boolean(current.context?.providerAccountId
    && entry.snapshot.activeAccountId === current.context.providerAccountId
    && current.verifiedCredentialFingerprint
    && entry.verifiedCredentialFingerprint === current.verifiedCredentialFingerprint);
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
type BurnHistory = Readonly<{ observations: readonly BurnObservation[] }>;

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
  private readonly snapshotsByKey = new Map<string, ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry>();
  private readonly snapshotsByProfileKey = new Map<string, ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry>();
  private readonly burnHistoryByKey = new Map<string, BurnHistory>();

  recordSnapshot(input: SnapshotKeyInput & ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry): void {
    const key = snapshotKey(input);
    const nowMs = Date.now();
    const existing = this.snapshotsByKey.get(key);
    if (shouldRecordSnapshot(existing?.snapshot, input.snapshot, nowMs)) {
      if (existing && (existing.snapshot.providerOrganizationId || input.snapshot.providerOrganizationId
        || existing.verifiedCredentialFingerprint || input.verifiedCredentialFingerprint)
        && !isSnapshotEntryCurrent(existing, {
          context: {
            providerAccountId: input.snapshot.activeAccountId ?? null,
            providerOrganizationId: input.snapshot.providerOrganizationId ?? null,
          },
          verifiedCredentialFingerprint: input.verifiedCredentialFingerprint,
        })) {
        this.burnHistoryByKey.delete(key);
      }
      this.snapshotsByKey.set(key, {
        snapshot: input.snapshot,
        verifiedCredentialFingerprint: input.verifiedCredentialFingerprint,
      });
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
    const existingLatest = existing?.observations.at(-1);
    // Only advance the history when this observation is strictly newer than the latest one; a
    // duplicate/stale fetchedAt would otherwise poison the delta with a zero time window.
    if (existingLatest && compareConnectedServiceQuotaObservationRecency({
      existingObservedAtMs: existingLatest.atMs,
      incomingObservedAtMs: observation.atMs,
      nowMs,
    }) !== 'incoming_newer') return;
    if (existingLatest && isSameBurnContext(existingLatest, observation)
      && observation.remainingPct > existingLatest.remainingPct) {
      this.burnHistoryByKey.set(key, { observations: [observation] });
      return;
    }
    if (existingLatest && isSameBurnContext(existingLatest, observation)
      && observation.remainingPct === existingLatest.remainingPct) {
      const observations = existing?.observations ?? [];
      this.burnHistoryByKey.set(key, {
        observations: observations.length === 1
          ? [...observations, observation]
          : [...observations.slice(0, -1), observation],
      });
      return;
    }
    this.burnHistoryByKey.set(key, existingLatest && isSameBurnContext(existingLatest, observation)
      ? { observations: [...existing?.observations ?? [], observation] }
      : { observations: [observation] });
  }

  /**
   * Recent consumption velocity of the effective meter's remaining% for a member, derived from the
   * in-band snapshots this store retained. When a minimum observation duration is supplied, the
   * baseline is the oldest same-context observation at or before that horizon and is retained until
   * a newer observation can replace it. Only a DECREASING remaining% (real burn) yields a value; a
   * strict increase (a reset/replenish) clears the baseline, while equal readings refresh the
   * latest timestamp so the predictive projection remains current. This is the fast-burn signal
   * the poll-driven soft-switch cannot see between 30-minute quota polls.
   */
  getRecentBurn(input: SnapshotKeyInput & Readonly<{
    nowMs?: number;
    maxAgeMs?: number;
    minObservationDurationMs?: number;
    currentQuotaSnapshot?: ConnectedServiceAuthGroupMemberRuntimeState['quotaSnapshot'];
  }>): ConnectedServiceAuthGroupRuntimeQuotaBurn | null {
    const history = this.burnHistoryByKey.get(snapshotKey(input));
    if (!history || history.observations.length < 2) return null;
    const latest = history.observations.at(-1)!;
    if (
      typeof input.groupGeneration === 'number'
      && latest.groupGeneration !== Math.max(0, Math.trunc(input.groupGeneration))
    ) return null;
    if (typeof input.nowMs === 'number' && typeof input.maxAgeMs === 'number') {
      const ageMs = input.nowMs - latest.atMs;
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > Math.max(0, input.maxAgeMs)) return null;
    }
    if (
      typeof input.nowMs === 'number'
      && Number.isFinite(input.nowMs)
      && typeof latest.resetAtMs === 'number'
      && Number.isFinite(latest.resetAtMs)
      && input.nowMs >= latest.resetAtMs
    ) return null;
    const currentQuotaSnapshot = input.currentQuotaSnapshot;
    if (currentQuotaSnapshot) {
      if (latest.atMs !== currentQuotaSnapshot.capturedAtMs) return null;
      if (latest.remainingPct !== currentQuotaSnapshot.effectiveRemainingPercent) return null;
      if (latest.effectiveMeterId !== currentQuotaSnapshot.effectiveMeterId) return null;
      const currentMeter = currentQuotaSnapshot.meters?.find(
        (meter) => meter.meterId === currentQuotaSnapshot.effectiveMeterId,
      ) ?? null;
      if (
        latest.providerLimitId !== (currentMeter?.providerLimitId ?? null)
        || latest.resetAtMs !== (currentMeter?.resetAtMs ?? null)
      ) return null;
    }
    const minimumDurationMs = input.minObservationDurationMs === undefined
      ? 0
      : input.minObservationDurationMs;
    if (!Number.isFinite(minimumDurationMs) || minimumDurationMs < 0) return null;
    let baselineIndex = history.observations.length - 2;
    if (minimumDurationMs > 0) {
      const cutoffAtMs = latest.atMs - minimumDurationMs;
      baselineIndex = -1;
      for (let index = 0; index < history.observations.length - 1; index += 1) {
        if (history.observations[index]!.atMs <= cutoffAtMs) baselineIndex = index;
        else break;
      }
      if (baselineIndex < 0) return null;
      const observedDurationMs = latest.atMs - history.observations[baselineIndex]!.atMs;
      if (!Number.isFinite(observedDurationMs) || observedDurationMs < minimumDurationMs) return null;
      if (baselineIndex > 0) {
        this.burnHistoryByKey.set(snapshotKey(input), {
          observations: history.observations.slice(baselineIndex),
        });
      }
    }
    const baseline = history.observations[baselineIndex]!;
    const deltaRemaining = baseline.remainingPct - latest.remainingPct;
    const deltaMs = latest.atMs - baseline.atMs;
    if (deltaRemaining <= 0 || deltaMs <= 0) return null;
    return {
      remainingPercentPerMs: deltaRemaining / deltaMs,
      observedAtMs: latest.atMs,
      remainingPercent: latest.remainingPct,
      groupGeneration: latest.groupGeneration,
      effectiveMeterId: latest.effectiveMeterId,
      providerLimitId: latest.providerLimitId,
      resetAtMs: latest.resetAtMs,
    };
  }

  recordProfileSnapshot(input: ProfileSnapshotKeyInput & ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry): void {
    const key = profileSnapshotKey(input);
    if (shouldRecordSnapshot(this.snapshotsByProfileKey.get(key)?.snapshot, input.snapshot, Date.now())) {
      this.snapshotsByProfileKey.set(key, {
        snapshot: input.snapshot,
        verifiedCredentialFingerprint: input.verifiedCredentialFingerprint,
      });
    }
  }

  retainProfileSnapshots(input: ProfileSnapshotKeyInput & SnapshotCurrentContext): void {
    const shouldRetainEntry = (entry: ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry): boolean => {
      if (!entry.snapshot.providerOrganizationId && input.verifiedCredentialFingerprint === undefined) {
        // An unavailable credential read preserves verified bytes; reuse still requires current user/token proof.
        return Boolean(entry.verifiedCredentialFingerprint
          && (!input.context?.providerAccountId || entry.snapshot.activeAccountId === input.context.providerAccountId));
      }
      return isSnapshotEntryCurrent(entry, input);
    };
    const profileKey = profileSnapshotKey(input);
    const profileEntry = this.snapshotsByProfileKey.get(profileKey);
    if (profileEntry && !shouldRetainEntry(profileEntry)) {
      this.snapshotsByProfileKey.delete(profileKey);
    }
    const servicePrefix = `${input.serviceId}\0`;
    const profileSuffix = `\0${input.profileId}`;
    for (const [key, entry] of this.snapshotsByKey) {
      if (!key.startsWith(servicePrefix) || !key.endsWith(profileSuffix)) continue;
      if (shouldRetainEntry(entry)) continue;
      this.snapshotsByKey.delete(key);
      this.burnHistoryByKey.delete(key);
    }
  }

  getSnapshotEntry(input: ProfileSnapshotKeyInput & Readonly<{ groupId?: string }>): ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry | null {
    return selectFreshestSnapshotEntry(
      input.groupId === undefined ? null : this.snapshotsByKey.get(snapshotKey({ ...input, groupId: input.groupId })),
      this.snapshotsByProfileKey.get(profileSnapshotKey(input)),
      Date.now(),
    );
  }

  getSnapshot(input: SnapshotKeyInput): ConnectedServiceQuotaSnapshotV1 | null {
    return this.getSnapshotEntry(input)?.snapshot ?? null;
  }

  buildMemberStates(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    capturedAtMs: number;
    quotaLimitSelection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1;
  }>): Map<string, ConnectedServiceAuthGroupMemberRuntimeState> {
    void input.capturedAtMs;
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
    const prefix = `${input.serviceId}\0${input.groupId}\0`;
    for (const [key, entry] of this.snapshotsByKey.entries()) {
      if (!key.startsWith(prefix)) continue;
      const profileId = key.slice(prefix.length);
      const profileSnapshot = this.snapshotsByProfileKey.get(profileSnapshotKey({ serviceId: input.serviceId, profileId }));
      states.set(profileId, buildMemberState(
        (selectFreshestSnapshotEntry(entry, profileSnapshot, input.capturedAtMs) ?? entry).snapshot,
        input.quotaLimitSelection,
      ));
    }
    const profilePrefix = `${input.serviceId}\0`;
    for (const [key, { snapshot }] of this.snapshotsByProfileKey.entries()) {
      if (!key.startsWith(profilePrefix)) continue;
      const profileId = key.slice(profilePrefix.length);
      if (states.has(profileId)) continue;
      states.set(profileId, buildMemberState(snapshot, input.quotaLimitSelection));
    }
    return states;
  }
}

function buildMemberState(
  snapshot: ConnectedServiceQuotaSnapshotV1,
  quotaLimitSelection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1,
): ConnectedServiceAuthGroupMemberRuntimeState {
  return buildConnectedServiceAuthGroupRuntimeStateFromMeters({
    capturedAtMs: snapshot.fetchedAt,
    meters: snapshot.meters,
    subscription: snapshot.subscription,
    selection: quotaLimitSelection,
  });
}
