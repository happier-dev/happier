import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceAuthGroupV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  canDisplayAccountUsageForQuota,
  canDriveQuotaLifecycleEdge,
  evaluateConnectedServiceAuthGroupQuotaLifecycle,
  type ConnectedServiceAuthGroupQuotaLifecycleState,
} from './lifecycle';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';

function createGroup(): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    groupId: 'team',
    displayName: 'Team',
    activeProfileId: 'primary',
    generation: 4,
    runtimeStateRevision: 0,
    policy: {
      ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      autoSwitch: true,
      strategy: 'priority',
      cooldownMs: 500,
    },
    state: { v: 1 },
    members: ['primary', 'backup'].map((profileId, index) => ({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId,
      priority: index,
      enabled: true,
      state: {},
      createdAt: index + 1,
      updatedAt: index + 1,
    })),
    createdAt: 1,
    updatedAt: 2,
  };
}

function createUsageSnapshot(input: Readonly<{
  profileId: string;
  nowMs: number;
  remainingPct: number;
  resetAtMs?: number | null;
  fetchedAtMs?: number;
  staleAfterMs?: number;
  confidence?: ProviderAccountUsageSnapshotV1['confidence'];
  accountSubjectKind?: ProviderAccountUsageSnapshotV1['accountSubject']['kind'];
}>): ProviderAccountUsageSnapshotV1 {
  const accountSubjectId = `acct_${input.profileId}`;
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId,
    subjectKind: input.accountSubjectKind === 'provisionalLocalSubject' ? 'unknown' : 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: input.accountSubjectKind === 'provisionalLocalSubject'
      ? { kind: 'provisionalLocalSubject', id: accountSubjectId, mergeKey: `openai-codex:${input.profileId}` }
      : { kind: 'providerSubject', id: accountSubjectId },
    observedAtMs: input.nowMs,
    fetchedAtMs: input.fetchedAtMs ?? input.nowMs,
    staleAfterMs: input.staleAfterMs ?? 300_000,
    source: 'runtimeSignal',
    confidence: input.confidence ?? 'confirmed',
    state: 'loaded_data',
    planLabel: 'Pro',
    accountLabel: `${input.profileId}@example.test`,
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: null,
      limit: null,
      unit: 'unknown',
      utilizationPct: 100 - input.remainingPct,
      remainingPct: input.remainingPct,
      resetsAt: input.resetAtMs ?? null,
      status: 'ok',
      details: { limitCategory: 'usage_limit' },
    }],
  };
}

function snapshotMap(...snapshots: ProviderAccountUsageSnapshotV1[]): Map<string, ProviderAccountUsageSnapshotV1> {
  return new Map(snapshots.map((snapshot) => {
    return [snapshot.recordKey.accountSubjectId.replace(/^acct_/, ''), snapshot] as const;
  }));
}

