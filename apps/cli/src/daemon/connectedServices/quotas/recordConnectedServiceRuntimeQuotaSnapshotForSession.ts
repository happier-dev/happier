import type {
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
  ConnectedServiceUsageSourceV1,
  ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';

import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation } from '../accountUsage/fromConnectedServiceQuotaObservation';
import type { ProviderAccountUsagePersistenceScheduler } from '../accountUsage/persistence';
import {
  recordProviderAccountUsageSnapshotForSession,
} from '../accountUsage/recordProviderAccountUsageSnapshotForSession';
import type { ProviderAccountUsageStore } from '../accountUsage/store';
import {
  type ProviderAccountUsageObservation,
} from '../accountUsage/store';
import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import {
  parseConnectedServiceBindingSelections,
  type ConnectedServiceBindingSelection,
} from '../parseConnectedServicesBindings';
import { resolveTrackedConnectedServiceBindingsRaw } from '../trackedSessionConnectedServiceBindings';
type AccountUsageRecorderLike = Readonly<{
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId'>;
  persistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
  publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
}>;

type AccountUsageChangedNotifier = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId: string;
  groupGeneration: number;
  recordId: string;
  snapshot: ProviderAccountUsageSnapshotV1;
}>) => Promise<void> | void;

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function findTrackedSession(
  children: ReadonlyArray<TrackedSession>,
  sessionId: string,
): TrackedSession | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return children.find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

function buildAccountUsageSnapshotForRuntimeQuota(input: Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1;
  groupGeneration?: number | null;
}>): ProviderAccountUsageSnapshotV1 {
  return buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
    snapshot: input.snapshot,
  });
}

function buildRuntimeQuotaObservation(input: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  selection: ConnectedServiceBindingSelection | null;
  groupGeneration?: number | null;
}>): ProviderAccountUsageObservation {
  let source: ConnectedServiceUsageSourceV1 | undefined;
  if (input.selection?.kind === 'group') {
    source = {
      serviceId: input.serviceId,
      profileId: input.profileId,
      bindingKind: 'group_member',
      groupId: input.selection.groupId,
      ...(input.groupGeneration !== null && input.groupGeneration !== undefined
        ? { groupGeneration: input.groupGeneration }
        : {}),
    };
  } else if (input.selection?.kind === 'profile') {
    source = {
      serviceId: input.serviceId,
      profileId: input.profileId,
      bindingKind: 'profile',
    };
  }
  return {
    ...(source ? { sources: [source] } : {}),
  };
}

export async function recordConnectedServiceRuntimeQuotaSnapshotForSession(input: Readonly<{
  accountUsageRecorder?: AccountUsageRecorderLike | null;
  getChildren: () => ReadonlyArray<TrackedSession>;
  notifyAccountUsageChanged?: AccountUsageChangedNotifier;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId?: string | null;
  groupGeneration?: number | null;
  snapshot: ConnectedServiceQuotaSnapshotV1;
}>): Promise<
  | Readonly<{ status: 'recorded'; groupRuntimeStateRecorded: boolean; quotaStateRecorded: boolean }>
  | Readonly<{ status: 'session_not_found' }>
  | Readonly<{ status: 'service_id_mismatch' }>
> {
  if (input.snapshot.serviceId !== input.serviceId) return { status: 'service_id_mismatch' };

  const tracked = findTrackedSession(input.getChildren(), input.sessionId);
  if (!tracked) return { status: 'session_not_found' };

  const bindingsRaw = resolveTrackedConnectedServiceBindingsRaw(tracked);
  const selection = parseConnectedServiceBindingSelections(bindingsRaw)
    .find((candidate) => candidate.serviceId === input.serviceId) ?? null;
  const activeGroupSelection = readConnectedServiceChildSelectionsFromEnv(
    tracked.spawnOptions?.environmentVariables ?? {},
  )?.get(input.serviceId) ?? null;

  const activeGroupSelectionMatchesSnapshotProfile =
    activeGroupSelection?.kind === 'group'
    && selection?.kind === 'group'
    && activeGroupSelection.groupId === selection.groupId
    && activeGroupSelection.activeProfileId === input.snapshot.profileId;
  const reportedGroupId = normalizeNullableString(input.groupId);
  const reportedGroupGeneration = normalizeNonNegativeInt(input.groupGeneration);
  const activeGroupGeneration = activeGroupSelectionMatchesSnapshotProfile
    && selection?.kind === 'group'
    && reportedGroupId === selection.groupId
    && reportedGroupGeneration === activeGroupSelection.generation
    ? reportedGroupGeneration
    : null;

  const groupRuntimeStateRecorded = selection?.kind === 'group' && activeGroupGeneration !== null;
  if (groupRuntimeStateRecorded) {
    input.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: input.serviceId,
      groupId: selection.groupId,
      profileId: input.snapshot.profileId,
      snapshot: input.snapshot,
    });
  }

  let quotaStateRecorded = false;
  let recordedAccountUsageSnapshot: ProviderAccountUsageSnapshotV1 | null = null;
  let recordedAccountUsageRecordId: string | null = null;
  const accountUsageSnapshot = buildAccountUsageSnapshotForRuntimeQuota({
    snapshot: input.snapshot,
    groupGeneration: activeGroupGeneration,
  });
  const accountUsageObservation = buildRuntimeQuotaObservation({
    serviceId: input.serviceId,
    profileId: input.snapshot.profileId,
    selection,
    groupGeneration: activeGroupGeneration,
  });
  if (input.accountUsageRecorder) {
    try {
      const recorded = await recordProviderAccountUsageSnapshotForSession({
        getChildren: input.getChildren,
        store: input.accountUsageRecorder.store,
        persistence: input.accountUsageRecorder.persistence,
        publishRecordId: input.accountUsageRecorder.publishRecordId,
        observation: accountUsageObservation,
        sessionId: input.sessionId,
        snapshot: accountUsageSnapshot,
      });
      if (recorded.status === 'recorded') {
        quotaStateRecorded = recorded.persisted;
        recordedAccountUsageRecordId = recorded.recordId;
        recordedAccountUsageSnapshot =
          input.accountUsageRecorder.store.resolveRecordId(recorded.recordId) ?? accountUsageSnapshot;
      }
    } catch {
      quotaStateRecorded = false;
    }
  }

  if (
    recordedAccountUsageSnapshot
    && recordedAccountUsageRecordId
    && selection?.kind === 'group'
    && activeGroupGeneration !== null
  ) {
    try {
      await input.notifyAccountUsageChanged?.({
        sessionId: input.sessionId,
        serviceId: input.serviceId,
        groupId: selection.groupId,
        profileId: input.snapshot.profileId,
        groupGeneration: activeGroupGeneration,
        recordId: recordedAccountUsageRecordId,
        snapshot: recordedAccountUsageSnapshot,
      });
    } catch {
      // Account usage is canonical; connected-service policy is a best-effort consumer.
    }
  }

  return { status: 'recorded', groupRuntimeStateRecorded, quotaStateRecorded };
}
