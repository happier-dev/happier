import type {
  ConnectedAccountServiceKey,
  ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import { buildQuotaLifecycleCycleId } from '../../quotas/quotaLifecycleEventIdentity';
import {
  canDisplayAccountUsageForQuota,
  canDriveQuotaLifecycleEdge,
  type QuotaLifecycleEvidenceDecision,
} from './evidence';
import { projectProviderAccountUsageSnapshotToAuthGroupRuntimeState } from './projection';
import {
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupMemberRuntimeState,
} from '../selection/selectConnectedServiceAuthGroupCandidate';
import {
  mergePersistedMemberRuntimeState,
  normalizeConnectedServiceAuthGroupPolicy,
} from '../switching/buildConnectedServiceAuthGroupSwitchState';
import type {
  ConnectedServiceAuthGroupAccountUsageView,
} from '../switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';

export { canDisplayAccountUsageForQuota, canDriveQuotaLifecycleEdge };

export type ConnectedServiceAuthGroupQuotaLifecycleState =
  | Readonly<{ status: 'unblocked' }>
  | Readonly<{ status: 'blocked'; cycleId: string; resetAtMs: number | null }>;

export type ConnectedServiceAuthGroupQuotaLifecycleEdge =
  | Readonly<{ phase: 'no_edge' }>
  | Readonly<{
    phase: 'blocked';
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    activeProfileId: string | null;
    sessionIds: ReadonlyArray<string>;
    cycleId: string;
    issueFingerprint: string;
    resetAtMs: number | null;
    reason: 'connected_service_group_quota_exhausted';
  }>
  | Readonly<{
    phase: 'recovered';
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    activeProfileId: string | null;
    sessionIds: ReadonlyArray<string>;
    cycleId: string;
    issueFingerprint: string;
    resetAtMs: null;
    reason: 'fresh_quota_evidence';
  }>;

export type ConnectedServiceAuthGroupQuotaLifecycleEvaluation = Readonly<{
  edge: ConnectedServiceAuthGroupQuotaLifecycleEdge;
  nextState: ConnectedServiceAuthGroupQuotaLifecycleState;
}>;

type EvaluationMode = 'live_account_usage_change' | 'cold_reconstruction';

function isQuotaLifecycleBlockingExclusion(exclusion: Readonly<{ reason: string }>): boolean {
  return exclusion.reason === 'quota_exhausted' || exclusion.reason === 'capacity_limited';
}

function noEdge(
  nextState: ConnectedServiceAuthGroupQuotaLifecycleState,
): ConnectedServiceAuthGroupQuotaLifecycleEvaluation {
  return {
    edge: { phase: 'no_edge' },
    nextState,
  };
}

function readMemberRuntimeStates(input: Readonly<{
  group: ConnectedServiceAuthGroupAccountUsageView;
  changedGroupGeneration: number;
  snapshotsByProfileId: ReadonlyMap<string, ProviderAccountUsageSnapshotV1>;
  nowMs: number;
  quotaFreshnessMs: number;
  allowUnconfirmedConfidence?: boolean;
}>): Readonly<
  | { status: 'ready'; memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState> }
  | { status: 'insufficient_evidence'; decision?: QuotaLifecycleEvidenceDecision }
> {
  const memberStatesByProfileId = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
  for (const member of input.group.members) {
    if (!member.enabled) {
      memberStatesByProfileId.set(member.profileId, mergePersistedMemberRuntimeState(null, member.state));
      continue;
    }
    const snapshot = input.snapshotsByProfileId.get(member.profileId) ?? null;
    if (!snapshot) return { status: 'insufficient_evidence' };
    const decision = canDriveQuotaLifecycleEdge({
      snapshot,
      expectedGroupGeneration: input.group.generation,
      observedGroupGeneration: input.changedGroupGeneration,
      nowMs: input.nowMs,
      quotaFreshnessMs: input.quotaFreshnessMs,
      allowUnconfirmedConfidence: input.allowUnconfirmedConfidence,
    });
    if (!decision.ok) return { status: 'insufficient_evidence', decision };
    const projectedState = projectProviderAccountUsageSnapshotToAuthGroupRuntimeState(snapshot);
    if (!projectedState) return { status: 'insufficient_evidence' };
    memberStatesByProfileId.set(
      member.profileId,
      mergePersistedMemberRuntimeState(projectedState, member.state),
    );
  }
  return { status: 'ready', memberStatesByProfileId };
}

function buildMembers(group: ConnectedServiceAuthGroupAccountUsageView) {
  return group.members.map((member) => ({
    profileId: member.profileId,
    priority: member.priority,
    enabled: member.enabled,
    createdAtMs: member.createdAt,
  }));
}

export function evaluateConnectedServiceAuthGroupQuotaLifecycle(input: Readonly<{
  mode: EvaluationMode;
  group: ConnectedServiceAuthGroupAccountUsageView;
  changedProfileId: string;
  changedGroupGeneration: number;
  previousState: ConnectedServiceAuthGroupQuotaLifecycleState;
  snapshotsByProfileId: ReadonlyMap<string, ProviderAccountUsageSnapshotV1>;
  activeSessionIds: ReadonlyArray<string>;
  nowMs: number;
  quotaFreshnessMs: number;
  allowUnconfirmedConfidence?: boolean;
}>): ConnectedServiceAuthGroupQuotaLifecycleEvaluation {
  void input.changedProfileId;
  const serviceId = input.group.serviceId;
  const groupId = input.group.groupId;
  const issueFingerprint = `quota-blocked:${serviceId}:${groupId}`;

  const evidence = readMemberRuntimeStates({
    group: input.group,
    changedGroupGeneration: input.changedGroupGeneration,
    snapshotsByProfileId: input.snapshotsByProfileId,
    nowMs: input.nowMs,
    quotaFreshnessMs: input.quotaFreshnessMs,
    allowUnconfirmedConfidence: input.allowUnconfirmedConfidence,
  });
  if (evidence.status !== 'ready') return noEdge(input.previousState);

  const policy = normalizeConnectedServiceAuthGroupPolicy(input.group.policy);
  if (policy.strategy === 'manual') return noEdge({ status: 'unblocked' });

  const selection = selectConnectedServiceAuthGroupCandidate({
    nowMs: input.nowMs,
    quotaFreshnessMs: input.quotaFreshnessMs,
    activeProfileId: input.group.activeProfileId,
    policy,
    members: buildMembers(input.group),
    memberStatesByProfileId: evidence.memberStatesByProfileId,
    allowCurrentProfileRetry: true,
  });

  const quotaLikeExclusions = selection.excluded.filter(isQuotaLifecycleBlockingExclusion);
  const blocked = selection.reason === 'no_eligible_members' && quotaLikeExclusions.length > 0;
  if (blocked) {
    if (input.activeSessionIds.length === 0) return noEdge(input.previousState);
    const resetAtMs = quotaLikeExclusions
      .map((exclusion) => exclusion.retryAtMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > input.nowMs)
      .sort((left, right) => left - right)[0] ?? null;
    const cycleId = buildQuotaLifecycleCycleId({ resetAtMs });
    const nextState: ConnectedServiceAuthGroupQuotaLifecycleState = { status: 'blocked', cycleId, resetAtMs };
    if (input.mode === 'cold_reconstruction') return noEdge(nextState);
    if (input.previousState.status === 'blocked' && input.previousState.cycleId === cycleId) {
      return noEdge(input.previousState);
    }
    return {
      edge: {
        phase: 'blocked',
        serviceId,
        groupId,
        activeProfileId: input.group.activeProfileId,
        sessionIds: input.activeSessionIds,
        cycleId,
        issueFingerprint,
        resetAtMs,
        reason: 'connected_service_group_quota_exhausted',
      },
      nextState,
    };
  }

  if (input.previousState.status !== 'blocked') return noEdge({ status: 'unblocked' });
  const nextState: ConnectedServiceAuthGroupQuotaLifecycleState = { status: 'unblocked' };
  if (input.mode === 'cold_reconstruction' || (quotaLikeExclusions.length === 0 && selection.reason === 'no_eligible_members')) {
    return noEdge(nextState);
  }
  return {
    edge: {
      phase: 'recovered',
      serviceId,
      groupId,
      activeProfileId: input.group.activeProfileId,
      sessionIds: input.activeSessionIds,
      cycleId: input.previousState.cycleId,
      issueFingerprint,
      resetAtMs: null,
      reason: 'fresh_quota_evidence',
    },
    nextState,
  };
}
