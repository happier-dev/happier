import type {
  ConnectedAccountServiceKey,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import { compareConnectedServiceQuotaObservationRecency } from '@happier-dev/protocol/connect/quotaObservationTime';
import { isProviderAccountUsageOrganizationContextMatch, type ProviderAccountUsageOrganizationContext } from '@happier-dev/protocol/connect/accountUsage';

import { buildConnectedServiceAuthGroupRuntimeStateFromMeters } from './projection';
import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';

type SnapshotKeyInput = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  profileId: string;
  groupGeneration?: number | null;
}>;

type ProfileSnapshotKeyInput = Readonly<{
  serviceId: ConnectedAccountServiceKey;
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

export class ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore {
  private readonly snapshotsByKey = new Map<string, ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry>();
  private readonly snapshotsByProfileKey = new Map<string, ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry>();

  recordSnapshot(input: SnapshotKeyInput & ConnectedServiceAuthGroupRuntimeQuotaSnapshotEntry): void {
    const key = snapshotKey(input);
    const nowMs = Date.now();
    const existing = this.snapshotsByKey.get(key);
    if (shouldRecordSnapshot(existing?.snapshot, input.snapshot, nowMs)) {
      this.snapshotsByKey.set(key, {
        snapshot: input.snapshot,
        verifiedCredentialFingerprint: input.verifiedCredentialFingerprint,
      });
    }
    this.recordProfileSnapshot(input);
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
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    capturedAtMs: number;
  }>): Map<string, ConnectedServiceAuthGroupMemberRuntimeState> {
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
    const prefix = `${input.serviceId}\0${input.groupId}\0`;
    for (const [key, entry] of this.snapshotsByKey.entries()) {
      if (!key.startsWith(prefix)) continue;
      const profileId = key.slice(prefix.length);
      const profileSnapshot = this.snapshotsByProfileKey.get(profileSnapshotKey({
        serviceId: input.serviceId,
        profileId,
      }));
      states.set(profileId, buildMemberState(
        (selectFreshestSnapshotEntry(entry, profileSnapshot, input.capturedAtMs) ?? entry).snapshot,
      ));
    }
    const profilePrefix = `${input.serviceId}\0`;
    for (const [key, { snapshot }] of this.snapshotsByProfileKey.entries()) {
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
    staleAfterMs: snapshot.staleAfterMs,
    meters: snapshot.meters,
    subscription: snapshot.subscription,
  });
}
