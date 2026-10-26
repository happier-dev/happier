import { ConnectedServiceQuotaMeterV1Schema } from '@happier-dev/protocol';
import { buildConnectedServiceAuthGroupRuntimeStateFromMeters } from '../quotas/projection';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';
import {
  ConnectedServiceAuthGroupQuotaProbeIncompleteError,
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
  type ConnectedServiceAuthGroupSwitchState,
} from './ConnectedServiceAuthGroupSwitchCoordinator';
import { createConnectedServiceAuthGenerationApplyFailureError } from '../../runtimeAuth/connectedServiceAuthGenerationApplyFailure';

function state(activeProfileId: string, generation: number): ConnectedServiceAuthGroupSwitchState {
  return {
    serviceId: 'openai-codex',
    groupId: 'main',
    activeProfileId,
    generation,
    runtimeStateRevision: 0,
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true },
    members: [
      { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
    ],
    memberStatesByProfileId: new Map(),
  };
}

class TestGenerationConflictError extends Error {
  constructor(readonly generation: number) {
    super('connect_group_generation_conflict');
  }
}

describe('ConnectedServiceAuthGroupSwitchCoordinator', () => {
  it('recovers an actual rejection on an unselected allowance while retaining selected-meter candidate eligibility', async () => {
    let current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      policy: {
        ...state('primary', 1).policy,
        quotaLimitSelection: { mode: 'selected', providerLimitIds: ['five_hour', 'seven_day_opus'] },
      },
      memberStatesByProfileId: new Map(['primary', 'backup'].map((profileId) => [profileId,
        buildConnectedServiceAuthGroupRuntimeStateFromMeters({
          capturedAtMs: 999,
          selection: { mode: 'selected', providerLimitIds: ['five_hour', 'seven_day_opus'] },
          meters: [
            ConnectedServiceQuotaMeterV1Schema.parse({ meterId: 'five_hour', label: 'Session', providerLimitId: 'five_hour', remainingPct: 80, used: null, limit: null, unit: 'unknown', utilizationPct: 20, resetsAt: null, status: 'ok' }),
            ConnectedServiceQuotaMeterV1Schema.parse({ meterId: 'overage', label: 'Extra usage', providerLimitId: 'overage', remainingPct: 0, used: null, limit: null, unit: 'unknown', utilizationPct: 100, resetsAt: null, status: 'ok' }),
          ],
        }),
      ])),
    };
    const applied: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000, quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => (current = { ...current, activeProfileId: toProfileId, generation: 2 }),
      applyGeneration: async ({ activeProfileId }) => { applied.push(activeProfileId!); return { mode: 'hot_apply' }; },
    });
    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex', groupId: 'main', observedProfileId: 'primary',
      reason: 'usage_limit', providerLimitId: 'overage',
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup' });
    expect(applied).toEqual(['backup']);
  });

  it('honors a recovery policy change during reset preparation before spending a credit', async () => {
    let stored: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      policy: { ...state('primary', 1).policy, autoUseQuotaResetsWhenExhausted: true },
      memberStatesByProfileId: new Map(['primary', 'backup'].map((profileId) => [profileId, {
        quotaSnapshot: { capturedAtMs: 900, effectiveRemainingPercent: 0, meters: [
          { meterId: 'weekly', limitCategory: 'usage_limit' as const, remainingPct: 0, resetAtMs: 100_000, providerLimitId: null },
        ] },
      }])),
    };
    const debits: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000, quotaFreshnessMs: 60_000,
      loadState: async () => stored,
      prepareCandidateForSwitch: async () => {
        stored = { ...stored, policy: { ...stored.policy, recoveryMode: 'off' } };
        return { status: 'ready' };
      },
      commitSwitch: async () => { throw new Error('disabled recovery must not switch'); },
      applyGeneration: async () => { throw new Error('disabled recovery must not apply'); },
      consumeAvailableRecoveryCreditForProfile: async ({ profileId }) => {
        debits.push(profileId);
        return { ok: false, errorCode: 'connected_service_quota_recovery_credit_not_available', error: 'not available' };
      },
    });
    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex', groupId: 'main', reason: 'usage_limit', observedProfileId: 'primary',
    })).resolves.toMatchObject({ status: 'auto_switch_disabled' });
    expect(debits).toEqual([]);
  });

  it.each(['before_debit', 'not_available'] as const)('adopts newly healthy quota %s without spending another reset', async (when) => {
    let stored: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1), policy: { ...state('primary', 1).policy, autoUseQuotaResetsWhenExhausted: true },
      memberStatesByProfileId: new Map(['primary', 'backup'].map((profileId) => [profileId, {
        quotaSnapshot: { capturedAtMs: 900, effectiveRemainingPercent: 0, meters: [
          { meterId: 'weekly', limitCategory: 'usage_limit' as const, remainingPct: 0, resetAtMs: 100_000, providerLimitId: null },
        ] },
      }])),
    };
    const restore = () => { stored = { ...stored, memberStatesByProfileId: new Map(stored.memberStatesByProfileId).set('primary', {
      quotaSnapshot: { capturedAtMs: 1_000, effectiveRemainingPercent: 100 },
    }) }; };
    const debits: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000, quotaFreshnessMs: 60_000,
      loadState: async () => stored,
      prepareCandidateForSwitch: async () => { if (when === 'before_debit') restore(); return { status: 'ready' }; },
      commitSwitch: async () => { throw new Error('must not rotate from the healthy account'); },
      applyGeneration: async () => ({ mode: 'hot_apply' }),
      consumeAvailableRecoveryCreditForProfile: async ({ profileId }) => {
        debits.push(profileId);
        restore();
        return { ok: true, snapshot: null, receipt: { status: 'not_available', idempotencyKey: 'reset:primary' } };
      },
    });
    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex', groupId: 'main', reason: 'usage_limit', observedProfileId: 'primary',
    })).resolves.toMatchObject({ status: 'observed_generation', activeProfileId: 'primary' });
    expect(debits).toEqual(when === 'before_debit' ? [] : ['primary']);
  });

  it.each([false, true])('never cascades ambiguous reset expenditure (opt-in %s)', async (enabled) => {
    const initial: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      policy: { ...state('primary', 1).policy, autoUseQuotaResetsWhenExhausted: enabled },
      memberStatesByProfileId: new Map(['primary', 'backup'].map((profileId) => [profileId, {
        quotaSnapshot: { capturedAtMs: 900, meters: [
          { meterId: 'weekly', limitCategory: 'usage_limit' as const, remainingPct: 0, resetAtMs: 100_000, providerLimitId: null },
        ] },
      }])),
    };
    const attempts: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000, quotaFreshnessMs: 60_000,
      loadState: async () => initial,
      commitSwitch: async () => { throw new Error('must not switch without fresh usable evidence'); },
      applyGeneration: async () => { throw new Error('must not continue without fresh usable evidence'); },
      consumeAvailableRecoveryCreditForProfile: async ({ profileId }) => {
        attempts.push(profileId);
        return { ok: false, errorCode: 'connected_service_quota_recovery_credit_timeout', error: 'timeout' };
      },
    });
    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex', groupId: 'main', reason: 'usage_limit', observedProfileId: 'primary',
    })).resolves.toMatchObject({ status: 'no_eligible_member' });
    expect(attempts).toEqual(enabled ? ['primary'] : []);
  });

  it.each(['primary', 'backup'])('uses one reset after quota exhaustion and reuses generation application for %s', async (resetProfile) => {
    let stored: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      policy: { ...state('primary', 1).policy, autoUseQuotaResetsWhenExhausted: true },
      memberStatesByProfileId: new Map(['primary', 'backup'].map((profileId) => [profileId, {
        quotaSnapshot: { capturedAtMs: 900, effectiveRemainingPercent: 0, meters: [
          { meterId: 'weekly', limitCategory: 'usage_limit' as const, remainingPct: 0, resetAtMs: 100_000, providerLimitId: null },
        ] },
      }])),
    };
    const applied: string[] = [];
    const redeemed: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => stored,
      commitSwitch: async ({ toProfileId }) => (stored = { ...stored, activeProfileId: toProfileId, generation: 2 }),
      applyGeneration: async ({ activeProfileId }) => { applied.push(activeProfileId!); return { mode: 'hot_apply' }; },
      consumeAvailableRecoveryCreditForProfile: async ({ profileId }) => {
        if (profileId !== resetProfile) return { ok: false, errorCode: 'connected_service_quota_recovery_credit_not_available', error: 'not available' };
        redeemed.push(profileId);
        stored = { ...stored, memberStatesByProfileId: new Map(stored.memberStatesByProfileId).set(profileId, {
          quotaSnapshot: { capturedAtMs: 1_000, effectiveRemainingPercent: 100 },
        }) };
        return { ok: true, snapshot: null, receipt: { idempotencyKey: `reset:${profileId}`, status: 'consumed' } };
      },
    });
    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'source-session', serviceId: 'openai-codex', groupId: 'main', reason: 'usage_limit', observedProfileId: 'primary',
    })).resolves.toMatchObject({ activeProfileId: resetProfile, status: resetProfile === 'primary' ? 'observed_generation' : 'switched' });
    expect(redeemed).toEqual([resetProfile]);
    expect(applied).toEqual([resetProfile]);
    expect(stored.generation).toBe(resetProfile === 'primary' ? 1 : 2);
  });

  it.each(['needs_reauth', 'refresh_failed_retryable'] as const)('validates quota-recovery candidates before CAS and skips a member with %s', async (credentialHealthStatus) => {
    const initial: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      members: [
        { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
        { profileId: 'invalid-backup', priority: 2, createdAtMs: 2, enabled: true },
        { profileId: 'healthy-backup', priority: 3, createdAtMs: 3, enabled: true },
      ],
    };
    const attemptedProfileIds = new Set<string>();
    const prepareCandidateForSwitch = vi.fn(async (input: Readonly<{ profileId: string }>) => {
      // A repeated attempt reproduces the loop without starving the test runner's timers.
      if (attemptedProfileIds.has(input.profileId)) throw new Error('candidate_preparation_repeated');
      attemptedProfileIds.add(input.profileId);
      return input.profileId === 'invalid-backup'
        ? {
            status: 'ineligible' as const,
            memberState: { credentialHealthStatus },
          }
        : { status: 'ready' as const };
    });
    const commitSwitch = vi.fn(async (input: Readonly<{ toProfileId: string }>) => ({
      ...initial,
      activeProfileId: input.toProfileId,
      generation: 2,
    }));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => initial,
      prepareCandidateForSwitch,
      commitSwitch,
      applyGeneration: async () => ({ mode: 'hot_apply' as const }),
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'source-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'healthy-backup',
      generation: 2,
    });
    expect(prepareCandidateForSwitch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      profileId: 'invalid-backup',
      reason: 'usage_limit',
    }));
    expect(prepareCandidateForSwitch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      profileId: 'healthy-backup',
      reason: 'usage_limit',
    }));
    expect(commitSwitch).toHaveBeenCalledWith(expect.objectContaining({
      toProfileId: 'healthy-backup',
    }));
    expect(initial.memberStatesByProfileId.size).toBe(0);
  });

  it('reports transiently unavailable candidates without persisting their exclusion across operations', async () => {
    const initial = state('primary', 1);
    let preparationAvailable = false;
    let attempted = false;
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => initial,
      prepareCandidateForSwitch: async () => {
        if (preparationAvailable) return { status: 'ready' };
        if (attempted) throw new Error('candidate_preparation_repeated');
        attempted = true;
        return {
          status: 'ineligible',
          memberState: { credentialHealthStatus: 'refresh_failed_retryable' },
        };
      },
      commitSwitch: async (input) => ({ ...initial, activeProfileId: input.toProfileId, generation: 2 }),
      applyGeneration: async () => ({ mode: 'hot_apply' }),
    });
    const request = {
      sessionId: 'source-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    };

    await expect(coordinator.switchAfterClassifiedFailure(request)).resolves.toMatchObject({
      status: 'no_eligible_member',
      excluded: expect.arrayContaining([{ profileId: 'backup', reason: 'credential_unavailable' }]),
      diagnostics: {
        decisionTrace: {
          candidates: expect.arrayContaining([
            expect.objectContaining({ profileId: 'backup', decision: 'excluded', exclusionReason: 'credential_unavailable' }),
          ]),
        },
      },
    });
    preparationAvailable = true;
    await expect(coordinator.switchAfterClassifiedFailure(request)).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
    });
    expect(initial.memberStatesByProfileId.size).toBe(0);
  });

  it('times out a waiter without releasing the still-effectful owner', async () => {
    vi.useFakeTimers();
    try {
      const leases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry({ leaseTimeoutMs: 10 });
      const owner = leases.acquire({ serviceId: 'openai-codex', groupId: 'main' });
      expect(owner.kind).toBe('owner');
      const loser = leases.acquire({ serviceId: 'openai-codex', groupId: 'main' });
      expect(loser.kind).toBe('loser');
      const wait = loser.kind === 'loser' ? loser.waitForOwner({ timeoutMs: 10 }) : Promise.resolve({ activeProfileId: null, generation: 0, serviceId: '', groupId: '' });
      const assertion = expect(wait).rejects.toThrow('connected_service_auth_group_switch_lease_expired');

      await vi.advanceTimersByTimeAsync(10);

      await assertion;

      const stillLoser = leases.acquire({ serviceId: 'openai-codex', groupId: 'main' });
      expect(stillLoser.kind).toBe('loser');
      const eventual = stillLoser.kind === 'loser'
        ? stillLoser.waitForOwner({ timeoutMs: 1_000 })
        : Promise.reject(new Error('replacement owner incorrectly acquired'));
      if (owner.kind !== 'owner') throw new Error('owner expected');
      owner.complete({
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        generation: 2,
        result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
      });
      await expect(eventual).resolves.toMatchObject({ generation: 2, activeProfileId: 'backup' });
      expect(leases.acquire({ serviceId: 'openai-codex', groupId: 'main' }).kind).toBe('loser');
      owner.finish();
      expect(leases.acquire({ serviceId: 'openai-codex', groupId: 'main' }).kind).toBe('owner');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hold the group decision lease while a pre-turn quota probe is pending', async () => {
    let releaseProbe!: () => void;
    let notifyProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      notifyProbeStarted = resolve;
    });
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let loadCount = 0;
    const autoState = state('primary', 1);
    const disabledState: ConnectedServiceAuthGroupSwitchState = {
      ...autoState,
      policy: { ...autoState.policy, autoSwitch: false },
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry({ leaseTimeoutMs: 20 }),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => {
        loadCount += 1;
        return loadCount === 1 ? autoState : disabledState;
      },
      commitSwitch: async ({ toProfileId }) => state(toProfileId, 2),
      applyGeneration: async () => {},
      probeQuotaSnapshotsForGroup: async (input) => {
        notifyProbeStarted();
        await probeGate;
        return {
          status: 'complete' as const,
          requestedProfileCount: input.profileIds.length,
          completedProfileCount: input.profileIds.length,
          completedProfileIds: [...input.profileIds],
        };
      },
    });

    const probing = coordinator.switchBeforeTurn({
      sessionId: 'probing-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    });
    await probeStarted;

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'manual-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toEqual({ status: 'auto_switch_disabled', generation: 1 });

    releaseProbe();
    await expect(probing).resolves.toEqual({ status: 'auto_switch_disabled', generation: 1 });
  });

  it('adopts authoritative switched truth when a reactive lease waiter expires after the peer commit', async () => {
    vi.useFakeTimers();
    try {
      const leases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry({ leaseTimeoutMs: 10 });
      const owner = leases.acquire({ serviceId: 'openai-codex', groupId: 'main' });
      if (owner.kind !== 'owner') throw new Error('owner expected');
      let current = state('primary', 1);
      const applyGeneration = vi.fn(async () => ({ mode: 'hot_apply' as const }));
      const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
        leases,
        nowMs: () => 1_000,
        quotaFreshnessMs: 60_000,
        loadState: async () => current,
        commitSwitch: async () => {
          throw new Error('lease loser must not commit');
        },
        applyGeneration,
      });

      const recovery = coordinator.switchAfterClassifiedFailure({
        sessionId: 'source-session',
        serviceId: 'openai-codex',
        groupId: 'main',
        reason: 'usage_limit',
        observedProfileId: 'primary',
      });
      current = state('backup', 2);
      await vi.advanceTimersByTimeAsync(10);

      await expect(recovery).resolves.toMatchObject({
        status: 'observed_generation',
        activeProfileId: 'backup',
        generation: 2,
      });
      expect(applyGeneration).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'source-session',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        generation: 2,
        fromProfileId: 'primary',
      }));
      owner.finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopts authoritative switched truth when a proactive lease waiter expires after the peer commit', async () => {
    vi.useFakeTimers();
    try {
      const leases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry({ leaseTimeoutMs: 10 });
      const owner = leases.acquire({ serviceId: 'openai-codex', groupId: 'main' });
      if (owner.kind !== 'owner') throw new Error('owner expected');
      let current = state('primary', 1);
      const applyGeneration = vi.fn(async () => ({ mode: 'hot_apply' as const }));
      const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
        leases,
        nowMs: () => 1_000,
        quotaFreshnessMs: 60_000,
        loadState: async () => current,
        commitSwitch: async () => {
          throw new Error('lease loser must not commit');
        },
        applyGeneration,
      });

      const recovery = coordinator.switchBeforeTurn({
        sessionId: 'respawning-session',
        serviceId: 'openai-codex',
        groupId: 'main',
        reason: 'soft_threshold',
        observedProfileId: 'primary',
      });
      current = state('backup', 2);
      await vi.advanceTimersByTimeAsync(10);

      await expect(recovery).resolves.toMatchObject({
        status: 'observed_generation',
        activeProfileId: 'backup',
        generation: 2,
      });
      expect(applyGeneration).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'respawning-session',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        generation: 2,
        fromProfileId: 'primary',
      }));
      owner.finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits after a classified usage limit when switching is disabled but recovery allows waiting', async () => {
    let didCommit = false;
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('primary', 1),
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: false },
      }),
      commitSwitch: async () => {
        didCommit = true;
        return state('backup', 2);
      },
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      resetsAtMs: 9_000,
    })).resolves.toMatchObject({
      status: 'no_eligible_member',
      generation: 1,
      groupExhausted: true,
      retryAtMs: 9_000,
    });
    expect(didCommit).toBe(false);
  });

  it('does not turn a proactive soft threshold into a durable wait when automatic switching is disabled', async () => {
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('primary', 1),
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: false },
      }),
      commitSwitch: async () => state('backup', 2),
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'soft-threshold-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toEqual({ status: 'auto_switch_disabled', generation: 1 });
  });

  it('honors recoveryMode off without committing an automatic recovery switch', async () => {
    const commitSwitch = vi.fn(async () => state('backup', 2));
    const applyGeneration = vi.fn();
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('primary', 1),
        policy: {
          ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
          autoSwitch: true,
          recoveryMode: 'off',
        },
      }),
      commitSwitch,
      applyGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'refresh_failed',
    })).resolves.toEqual({ status: 'auto_switch_disabled', generation: 1 });
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).not.toHaveBeenCalled();
  });

  it('honors recoveryMode wait_until_reset by recording failure state without switching accounts', async () => {
    const commitSwitch = vi.fn(async () => state('backup', 2));
    const applyGeneration = vi.fn();
    const recordObservedFailureState = vi.fn(async () => {});
    const events: unknown[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      loadState: async () => ({
        ...state('primary', 1),
        policy: {
          ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
          autoSwitch: true,
          recoveryMode: 'wait_until_reset',
        },
      }),
      recordObservedFailureState,
      commitSwitch,
      applyGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      resetsAtMs: 9_000,
    })).resolves.toEqual({
      status: 'no_eligible_member',
      generation: 1,
      groupExhausted: true,
      retryAtMs: 9_000,
      excluded: [
        { profileId: 'primary', reason: 'policy_wait_until_reset', retryAtMs: 9_000 },
        { profileId: 'backup', reason: 'policy_wait_until_reset', retryAtMs: 9_000 },
      ],
      diagnostics: {
        decisionTrace: {
          activeProfileId: 'primary',
          reason: 'no_eligible_members',
          candidates: [
            {
              profileId: 'primary',
              decision: 'excluded',
              exclusionReason: 'policy_wait_until_reset',
              retryAtMs: 9_000,
              quotaEvidence: { status: 'stale_or_missing' },
            },
            {
              profileId: 'backup',
              decision: 'excluded',
              exclusionReason: 'policy_wait_until_reset',
              retryAtMs: 9_000,
              quotaEvidence: { status: 'stale_or_missing' },
            },
          ],
        },
      },
    });
    expect(recordObservedFailureState).toHaveBeenCalledOnce();
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        resultStatus: 'no_eligible_member',
        success: false,
        decisionTrace: expect.objectContaining({
          reason: 'no_eligible_members',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'primary',
              exclusionReason: 'policy_wait_until_reset',
            }),
            expect.objectContaining({
              profileId: 'backup',
              exclusionReason: 'policy_wait_until_reset',
            }),
          ]),
        }),
      }),
    ]);
  });

  it.each(['auth_expired', 'refresh_failed', 'permission_denied'] as const)(
    'switches to a healthy group fallback for credential failure %s', async (reason) => {
    let didCommit = false;
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => state('primary', 1),
      commitSwitch: async ({ toProfileId }) => {
        didCommit = true;
        return state(toProfileId, 2);
      },
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason,
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
    });
    expect(didCommit).toBe(true);
  });

  it('treats capacity failures as usage-limit recovery by default', async () => {
    const committed: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => state('primary', 1),
      commitSwitch: async ({ fromProfileId, toProfileId }) => {
        committed.push(`${fromProfileId}->${toProfileId}`);
        return state(toProfileId, 2);
      },
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'capacity',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
    });
    expect(committed).toEqual(['primary->backup']);
  });

  it('disables capacity switching when usage-limit switching is disabled', async () => {
    const commitSwitch = vi.fn(async () => state('backup', 2));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('primary', 1),
        policy: {
          ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
          autoSwitch: true,
          switchOn: {
            ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1.switchOn,
            usageLimit: false,
          },
        },
      }),
      commitSwitch,
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'capacity',
      observedProfileId: 'primary',
    })).resolves.toEqual({ status: 'switch_reason_disabled', generation: 1 });
    expect(commitSwitch).not.toHaveBeenCalled();
  });

  it('reloads state after recording observed failure before committing a switch', async () => {
    let generation = 1;
    const committedGenerations: number[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => state('primary', generation),
      recordObservedFailureState: async () => {
        generation += 1;
      },
      commitSwitch: async ({ expectedGeneration, toProfileId }) => {
        committedGenerations.push(expectedGeneration);
        if (expectedGeneration !== generation) {
          throw new Error('connected_service_auth_group_generation_conflict');
        }
        generation += 1;
        return state(toProfileId, generation);
      },
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 3,
    });
    expect(committedGenerations).toEqual([2]);
  });

  it('retries a stale-generation switch when the observed generation keeps the same active profile', async () => {
    let loadCount = 0;
    const committedGenerations: number[] = [];
    const generationConflict = new TestGenerationConflictError(2);
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => {
        loadCount += 1;
        return state('primary', loadCount === 1 ? 1 : 2);
      },
      commitSwitch: async ({ expectedGeneration, toProfileId }) => {
        committedGenerations.push(expectedGeneration);
        if (expectedGeneration === 1) throw generationConflict;
        return state(toProfileId, 3);
      },
      resolveGenerationConflict: (error) => error instanceof TestGenerationConflictError ? error.generation : null,
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 3,
    });
    expect(committedGenerations).toEqual([1, 2]);
  });

  it('honors per-turn switch limits from group policy', async () => {
    const events: unknown[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      loadState: async () => state('primary', 1),
      commitSwitch: async () => state('backup', 2),
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 1,
    })).resolves.toEqual({ status: 'switch_limit_reached', generation: 1 });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: null,
        reason: 'usage_limit',
        fromGeneration: 1,
        toGeneration: 1,
        resultStatus: 'switch_limit_reached',
        success: false,
      }),
    ]);
  });

  it('honors per-session hourly switch limits from group policy', async () => {
    let current = {
      ...state('primary', 1),
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        strategy: 'priority' as const,
        autoSwitch: true,
        maxSwitchesPerSessionHour: 1,
      },
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => {
        current = { ...current, activeProfileId: toProfileId, generation: current.generation + 1 };
        return current;
      },
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toMatchObject({ status: 'switched', generation: 2 });
    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toEqual({ status: 'switch_limit_reached', generation: 2 });
  });


  it('returns structured exhaustion context when no eligible member remains', async () => {
    const events: unknown[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      loadState: async () => ({
        ...state('primary', 1),
        memberStatesByProfileId: new Map([
          ['backup', {
            providerResetsAtMs: 5_000,
            quotaSnapshot: {
              capturedAtMs: 900,
              exhausted: true,
            },
          }],
        ]),
      }),
      commitSwitch: async () => state('backup', 2),
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'no_eligible_member',
      generation: 1,
      groupExhausted: true,
      retryAtMs: 5_000,
      excluded: [
        { profileId: 'primary', reason: 'current_active' },
        { profileId: 'backup', reason: 'quota_exhausted', retryAtMs: 5_000 },
      ],
      diagnostics: {
        decisionTrace: {
          activeProfileId: 'primary',
          reason: 'no_eligible_members',
          candidates: [
            {
              profileId: 'primary',
              decision: 'excluded',
              exclusionReason: 'current_active',
              quotaEvidence: { status: 'stale_or_missing' },
            },
            {
              profileId: 'backup',
              decision: 'excluded',
              exclusionReason: 'quota_exhausted',
              retryAtMs: 5_000,
              quotaEvidence: {
                status: 'fresh',
                remainingPercent: null,
                capturedAtMs: 900,
                exhausted: true,
              },
            },
          ],
        },
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: null,
        reason: 'usage_limit',
        fromGeneration: 1,
        toGeneration: 1,
        resultStatus: 'no_eligible_member',
        success: false,
      }),
    ]);
  });

  it('emits structured switch telemetry for successful attempts', async () => {
    const events: unknown[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      loadState: async () => state('primary', 1),
      commitSwitch: async ({ toProfileId }) => state(toProfileId, 2),
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      retryAtMs: 30_000,
      limitCategory: 'quota',
      quotaScope: 'account',
      providerLimitId: 'weekly',
      action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
        decisionTrace: expect.objectContaining({
          activeProfileId: 'primary',
          reason: 'selected',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'primary',
              decision: 'excluded',
              exclusionReason: 'current_active',
            }),
            expect.objectContaining({
              profileId: 'backup',
              decision: 'selected',
            }),
          ]),
        }),
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'usage_limit',
        retryAfterMs: 30_000,
        limitCategory: 'quota',
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
        fromGeneration: 1,
        toGeneration: 2,
        resultStatus: 'switched',
        success: true,
        decisionTrace: expect.objectContaining({
          activeProfileId: 'primary',
          reason: 'selected',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'backup',
              decision: 'selected',
            }),
          ]),
        }),
      }),
    ]);
  });

  it('attributes runtime recovery switch events to the observed failing profile', async () => {
    const events: unknown[] = [];
    const initialState: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      activeProfileId: null,
    };
    let currentState = initialState;
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      loadState: async () => currentState,
      recordObservedFailureState: async ({ observedProfileId }) => {
        expect(observedProfileId).toBe('primary');
        currentState = {
          ...initialState,
          memberStatesByProfileId: new Map([
            ['primary', {
              quotaExhaustedUntilMs: 30_000,
              lastFailureKind: 'usage_limit',
              lastObservedAtMs: 1_000,
            }],
          ]),
        };
      },
      commitSwitch: async ({ fromProfileId, toProfileId }) => {
        expect(fromProfileId).toBeNull();
        expect(toProfileId).toBe('backup');
        return state(toProfileId, 2);
      },
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        resultStatus: 'switched',
        success: true,
      }),
    ]);
  });

  it('probes stale candidate quota state before selecting a runtime failure recovery member', async () => {
    let current = {
      ...state('primary', 1),
      members: [
        { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
        { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
        { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
      ],
    };
    const probeQuotaSnapshotsForGroup = vi.fn(async () => {
      current = {
        ...current,
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaExhaustedUntilMs: 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: 1_000,
          }],
          ['backup', {
            quotaSnapshot: {
              capturedAtMs: 1_000,
              effectiveRemainingPercent: 0,
              exhausted: true,
            },
          }],
          ['tertiary', {
            quotaSnapshot: {
              capturedAtMs: 1_000,
              effectiveRemainingPercent: 80,
            },
          }],
        ]),
      };
    });
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      recordObservedFailureState: async (input) => {
        expect(input.observedProfileId).toBe('primary');
        current = {
          ...current,
          memberStatesByProfileId: new Map([
            ['primary', {
              quotaExhaustedUntilMs: 30_000,
              lastFailureKind: 'usage_limit',
              lastObservedAtMs: 1_000,
            }],
          ]),
        };
      },
      commitSwitch: async (input) => state(input.toProfileId, 2),
      applyGeneration: async () => {},
      probeQuotaSnapshotsForGroup,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'tertiary', generation: 2 });
    expect(probeQuotaSnapshotsForGroup).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileIds: ['backup', 'tertiary'],
      reason: 'usage_limit',
    });
  });

  it('does not apply a divergent group-active profile until it proves that profile is eligible', async () => {
    const events: unknown[] = [];
    const applied: string[] = [];
    const committed: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      loadState: async () => ({
        ...state('backup', 2),
        members: [
          { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
          { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
          { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
        ],
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaExhaustedUntilMs: 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: 1_000,
          }],
          ['backup', {
            providerResetsAtMs: 30_000,
            quotaSnapshot: {
              capturedAtMs: 1_000,
              effectiveRemainingPercent: 0,
              exhausted: true,
            },
          }],
          ['tertiary', {
            quotaSnapshot: {
              capturedAtMs: 1_000,
              effectiveRemainingPercent: 80,
            },
          }],
        ]),
      }),
      commitSwitch: async ({ fromProfileId, toProfileId }) => {
        committed.push(`${fromProfileId}->${toProfileId}`);
        return {
          ...state(toProfileId, 3),
          members: [
            { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
            { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
            { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
          ],
        };
      },
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'tertiary',
      generation: 3,
    });
    expect(committed).toEqual(['backup->tertiary']);
    expect(applied).toEqual(['tertiary:3']);
    expect(events).toEqual([
      expect.objectContaining({
        fromProfileId: 'primary',
        toProfileId: 'tertiary',
        resultStatus: 'switched',
        success: true,
      }),
    ]);
  });

  it('adopts a divergent group-active profile even when canonical selection prefers another eligible member', async () => {
    const applied: string[] = [];
    const committed: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('backup', 2),
        members: [
          { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
          { profileId: 'tertiary', priority: 2, createdAtMs: 2, enabled: true },
          { profileId: 'backup', priority: 3, createdAtMs: 3, enabled: true },
        ],
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaExhaustedUntilMs: 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: 1_000,
          }],
          ['tertiary', {
            quotaSnapshot: {
              capturedAtMs: 1_000,
              effectiveRemainingPercent: 90,
            },
          }],
        ]),
      }),
      commitSwitch: async ({ fromProfileId, toProfileId }) => {
        committed.push(`${fromProfileId}->${toProfileId}`);
        return {
          ...state(toProfileId, 3),
          members: [
            { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
            { profileId: 'tertiary', priority: 2, createdAtMs: 2, enabled: true },
            { profileId: 'backup', priority: 3, createdAtMs: 3, enabled: true },
          ],
        };
      },
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
    });
    expect(committed).toEqual([]);
    expect(applied).toEqual(['backup:2']);
  });

  it('adopts a divergent group-active profile even when another member has fresh quota proof', async () => {
    const applied: string[] = [];
    const committed: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('backup', 2),
        members: [
          { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
          { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
          { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
        ],
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaExhaustedUntilMs: 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: 1_000,
          }],
          ['tertiary', {
            quotaSnapshot: {
              capturedAtMs: 1_000,
              effectiveRemainingPercent: 90,
            },
          }],
        ]),
      }),
      commitSwitch: async ({ fromProfileId, toProfileId }) => {
        committed.push(`${fromProfileId}->${toProfileId}`);
        return {
          ...state(toProfileId, 3),
          members: [
            { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
            { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
            { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
          ],
        };
      },
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
    });
    expect(committed).toEqual([]);
    expect(applied).toEqual(['backup:2']);
  });

  it('keeps the divergent observed-generation fast path when the group-active profile is eligible', async () => {
    const applied: string[] = [];
    const commitSwitch = vi.fn();
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('backup', 2),
        members: [
          { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
          { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
          { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
        ],
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaExhaustedUntilMs: 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: 1_000,
          }],
          ['backup', {
            quotaSnapshot: {
              capturedAtMs: 1_000,
              effectiveRemainingPercent: 80,
            },
          }],
        ]),
      }),
      commitSwitch,
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
        decisionTrace: expect.objectContaining({ reason: 'selected' }),
      },
    });
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applied).toEqual(['backup:2']);
  });

  it('adopts the current group-active profile before globally advancing a group after a stale session member fails', async () => {
    const applied: string[] = [];
    const commitSwitch = vi.fn(async ({ toProfileId }) => state(toProfileId, 3));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('backup', 2),
        members: [
          { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
          { profileId: 'tertiary', priority: 2, createdAtMs: 2, enabled: true },
          { profileId: 'backup', priority: 3, createdAtMs: 3, enabled: true },
        ],
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaExhaustedUntilMs: 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: 1_000,
          }],
        ]),
      }),
      commitSwitch,
      applyGeneration: async ({ sessionId, activeProfileId, generation }) => {
        applied.push(`${sessionId ?? 'none'}:${activeProfileId}:${generation}`);
        return { mode: 'restart_resume' as const };
      },
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'restart_resume',
      providerApplication: 'applied',
      diagnostics: {
        decisionTrace: expect.objectContaining({ reason: 'selected' }),
      },
    });
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applied).toEqual(['sess_1:backup:2']);
  });

  it('does not blindly apply a generation-conflict winner when canonical selection prefers another eligible member', async () => {
    let loadCount = 0;
    const applied: string[] = [];
    const committed: string[] = [];
    const generationConflict = new TestGenerationConflictError(2);
    const members = [
      { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      { profileId: 'tertiary', priority: 2, createdAtMs: 2, enabled: true },
      { profileId: 'backup', priority: 3, createdAtMs: 3, enabled: true },
    ];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return {
            ...state('primary', 1),
            members,
            memberStatesByProfileId: new Map([
              ['primary', {
                quotaExhaustedUntilMs: 30_000,
                lastFailureKind: 'usage_limit',
                lastObservedAtMs: 1_000,
              }],
            ]),
          };
        }
        return {
          ...state('backup', 2),
          members,
          memberStatesByProfileId: new Map([
            ['primary', {
              quotaExhaustedUntilMs: 30_000,
              lastFailureKind: 'usage_limit',
              lastObservedAtMs: 1_000,
            }],
            ['tertiary', {
              quotaSnapshot: {
                capturedAtMs: 1_000,
                effectiveRemainingPercent: 90,
              },
            }],
          ]),
        };
      },
      commitSwitch: async ({ fromProfileId, toProfileId, expectedGeneration }) => {
        committed.push(`${expectedGeneration}:${fromProfileId}->${toProfileId}`);
        if (expectedGeneration === 1) throw generationConflict;
        return {
          ...state(toProfileId, 3),
          members,
        };
      },
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
      resolveGenerationConflict: (error) => error instanceof TestGenerationConflictError ? error.generation : null,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'tertiary',
      generation: 3,
    });
    expect(committed).toEqual(['1:primary->tertiary', '2:backup->tertiary']);
    expect(applied).toEqual(['tertiary:3']);
  });

  it('reselects after a generation conflict instead of retrying the stale pre-conflict selected target', async () => {
    let loadCount = 0;
    const applied: string[] = [];
    const committed: string[] = [];
    const generationConflict = new TestGenerationConflictError(2);
    const members = [
      { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
      { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
    ];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return {
            ...state('primary', 1),
            members,
            memberStatesByProfileId: new Map([
              ['primary', {
                quotaExhaustedUntilMs: 30_000,
                lastFailureKind: 'usage_limit',
                lastObservedAtMs: 1_000,
              }],
            ]),
          };
        }
        return {
          ...state('backup', 2),
          members,
          memberStatesByProfileId: new Map([
            ['primary', {
              quotaExhaustedUntilMs: 30_000,
              lastFailureKind: 'usage_limit',
              lastObservedAtMs: 1_000,
            }],
            ['backup', {
              providerResetsAtMs: 30_000,
              quotaSnapshot: {
                capturedAtMs: 1_000,
                effectiveRemainingPercent: 0,
                exhausted: true,
              },
            }],
            ['tertiary', {
              quotaSnapshot: {
                capturedAtMs: 1_000,
                effectiveRemainingPercent: 90,
              },
            }],
          ]),
        };
      },
      commitSwitch: async ({ fromProfileId, toProfileId, expectedGeneration }) => {
        committed.push(`${expectedGeneration}:${fromProfileId}->${toProfileId}`);
        if (expectedGeneration === 1) throw generationConflict;
        return {
          ...state(toProfileId, 3),
          members,
        };
      },
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
      resolveGenerationConflict: (error) => error instanceof TestGenerationConflictError ? error.generation : null,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'tertiary',
      generation: 3,
    });
    expect(committed).toEqual(['1:primary->backup', '2:backup->tertiary']);
    expect(applied).toEqual(['tertiary:3']);
  });

  it('switches before a turn through the coordinator without recording a failure state', async () => {
    const events: unknown[] = [];
    const recordObservedFailureState = vi.fn();
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      recordObservedFailureState,
      loadState: async () => ({
        ...state('primary', 1),
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaSnapshot: {
              capturedAtMs: 900,
              effectiveRemainingPercent: 5,
            },
          }],
          ['backup', {
            quotaSnapshot: {
              capturedAtMs: 900,
              effectiveRemainingPercent: 80,
            },
          }],
        ]),
      }),
      commitSwitch: async ({ toProfileId }) => state(toProfileId, 2),
      applyGeneration: async () => {},
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
        decisionTrace: expect.objectContaining({
          reason: 'selected',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'backup',
              decision: 'selected',
            }),
          ]),
        }),
      },
    });
    expect(recordObservedFailureState).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'soft_threshold',
        resultStatus: 'switched',
        success: true,
      }),
    ]);
  });

  it('reports the adopted generation as superseded when authoritative truth advances during apply', async () => {
    const withQuota = (activeProfileId: string, generation: number): ConnectedServiceAuthGroupSwitchState => ({
      ...state(activeProfileId, generation),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
      memberStatesByProfileId: new Map([
        ['primary', { quotaSnapshot: { capturedAtMs: 1_000, effectiveRemainingPercent: 5 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 1_000, effectiveRemainingPercent: 80 } }],
      ]),
    });
    let current = withQuota('primary', 1);
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async () => {
        current = withQuota('backup', 2);
        return current;
      },
      applyGeneration: async () => {
        // Concurrent decision C/gen3 wins while this session is still adopting B/gen2.
        current = withQuota('primary', 3);
        return { mode: 'hot_apply' as const };
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-stale',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({
      status: 'superseded_after_apply',
      activeProfileId: 'primary',
      generation: 3,
      adoptedProfileId: 'backup',
      adoptedGeneration: 2,
      reconciliationDisposition: 'superseded_after_apply',
    });
  });

  it('post-fences a lease recipient that applies an already-superseded committed generation', async () => {
    const leases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry();
    const owner = leases.acquire({ serviceId: 'openai-codex', groupId: 'main' });
    if (owner.kind !== 'owner') throw new Error('owner expected');
    owner.complete({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    });
    let current = state('backup', 2);
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases,
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: vi.fn(),
      applyGeneration: async () => {
        current = state('primary', 3);
        return { mode: 'hot_apply' as const };
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'recipient',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toMatchObject({
      status: 'superseded_after_apply',
      adoptedProfileId: 'backup',
      adoptedGeneration: 2,
      activeProfileId: 'primary',
      generation: 3,
    });
    owner.finish();
  });

  it('post-fences a same-generation credential revision that was superseded during apply', async () => {
    const adoptedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const authoritativeRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const current = {
      ...state('backup', 2),
      credentialRevision: authoritativeRevision,
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: vi.fn(),
      applyGeneration: async () => ({ mode: 'hot_apply' as const }),
    });

    await expect(coordinator.applyCommittedGeneration({
      sessionId: 'revision-recipient',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: adoptedRevision,
      reason: 'credential_revision_changed',
    })).resolves.toMatchObject({
      status: 'superseded_after_apply',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: authoritativeRevision,
      adoptedProfileId: 'backup',
      adoptedGeneration: 2,
      adoptedCredentialRevision: adoptedRevision,
      reconciliationDisposition: 'superseded_after_apply',
    });
  });

  it('hands a materialization-time credential revision supersession to the authoritative generation consumer', async () => {
    const attemptedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const authoritativeRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const current = {
      ...state('backup', 2),
      credentialRevision: authoritativeRevision,
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: vi.fn(),
      applyGeneration: async () => {
        throw createConnectedServiceAuthGenerationApplyFailureError({
          errorCode: 'credential_revision_superseded',
        });
      },
    });

    await expect(coordinator.applyCommittedGeneration({
      sessionId: 'revision-recipient',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: attemptedRevision,
      reason: 'credential_revision_changed',
    })).resolves.toMatchObject({
      status: 'superseded_after_apply',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: authoritativeRevision,
      adoptedProfileId: 'backup',
      adoptedGeneration: 2,
      adoptedCredentialRevision: attemptedRevision,
      reconciliationDisposition: 'superseded_after_apply',
    });
  });

  it('keeps an unverified materialization-time revision fence as an apply failure', async () => {
    const attemptedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const current = {
      ...state('backup', 2),
      credentialRevision: attemptedRevision,
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: vi.fn(),
      applyGeneration: async () => {
        throw createConnectedServiceAuthGenerationApplyFailureError({
          errorCode: 'credential_revision_superseded',
        });
      },
    });

    await expect(coordinator.applyCommittedGeneration({
      sessionId: 'revision-recipient',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: attemptedRevision,
      reason: 'credential_revision_changed',
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      errorCode: 'credential_revision_superseded',
    });
  });

  it('probes stale group quota state before selecting a soft-threshold pre-turn candidate', async () => {
    let current = state('primary', 1);
    const probeQuotaSnapshotsForGroup = vi.fn(async () => {
      current = {
        ...current,
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaSnapshot: {
              capturedAtMs: 1_000,
              effectiveRemainingPercent: 5,
            },
          }],
          ['backup', {
            quotaSnapshot: {
              capturedAtMs: 1_000,
              effectiveRemainingPercent: 80,
            },
          }],
        ]),
      };
    });
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async (input) => state(input.toProfileId, 2),
      applyGeneration: async () => {},
      probeQuotaSnapshotsForGroup,
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
        decisionTrace: expect.objectContaining({
          reason: 'selected',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'backup',
              decision: 'selected',
            }),
          ]),
        }),
      },
    });
    expect(probeQuotaSnapshotsForGroup).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileIds: ['primary', 'backup'],
      reason: 'soft_threshold',
    });
  });

  it.each(['soft_threshold', 'usage_limit'] as const)(
    'does not select or commit from partial quota evidence for %s',
    async (reason) => {
      const commitSwitch = vi.fn(async (input: Readonly<{ toProfileId: string }>) => state(input.toProfileId, 2));
      const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
        leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
        nowMs: () => 1_000,
        quotaFreshnessMs: 60_000,
        loadState: async () => state('primary', 1),
        commitSwitch,
        applyGeneration: async () => {},
        probeQuotaSnapshotsForGroup: async () => ({
          status: 'incomplete',
          requestedProfileCount: 2,
          completedProfileCount: 1,
          completedProfileIds: ['primary'],
          reason: 'deadline_exceeded',
        }),
      });

      await expect(coordinator.switchBeforeTurn({
        sessionId: 'session-1',
        serviceId: 'openai-codex',
        groupId: 'main',
        reason,
        deadlineAtMs: 1_100,
      })).rejects.toBeInstanceOf(ConnectedServiceAuthGroupQuotaProbeIncompleteError);
      expect(commitSwitch).not.toHaveBeenCalled();
    },
  );

  it('applies an already-advanced hard usage-limit generation with quota-unknown target evidence', async () => {
    const applied: string[] = [];
    const commitSwitch = vi.fn(async ({ toProfileId }) => state(toProfileId, 3));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => state('backup', 2),
      commitSwitch,
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
        decisionTrace: expect.objectContaining({ reason: 'selected' }),
      },
    });
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applied).toEqual(['backup:2']);
  });

  it('reselects a before-turn candidate after a generation conflict instead of retrying the stale target', async () => {
    let loadCount = 0;
    const applied: string[] = [];
    const committed: string[] = [];
    const generationConflict = new TestGenerationConflictError(2);
    const members = [
      { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
      { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
    ];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return {
            ...state('primary', 1),
            policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
            members,
            memberStatesByProfileId: new Map([
              ['primary', {
                quotaSnapshot: {
                  capturedAtMs: 1_000,
                  effectiveRemainingPercent: 5,
                },
              }],
              ['backup', {
                quotaSnapshot: {
                  capturedAtMs: 1_000,
                  effectiveRemainingPercent: 80,
                },
              }],
              ['tertiary', {
                quotaSnapshot: {
                  capturedAtMs: 1_000,
                  effectiveRemainingPercent: 40,
                },
              }],
            ]),
          };
        }
        return {
          ...state('backup', 2),
          policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
          members,
          memberStatesByProfileId: new Map([
            ['primary', {
              quotaSnapshot: {
                capturedAtMs: 1_000,
                effectiveRemainingPercent: 5,
              },
            }],
            ['backup', {
              providerResetsAtMs: 30_000,
              quotaSnapshot: {
                capturedAtMs: 1_000,
                effectiveRemainingPercent: 0,
                exhausted: true,
              },
            }],
            ['tertiary', {
              quotaSnapshot: {
                capturedAtMs: 1_000,
                effectiveRemainingPercent: 90,
              },
            }],
          ]),
        };
      },
      commitSwitch: async ({ fromProfileId, toProfileId, expectedGeneration }) => {
        committed.push(`${expectedGeneration}:${fromProfileId}->${toProfileId}`);
        if (expectedGeneration === 1) throw generationConflict;
        return {
          ...state(toProfileId, 3),
          policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
          members,
        };
      },
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
      resolveGenerationConflict: (error) => error instanceof TestGenerationConflictError ? error.generation : null,
    });

    await expect(coordinator.switchBeforeTurn({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'tertiary',
      generation: 3,
      diagnostics: {
        decisionTrace: expect.objectContaining({
          reason: 'selected',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'tertiary',
              decision: 'selected',
            }),
          ]),
        }),
      },
    });
    expect(committed).toEqual(['1:primary->backup', '2:backup->tertiary']);
    expect(applied).toEqual(['tertiary:3']);
  });

  it('returns no eligible member after a before-turn generation conflict instead of retrying a stale target', async () => {
    let loadCount = 0;
    const applied: string[] = [];
    const committed: string[] = [];
    const generationConflict = new TestGenerationConflictError(2);
    const members = [
      { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
      { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
    ];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return {
            ...state('primary', 1),
            policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
            members,
            memberStatesByProfileId: new Map([
              ['primary', {
                quotaSnapshot: {
                  capturedAtMs: 1_000,
                  effectiveRemainingPercent: 5,
                },
              }],
              ['backup', {
                quotaSnapshot: {
                  capturedAtMs: 1_000,
                  effectiveRemainingPercent: 80,
                },
              }],
            ]),
          };
        }
        return {
          ...state('backup', 2),
          policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
          members,
          memberStatesByProfileId: new Map([
            ['primary', {
              quotaExhaustedUntilMs: 30_000,
            }],
            ['backup', {
              providerResetsAtMs: 30_000,
              quotaSnapshot: {
                capturedAtMs: 1_000,
                effectiveRemainingPercent: 0,
                exhausted: true,
              },
            }],
            ['tertiary', {
              quotaExhaustedUntilMs: 30_000,
            }],
          ]),
        };
      },
      commitSwitch: async ({ fromProfileId, toProfileId, expectedGeneration }) => {
        committed.push(`${expectedGeneration}:${fromProfileId}->${toProfileId}`);
        if (expectedGeneration === 1) throw generationConflict;
        return state(toProfileId, 3);
      },
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
      resolveGenerationConflict: (error) => error instanceof TestGenerationConflictError ? error.generation : null,
    });

    await expect(coordinator.switchBeforeTurn({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({
      status: 'no_eligible_member',
      generation: 2,
      groupExhausted: true,
    });
    expect(committed).toEqual(['1:primary->backup']);
    expect(applied).toEqual([]);
  });

  it.each(['soft_threshold', 'usage_limit'] as const)('applies a coalesced generation using the recipient reason when the owner reason is %s', async ownerReason => {
    const quotaReadyState = (activeProfileId: string, generation: number): ConnectedServiceAuthGroupSwitchState => ({
      ...state(activeProfileId, generation),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
      memberStatesByProfileId: new Map([
        ['primary', { quotaSnapshot: { capturedAtMs: 1_000, effectiveRemainingPercent: 5 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 1_000, effectiveRemainingPercent: 80 } }],
      ]),
    });
    let current = quotaReadyState('primary', 1);
    let commitCount = 0;
    let notifyOwnerApplying!: () => void;
    let releaseOwner!: () => void;
    const ownerApplying = new Promise<void>(resolve => { notifyOwnerApplying = resolve; });
    const ownerApplyGate = new Promise<void>(resolve => { releaseOwner = resolve; });
    const applied: Array<Readonly<{ sessionId?: string; reason?: string }>> = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000, quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => {
        commitCount += 1;
        current = quotaReadyState(toProfileId, current.generation + 1);
        return current;
      },
      preflightApplyGeneration: async ({ sessionId }) => ({ mode: sessionId === 'owner' ? 'hot_apply' : 'restart_resume' }),
      applyGeneration: async ({ sessionId, reason }) => {
        applied.push({ sessionId, reason });
        if (sessionId === 'owner') {
          // Provider application is the boundary: retain the real group lease
          // while the recipient consumes the already committed generation.
          notifyOwnerApplying();
          await ownerApplyGate;
          return { mode: 'hot_apply' };
        }
        return { mode: 'restart_resume' };
      },
    });
    const common = { serviceId: 'openai-codex', groupId: 'main', observedProfileId: 'primary' };
    const owner = ownerReason === 'soft_threshold'
      ? coordinator.switchBeforeTurn({ ...common, sessionId: 'owner', reason: ownerReason })
      : coordinator.switchAfterClassifiedFailure({ ...common, sessionId: 'owner', reason: ownerReason });
    await ownerApplying;
    const recipientReason = ownerReason === 'soft_threshold' ? 'usage_limit' : 'soft_threshold';
    let recipient;
    try {
      recipient = await (recipientReason === 'usage_limit'
        ? coordinator.switchAfterClassifiedFailure({ ...common, sessionId: 'recipient', reason: recipientReason })
        : coordinator.switchBeforeTurn({ ...common, sessionId: 'recipient', reason: recipientReason }));
    } finally { releaseOwner(); }
    await expect(owner).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2, mode: 'hot_apply' });
    expect(commitCount).toBe(1);
    if (recipientReason === 'usage_limit') {
      expect(recipient).toMatchObject({ status: 'observed_generation', activeProfileId: 'backup', generation: 2, mode: 'restart_resume' });
      expect(applied).toEqual([{ sessionId: 'owner', reason: ownerReason }, { sessionId: 'recipient', reason: recipientReason }]);
    } else {
      expect(recipient).toMatchObject({ status: 'generation_apply_failed', activeProfileId: 'backup', generation: 2,
        errorCode: 'hot_apply_restart_required' });
      expect(applied).toEqual([{ sessionId: 'owner', reason: ownerReason }]);
    }
  });

  it('commits one switch while lease losers only apply the observed generation', async () => {
    let current = state('primary', 1);
    let commitCount = 0;
    const applied: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => {
        commitCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        current = state(toProfileId, current.generation + 1);
        return current;
      },
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
    });

    const first = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    });
    const second = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    });

    await expect(first).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });
    await expect(second).resolves.toMatchObject({ status: 'observed_generation', activeProfileId: 'backup', generation: 2 });
    expect(commitCount).toBe(1);
    expect(applied).toEqual(['backup:2', 'backup:2']);
  });

  it.each([
    { ownerProviderLimitId: 'rate_limit', ownerSwitchesThisHour: 0, ownerStatus: 'switch_reason_disabled' },
    { ownerProviderLimitId: null, ownerSwitchesThisHour: 3, ownerStatus: 'switch_limit_reached' },
  ])('reconsiders a peer $ownerStatus using each waiting request ($ownerProviderLimitId)', async ({
    ownerProviderLimitId, ownerSwitchesThisHour, ownerStatus,
  }) => {
    for (const trigger of ['classified_failure', 'pre_turn'] as const) {
      let releaseOwnerLoad: () => void = () => {};
      let ownerEntered: () => void = () => {};
      const ownerLoadGate = new Promise<void>((resolve) => { releaseOwnerLoad = resolve; });
      const ownerLoadStarted = new Promise<void>((resolve) => { ownerEntered = resolve; });
      let loadCount = 0;
      let current = state('primary', 1);
      current = {
        ...current,
        policy: {
          ...current.policy,
          maxSwitchesPerSessionHour: 3,
          quotaLimitSelection: { mode: 'selected', providerLimitIds: ['five_hour', 'seven_day'] },
        },
      };
      const applied: string[] = [];
      const committed: string[] = [];
      const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
        leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
        nowMs: () => 1_000,
        quotaFreshnessMs: 60_000,
        loadState: async () => {
          loadCount += 1;
          if (loadCount === 1) { ownerEntered(); await ownerLoadGate; }
          return current;
        },
        commitSwitch: async ({ toProfileId }) => {
          committed.push(toProfileId);
          current = { ...current, activeProfileId: toProfileId, generation: current.generation + 1 };
          return current;
        },
        applyGeneration: async ({ sessionId, activeProfileId }) => {
          applied.push(`${sessionId}:${activeProfileId}`);
          return { mode: 'hot_apply' };
        },
      });
      const common = { serviceId: 'openai-codex', groupId: 'main', reason: 'usage_limit' as const, observedProfileId: 'primary' };
      const owner = coordinator.switchAfterClassifiedFailure({
        ...common, reason: ownerStatus === 'switch_reason_disabled' ? 'same_provider_account_exhausted' : common.reason,
        sessionId: 'owner', providerLimitId: ownerProviderLimitId, sessionSwitchesThisHour: ownerSwitchesThisHour,
      });
      await ownerLoadStarted;
      const waiter = trigger === 'classified_failure'
        ? coordinator.switchAfterClassifiedFailure({ ...common, sessionId: 'waiter', providerLimitId: null })
        : coordinator.switchBeforeTurn({ ...common, sessionId: 'waiter' });
      if (trigger === 'pre_turn') await vi.waitFor(() => expect(loadCount).toBe(2));
      releaseOwnerLoad();
      await expect(owner).resolves.toMatchObject({ status: ownerStatus, generation: 1 });
      await expect(waiter).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2, mode: 'hot_apply' });
      expect(committed).toEqual(['backup']);
      expect(applied).toEqual(['waiter:backup']);
    }
  });

  it('does not let lease losers apply an owner no-eligible result as an observed generation', async () => {
    let releaseOwnerLoad: () => void = () => {};
    const ownerLoadGate = new Promise<void>((resolve) => {
      releaseOwnerLoad = resolve;
    });
    let loadCount = 0;
    const current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      memberStatesByProfileId: new Map([
        ['backup', {
          providerResetsAtMs: 5_000,
          quotaSnapshot: {
            capturedAtMs: 900,
            exhausted: true,
          },
        }],
      ]),
    };
    const applied: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => {
        loadCount += 1;
        if (loadCount === 1) await ownerLoadGate;
        return current;
      },
      commitSwitch: async () => state('backup', 2),
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
    });

    const first = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    });
    const second = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    });

    releaseOwnerLoad();

    await expect(first).resolves.toEqual({
      status: 'no_eligible_member',
      generation: 1,
      groupExhausted: true,
      retryAtMs: 5_000,
      excluded: [
        { profileId: 'primary', reason: 'current_active' },
        { profileId: 'backup', reason: 'quota_exhausted', retryAtMs: 5_000 },
      ],
      diagnostics: {
        decisionTrace: expect.objectContaining({
          activeProfileId: 'primary',
          reason: 'no_eligible_members',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'primary',
              decision: 'excluded',
              exclusionReason: 'current_active',
            }),
            expect.objectContaining({
              profileId: 'backup',
              decision: 'excluded',
              exclusionReason: 'quota_exhausted',
              retryAtMs: 5_000,
            }),
          ]),
        }),
      },
    });
    await expect(second).resolves.toEqual({
      status: 'no_eligible_member',
      generation: 1,
      groupExhausted: true,
      retryAtMs: 5_000,
      excluded: [
        { profileId: 'primary', reason: 'current_active' },
        { profileId: 'backup', reason: 'quota_exhausted', retryAtMs: 5_000 },
      ],
      diagnostics: {
        decisionTrace: expect.objectContaining({
          activeProfileId: 'primary',
          reason: 'no_eligible_members',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'primary',
              decision: 'excluded',
              exclusionReason: 'current_active',
            }),
            expect.objectContaining({
              profileId: 'backup',
              decision: 'excluded',
              exclusionReason: 'quota_exhausted',
              retryAtMs: 5_000,
            }),
          ]),
        }),
      },
    });
    expect(applied).toEqual([]);
  });

  it('re-enters runtime-auth recovery when a lease loser failed on the observed generation target', async () => {
    const members = [
      { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
      { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
    ];
    let current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      members,
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 0,
            exhausted: true,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 80,
          },
        }],
        ['tertiary', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 70,
          },
        }],
      ]),
    };
    const committed: string[] = [];
    const applied: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      recordObservedFailureState: async ({ observedProfileId }) => {
        if (observedProfileId !== 'backup') return;
        current = {
          ...current,
          memberStatesByProfileId: new Map([
            ...current.memberStatesByProfileId,
            ['backup', {
              quotaSnapshot: {
                capturedAtMs: 1_000,
                effectiveRemainingPercent: 0,
                exhausted: true,
              },
            }],
          ]),
        };
      },
      commitSwitch: async ({ fromProfileId, toProfileId, expectedGeneration }) => {
        committed.push(`${expectedGeneration}:${fromProfileId}->${toProfileId}`);
        await Promise.resolve();
        current = {
          ...current,
          activeProfileId: toProfileId,
          generation: current.generation + 1,
        };
        return current;
      },
      applyGeneration: async ({ sessionId, activeProfileId, generation }) => {
        applied.push(`${sessionId ?? 'none'}:${activeProfileId}:${generation}`);
      },
    });

    const first = coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    });
    const second = coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-2',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'backup',
    });

    await expect(first).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });
    await expect(second).resolves.toMatchObject({ status: 'switched', activeProfileId: 'tertiary', generation: 3 });
    expect(committed).toEqual(['1:primary->backup', '2:backup->tertiary']);
    expect(applied).toEqual([
      'session-1:backup:2',
      'session-2:tertiary:3',
    ]);
  });

  it('applies observed pre-turn generations with each waiting session id', async () => {
    const quotaReadyState = (activeProfileId: string, generation: number): ConnectedServiceAuthGroupSwitchState => ({
      ...state(activeProfileId, generation),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 5,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
    });
    let current = quotaReadyState('primary', 1);
    const applied: string[] = [];
    const commitSwitch = vi.fn(async ({ toProfileId }) => {
      await Promise.resolve();
      current = quotaReadyState(toProfileId, current.generation + 1);
      return current;
    });
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch,
      applyGeneration: async ({ sessionId, activeProfileId, generation }) => {
        applied.push(`${sessionId ?? 'none'}:${activeProfileId}:${generation}`);
      },
    });

    const first = coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    });
    const second = coordinator.switchBeforeTurn({
      sessionId: 'session-2',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    });

    await expect(first).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });
    await expect(second).resolves.toMatchObject({ status: 'observed_generation', activeProfileId: 'backup', generation: 2 });
    expect(commitSwitch).toHaveBeenCalledOnce();
    expect(applied.sort()).toEqual([
      'session-1:backup:2',
      'session-2:backup:2',
    ]);
  });

  it('does not surface a failed switch when a predictive pre-turn hot apply is temporarily unavailable', async () => {
    const quotaReadyState = (activeProfileId: string, generation: number): ConnectedServiceAuthGroupSwitchState => ({
      ...state(activeProfileId, generation),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 5,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
    });
    let current = quotaReadyState('primary', 1);
    const applied: string[] = [];
    const events: unknown[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => {
        await Promise.resolve();
        current = quotaReadyState(toProfileId, current.generation + 1);
        return current;
      },
      applyGeneration: async ({ sessionId, activeProfileId, generation }) => {
        applied.push(`${sessionId ?? 'none'}:${activeProfileId}:${generation}`);
        if (sessionId === 'session-1') {
          throw new Error('connected_service_auth_generation_apply_failed:hot_apply_failed');
        }
      },
      emitEvent: (event) => events.push(event),
    });

    const first = coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    });
    const second = coordinator.switchBeforeTurn({
      sessionId: 'session-2',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    });

    await expect(first).resolves.toMatchObject({
      status: 'predictive_apply_unavailable',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'hot_apply_failed',
    });
    await expect(second).resolves.toMatchObject({ status: 'observed_generation', activeProfileId: 'backup', generation: 2 });
    expect(events).not.toContainEqual(expect.objectContaining({
      resultStatus: 'generation_apply_failed',
    }));
    expect(applied.sort()).toEqual([
      'session-1:backup:2',
      'session-2:backup:2',
    ]);
  });

  it('reloads and applies observed state when a cross-daemon generation conflict wins first', async () => {
    let loadCount = 0;
    const applied: string[] = [];
    const events: unknown[] = [];
    const commitSwitch = vi.fn(async () => {
      throw new TestGenerationConflictError(2);
    });
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => {
        loadCount += 1;
        return loadCount === 1
          ? state('primary', 1)
          : {
              ...state('backup', 2),
              memberStatesByProfileId: new Map([
                ['backup', {
                  quotaSnapshot: {
                    capturedAtMs: 1_000,
                    effectiveRemainingPercent: 80,
                  },
                }],
              ]),
            };
      },
      commitSwitch,
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
      emitEvent: (event) => events.push(event),
      resolveGenerationConflict: (error) => error instanceof TestGenerationConflictError ? error.generation : null,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
        decisionTrace: expect.objectContaining({ reason: 'selected' }),
      },
    });
    expect(commitSwitch).toHaveBeenCalledTimes(1);
    // Conflict resolution reads the winner, then the post-apply epoch fence reads once more.
    expect(loadCount).toBe(3);
    expect(applied).toEqual(['backup:2']);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'usage_limit',
        fromGeneration: 1,
        toGeneration: 2,
        resultStatus: 'observed_generation',
        success: true,
      }),
    ]);
  });

  it('returns a structured apply failure when observed conflict generation apply fails', async () => {
    let loadCount = 0;
    const generationConflict = new TestGenerationConflictError(2);
    const applied: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => {
        loadCount += 1;
        return loadCount === 1
          ? state('primary', 1)
          : {
              ...state('backup', 2),
              memberStatesByProfileId: new Map([
                ['backup', {
                  quotaSnapshot: {
                    capturedAtMs: 1_000,
                    effectiveRemainingPercent: 80,
                  },
                }],
              ]),
            };
      },
      commitSwitch: async () => {
        await Promise.resolve();
        throw generationConflict;
      },
      applyGeneration: async ({ sessionId, activeProfileId, generation }) => {
        applied.push(`${sessionId ?? 'none'}:${activeProfileId}:${generation}`);
        if (sessionId === 'session-1') {
          throw new Error('connected_service_auth_generation_apply_failed:hot_apply_failed');
        }
      },
      resolveGenerationConflict: (error) => error instanceof TestGenerationConflictError ? error.generation : null,
    });

    const first = coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    });
    const second = coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-2',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'tertiary',
    });

    await expect(first).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'hot_apply_failed',
      diagnostics: {
        decisionTrace: expect.objectContaining({ reason: 'selected' }),
      },
    });
    await expect(second).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
        decisionTrace: expect.objectContaining({ reason: 'selected' }),
      },
    });
    expect(applied.sort()).toEqual([
      'session-1:backup:2',
      'session-2:backup:2',
    ]);
  });

  it('returns a structured apply failure when divergent observed generation apply fails', async () => {
    const current: ConnectedServiceAuthGroupSwitchState = {
      ...state('backup', 2),
      memberStatesByProfileId: new Map([
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
    };
    const applied: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async () => state('tertiary', 3),
      applyGeneration: async ({ sessionId, activeProfileId, generation }) => {
        applied.push(`${sessionId ?? 'none'}:${activeProfileId}:${generation}`);
        if (sessionId === 'session-1') {
          throw new Error('connected_service_auth_generation_apply_failed:hot_apply_failed');
        }
      },
    });

    const first = coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    });
    const second = coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-2',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'tertiary',
    });

    await expect(first).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'hot_apply_failed',
      diagnostics: {
        decisionTrace: expect.objectContaining({ reason: 'selected' }),
      },
    });
    await expect(second).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
        decisionTrace: expect.objectContaining({ reason: 'selected' }),
      },
    });
    expect(applied.sort()).toEqual([
      'session-1:backup:2',
      'session-2:backup:2',
    ]);
  });

  it('fails closed when an already-advanced pre-turn group generation would require restart-resume adoption', async () => {
    const current: ConnectedServiceAuthGroupSwitchState = {
      ...state('backup', 2),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
      members: [
        { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: false },
        { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
      ],
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 2,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
    };
    const applied: string[] = [];
    const commitSwitch = vi.fn(async ({ toProfileId }) => state(toProfileId, 3));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch,
      applyGeneration: async ({ sessionId, activeProfileId, generation }) => {
        applied.push(`${sessionId ?? 'none'}:${activeProfileId}:${generation}`);
        return { mode: 'restart_resume' as const };
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'hot_apply_restart_required',
      diagnostics: {
        attemptedMode: 'restart_resume',
        policyReason: 'predictive_soft_switch_hot_apply_required',
        decisionTrace: expect.objectContaining({
          activeProfileId: 'primary',
          reason: 'selected',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'backup',
              decision: 'selected',
            }),
          ]),
        }),
      },
    });

    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applied).toEqual(['session-1:backup:2']);
  });

  it('preflights same-account exhausted fanout before committing the group generation', async () => {
    const commitSwitch = vi.fn(async ({ toProfileId }) => state(toProfileId, 2));
    const applyGeneration = vi.fn(async () => ({ mode: 'restart_resume' as const }));
    const preflightApplyGeneration = vi.fn(async () => ({ mode: 'restart_resume' as const }));
    const current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 0,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch,
      applyGeneration,
      preflightApplyGeneration,
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'same_provider_account_exhausted',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'hot_apply_restart_required',
      diagnostics: {
        attemptedMode: 'restart_resume',
        policyReason: 'predictive_soft_switch_hot_apply_required',
        decisionTrace: expect.objectContaining({
          activeProfileId: 'primary',
          reason: 'selected',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'backup',
              decision: 'selected',
            }),
          ]),
        }),
      },
    });

    expect(preflightApplyGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      activeProfileId: 'backup',
      generation: 2,
      reason: 'same_provider_account_exhausted',
    }));
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).not.toHaveBeenCalled();
  });

  it('releases lease waiters when owner preflight fails before commit', async () => {
    let releasePreflight!: () => void;
    let notifyPreflightStarted: (() => void) | null = null;
    const preflightStarted = new Promise<void>((resolve) => {
      notifyPreflightStarted = resolve;
    });
    const preflightRelease = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const commitSwitch = vi.fn(async ({ toProfileId }) => state(toProfileId, 2));
    const applyGeneration = vi.fn(async () => ({ mode: 'restart_resume' as const }));
    const preflightApplyGeneration = vi.fn(async () => {
      notifyPreflightStarted?.();
      await preflightRelease;
      return { mode: 'restart_resume' as const };
    });
    const current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 0,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry({ leaseTimeoutMs: 20 }),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch,
      applyGeneration,
      preflightApplyGeneration,
    });

    const owner = coordinator.switchBeforeTurn({
      sessionId: 'owner-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'same_provider_account_exhausted',
      observedProfileId: 'primary',
    });
    await preflightStarted;
    const waiter = coordinator.switchBeforeTurn({
      sessionId: 'waiter-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'same_provider_account_exhausted',
      observedProfileId: 'primary',
    });
    releasePreflight();

    await expect(owner).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
        decisionTrace: expect.objectContaining({ reason: 'selected' }),
      },
    });
    await expect(waiter).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
        decisionTrace: expect.objectContaining({ reason: 'selected' }),
      },
    });
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).not.toHaveBeenCalled();
  });

  it('preflights lease-loser observed predictive generations before applying them to the session', async () => {
    const commitSwitch = vi.fn(async ({ toProfileId }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return state(toProfileId, 2);
    });
    const applyGeneration = vi.fn(async ({ sessionId }) => (
      sessionId === 'owner-session'
        ? { mode: 'hot_apply' as const }
        : { mode: 'restart_resume' as const }
    ));
    const preflightApplyGeneration = vi.fn(async ({ sessionId }) => (
      sessionId === 'owner-session'
        ? { mode: 'hot_apply' as const }
        : { mode: 'restart_resume' as const }
    ));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => state('primary', 1),
      commitSwitch,
      applyGeneration,
      preflightApplyGeneration,
    });

    const owner = coordinator.switchAfterClassifiedFailure({
      sessionId: 'owner-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'same_provider_account_exhausted',
    });
    const loser = coordinator.switchAfterClassifiedFailure({
      sessionId: 'loser-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'same_provider_account_exhausted',
    });

    await expect(owner).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply',
    });
    await expect(loser).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'hot_apply_restart_required',
      diagnostics: {
        attemptedMode: 'restart_resume',
        policyReason: 'predictive_soft_switch_hot_apply_required',
        decisionTrace: expect.objectContaining({
          activeProfileId: 'primary',
          reason: 'selected',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'backup',
              decision: 'selected',
            }),
          ]),
        }),
      },
    });

    expect(commitSwitch).toHaveBeenCalledTimes(1);
    expect(applyGeneration).toHaveBeenCalledTimes(1);
    expect(applyGeneration).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'owner-session' }));
    expect(preflightApplyGeneration).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'loser-session' }));
  });

  it('fails closed when an unproven already-advanced pre-turn group profile would require restart-resume application', async () => {
    const current: ConnectedServiceAuthGroupSwitchState = {
      ...state('backup', 2),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
      members: [
        { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
        { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
        { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
      ],
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 2,
          },
        }],
        ['tertiary', {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
    };
    const applied: string[] = [];
    const commitSwitch = vi.fn(async ({ fromProfileId, toProfileId }) => ({
      ...state(toProfileId, 3),
      activeProfileId: toProfileId,
      members: current.members,
    }));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch,
      applyGeneration: async ({ sessionId, activeProfileId, generation, fromProfileId }) => {
        applied.push(`${sessionId ?? 'none'}:${fromProfileId ?? 'none'}->${activeProfileId}:${generation}`);
        return { mode: 'restart_resume' as const };
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'tertiary',
      generation: 3,
      errorCode: 'hot_apply_restart_required',
      diagnostics: {
        attemptedMode: 'restart_resume',
        policyReason: 'predictive_soft_switch_hot_apply_required',
        decisionTrace: expect.objectContaining({
          reason: 'selected',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'tertiary',
              decision: 'selected',
            }),
          ]),
        }),
      },
    });

    expect(commitSwitch).toHaveBeenCalledWith(expect.objectContaining({
      fromProfileId: 'backup',
      toProfileId: 'tertiary',
    }));
    expect(applied).toEqual(['session-1:backup->tertiary:3']);
  });

  it('rejects lease losers without applying a synthetic generation when the owner switch fails', async () => {
    const applied: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => state('primary', 1),
      commitSwitch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('commit failed');
      },
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
      },
    });

    const first = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    });
    const second = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    });

    await expect(first).rejects.toThrow('commit failed');
    await expect(second).rejects.toThrow('commit failed');
    expect(applied).toEqual([]);
  });
});