describe('evaluateConnectedServiceAuthGroupQuotaLifecycle', () => {
  it('emits exactly one blocked edge and one recovered edge for live fresh stable account-usage evidence', () => {
    const nowMs = 1_000_000;
    const resetAtMs = nowMs + 600_000;
    const group = createGroup();
    const primaryBlocked = createUsageSnapshot({ profileId: 'primary', nowMs, remainingPct: 0, resetAtMs });
    const backupBlocked = createUsageSnapshot({ profileId: 'backup', nowMs, remainingPct: 0, resetAtMs });

    const first = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'primary',
      changedGroupGeneration: group.generation,
      previousState: { status: 'unblocked' },
      snapshotsByProfileId: snapshotMap(primaryBlocked, backupBlocked),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });
    expect(first.edge).toEqual(expect.objectContaining({
      phase: 'blocked',
      resetAtMs,
      sessionIds: ['session-1'],
    }));
    expect(first.nextState).toEqual({
      status: 'blocked',
      cycleId: `reset_at_${Math.floor(resetAtMs / 60_000) * 60_000}`,
      resetAtMs,
    });

    const duplicate = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'primary',
      changedGroupGeneration: group.generation,
      previousState: first.nextState,
      snapshotsByProfileId: snapshotMap(primaryBlocked, backupBlocked),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });
    expect(duplicate.edge).toEqual({ phase: 'no_edge' });
    expect(duplicate.nextState).toBe(first.nextState);

    const backupRecovered = createUsageSnapshot({ profileId: 'backup', nowMs: nowMs + 1_000, remainingPct: 80 });
    const recovered = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'backup',
      changedGroupGeneration: group.generation,
      previousState: duplicate.nextState,
      snapshotsByProfileId: snapshotMap(primaryBlocked, backupRecovered),
      activeSessionIds: ['session-1'],
      nowMs: nowMs + 1_000,
      quotaFreshnessMs: 300_000,
    });
    expect(recovered.edge).toEqual(expect.objectContaining({
      phase: 'recovered',
      cycleId: first.nextState.status === 'blocked' ? first.nextState.cycleId : '',
      sessionIds: ['session-1'],
    }));
    expect(recovered.nextState).toEqual({ status: 'unblocked' });
  });

  it('reconstructs cold blocked state without emitting wait or recovered edges', () => {
    const nowMs = 1_000_000;
    const resetAtMs = nowMs + 600_000;
    const group = createGroup();

    const cold = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'cold_reconstruction',
      group,
      changedProfileId: 'primary',
      changedGroupGeneration: group.generation,
      previousState: { status: 'unblocked' },
      snapshotsByProfileId: snapshotMap(
        createUsageSnapshot({ profileId: 'primary', nowMs, remainingPct: 0, resetAtMs }),
        createUsageSnapshot({ profileId: 'backup', nowMs, remainingPct: 0, resetAtMs }),
      ),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });

    expect(cold.edge).toEqual({ phase: 'no_edge' });
    expect(cold.nextState).toEqual({
      status: 'blocked',
      cycleId: `reset_at_${Math.floor(resetAtMs / 60_000) * 60_000}`,
      resetAtMs,
    });
  });

  it('does not infer blocked or recovered edges from partial group evidence', () => {
    const nowMs = 1_000_000;
    const group = createGroup();

    const partialBlocked = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'primary',
      changedGroupGeneration: group.generation,
      previousState: { status: 'unblocked' },
      snapshotsByProfileId: snapshotMap(createUsageSnapshot({ profileId: 'primary', nowMs, remainingPct: 0 })),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });
    expect(partialBlocked.edge).toEqual({ phase: 'no_edge' });
    expect(partialBlocked.nextState).toEqual({ status: 'unblocked' });

    const previousState: ConnectedServiceAuthGroupQuotaLifecycleState = {
      status: 'blocked',
      cycleId: 'reset_at_1200000',
      resetAtMs: 1_200_000,
    };
    const partialRecovered = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'backup',
      changedGroupGeneration: group.generation,
      previousState,
      snapshotsByProfileId: snapshotMap(createUsageSnapshot({ profileId: 'backup', nowMs, remainingPct: 80 })),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });
    expect(partialRecovered.edge).toEqual({ phase: 'no_edge' });
    expect(partialRecovered.nextState).toBe(previousState);
  });

  it('rejects stale snapshots and mismatched generations as lifecycle drivers', () => {
    const nowMs = 1_000_000;
    const group = createGroup();
    const stalePrimary = createUsageSnapshot({
      profileId: 'primary',
      nowMs,
      remainingPct: 0,
      fetchedAtMs: nowMs - 900_000,
      staleAfterMs: 60_000,
    });
    const backupBlocked = createUsageSnapshot({ profileId: 'backup', nowMs, remainingPct: 0 });

    const stale = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'primary',
      changedGroupGeneration: group.generation,
      previousState: { status: 'unblocked' },
      snapshotsByProfileId: snapshotMap(stalePrimary, backupBlocked),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });
    expect(stale.edge).toEqual({ phase: 'no_edge' });

    const future = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'primary',
      changedGroupGeneration: group.generation,
      previousState: { status: 'unblocked' },
      snapshotsByProfileId: snapshotMap(
        createUsageSnapshot({ profileId: 'primary', nowMs, remainingPct: 0, fetchedAtMs: nowMs + 900_000 }),
        backupBlocked,
      ),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });
    expect(future.edge).toEqual({ phase: 'no_edge' });
    expect(future.nextState).toEqual({ status: 'unblocked' });

    const mismatchedGeneration = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'backup',
      changedGroupGeneration: group.generation - 1,
      previousState: { status: 'unblocked' },
      snapshotsByProfileId: snapshotMap(
        createUsageSnapshot({ profileId: 'primary', nowMs, remainingPct: 0 }),
        backupBlocked,
      ),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });
    expect(mismatchedGeneration.edge).toEqual({ phase: 'no_edge' });
  });

  it('dedupes the same reset window and allows a new reset window to emit a new blocked edge', () => {
    const nowMs = 1_000_000;
    const group = createGroup();
    const previousState: ConnectedServiceAuthGroupQuotaLifecycleState = {
      status: 'blocked',
      cycleId: 'reset_at_1200000',
      resetAtMs: 1_200_000,
    };

    const sameWindow = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'primary',
      changedGroupGeneration: group.generation,
      previousState,
      snapshotsByProfileId: snapshotMap(
        createUsageSnapshot({ profileId: 'primary', nowMs, remainingPct: 0, resetAtMs: 1_205_000 }),
        createUsageSnapshot({ profileId: 'backup', nowMs, remainingPct: 0, resetAtMs: 1_205_000 }),
      ),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });
    expect(sameWindow.edge).toEqual({ phase: 'no_edge' });
    expect(sameWindow.nextState).toEqual(previousState);

    const newWindow = evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'primary',
      changedGroupGeneration: group.generation,
      previousState,
      snapshotsByProfileId: snapshotMap(
        createUsageSnapshot({ profileId: 'primary', nowMs, remainingPct: 0, resetAtMs: 1_800_000 }),
        createUsageSnapshot({ profileId: 'backup', nowMs, remainingPct: 0, resetAtMs: 1_800_000 }),
      ),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });
    expect(newWindow.edge).toEqual(expect.objectContaining({
      phase: 'blocked',
      resetAtMs: 1_800_000,
    }));
    expect(newWindow.nextState).toEqual({
      status: 'blocked',
      cycleId: 'reset_at_1800000',
      resetAtMs: 1_800_000,
    });
  });

  it('allows uncertain usage display but rejects estimated or unknown confidence for lifecycle policy unless explicitly allowed', () => {
    const nowMs = 1_000_000;
    const estimated = createUsageSnapshot({ profileId: 'primary', nowMs, remainingPct: 0, confidence: 'estimated' });
    const unknown = createUsageSnapshot({ profileId: 'backup', nowMs, remainingPct: 0, confidence: 'unknown' });

    expect(canDisplayAccountUsageForQuota(estimated)).toBe(true);
    expect(canDisplayAccountUsageForQuota(unknown)).toBe(true);
    expect(canDriveQuotaLifecycleEdge({
      snapshot: estimated,
      expectedGroupGeneration: 4,
      observedGroupGeneration: 4,
      nowMs,
      quotaFreshnessMs: 300_000,
    })).toEqual({ ok: false, reason: 'insufficient_confidence' });
    expect(canDriveQuotaLifecycleEdge({
      snapshot: unknown,
      expectedGroupGeneration: 4,
      observedGroupGeneration: 4,
      nowMs,
      quotaFreshnessMs: 300_000,
    })).toEqual({ ok: false, reason: 'insufficient_confidence' });
    expect(canDriveQuotaLifecycleEdge({
      snapshot: estimated,
      expectedGroupGeneration: 4,
      observedGroupGeneration: 4,
      nowMs,
      quotaFreshnessMs: 300_000,
      allowUnconfirmedConfidence: true,
    })).toEqual({ ok: true });
    expect(canDriveQuotaLifecycleEdge({
      snapshot: unknown,
      expectedGroupGeneration: 4,
      observedGroupGeneration: 4,
      nowMs,
      quotaFreshnessMs: 300_000,
      allowUnconfirmedConfidence: true,
    })).toEqual({ ok: true });
  });
});

describe('quota lifecycle with provider credits', () => {
  it('does not park sessions on a spent pool whose active account still has credits', () => {
    const nowMs = 1_000_000;
    const resetAtMs = nowMs + 600_000;
    const group = createGroup();
    const primarySpent = createUsageSnapshot({ profileId: 'primary', nowMs, remainingPct: 0, resetAtMs });
    const backupSpent = createUsageSnapshot({ profileId: 'backup', nowMs, remainingPct: 0, resetAtMs });
    const evaluate = (primary: ProviderAccountUsageSnapshotV1) => evaluateConnectedServiceAuthGroupQuotaLifecycle({
      mode: 'live_account_usage_change',
      group,
      changedProfileId: 'primary',
      changedGroupGeneration: group.generation,
      previousState: { status: 'unblocked' },
      snapshotsByProfileId: snapshotMap(primary, backupSpent),
      activeSessionIds: ['session-1'],
      nowMs,
      quotaFreshnessMs: 300_000,
    });

    const withCredits = evaluate({ ...primarySpent, meters: [...primarySpent.meters, {
      meterId: 'credits', label: 'Credits', used: null, limit: null, remaining: 16_845, unit: 'credits',
      utilizationPct: null, resetsAt: null, isExhausted: false, status: 'ok', details: {},
    }] });
    expect(withCredits.edge).toEqual({ phase: 'no_edge' });
    expect(withCredits.nextState).toEqual({ status: 'unblocked' });

    const creditsSpent = evaluate({ ...primarySpent, meters: [...primarySpent.meters, {
      meterId: 'credits', label: 'Credits', used: null, limit: null, remaining: 0, unit: 'credits',
      utilizationPct: null, resetsAt: null, isExhausted: true, status: 'ok', details: {},
    }] });
    expect(creditsSpent.edge).toEqual(expect.objectContaining({ phase: 'blocked' }));
  });
});
