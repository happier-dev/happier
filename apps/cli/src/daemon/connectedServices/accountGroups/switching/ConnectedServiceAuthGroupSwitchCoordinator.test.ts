import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
  type ConnectedServiceAuthGroupSwitchState,
} from './ConnectedServiceAuthGroupSwitchCoordinator';
import { ConnectedServiceAuthGroupQuotaProbeIncompleteError } from '../quotas/preTurnQuotaProbe';
import { buildConnectedServiceAuthGroupObservedFailureMemberState } from '../runtimeState/buildConnectedServiceAuthGroupObservedFailureMemberState';

function state(activeProfileId: string, generation: number): ConnectedServiceAuthGroupSwitchState {
  return {
    serviceId: 'openai-codex',
    groupId: 'main',
    activeProfileId,
    generation,
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true },
    members: [
      { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
    ],
    memberStatesByProfileId: new Map(),
  };
}

const failedCredentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
const replacementCredentialRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';

function stateWithCredential(
  activeProfileId: string,
  generation: number,
  credentialRevision: string,
  members: ConnectedServiceAuthGroupSwitchState['members'] = state(activeProfileId, generation).members,
): ConnectedServiceAuthGroupSwitchState {
  return {
    ...state(activeProfileId, generation),
    credentialRevision,
    members,
  };
}

class TestGenerationConflictError extends Error {
  constructor(readonly generation: number) {
    super('connected_service_auth_group_generation_conflict');
  }
}

describe('ConnectedServiceAuthGroupSwitchCoordinator', () => {
  function rejectedStartFixture(overrides: Partial<ConnectedServiceAuthGroupSwitchState> = {}) {
    let current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      credentialRevision: failedCredentialRevision,
      policy: { ...state('primary', 1).policy, maxSwitchesPerTurn: 1, maxSwitchesPerSessionHour: 1 },
      members: [...state('primary', 1).members, { profileId: 'third', priority: 3, createdAtMs: 3, enabled: true }],
      ...overrides,
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      recordObservedFailureState: async (failure) => {
        const profileId = failure.observedProfileId!;
        current = { ...current, memberStatesByProfileId: new Map(current.memberStatesByProfileId).set(profileId,
          buildConnectedServiceAuthGroupObservedFailureMemberState({
            ...failure, existing: current.memberStatesByProfileId.get(profileId) ?? {},
            retryAtMs: null, cooldownMs: current.policy.cooldownMs, planType: null, observedAtMs: 1_000,
          })) };
      },
      commitSwitch: async ({ toProfileId }) => {
        current = { ...current, activeProfileId: toProfileId, generation: current.generation + 1 };
        return current;
      },
      applyGeneration: async () => ({ ok: true }),
    });
    const request = {
      sessionId: 'run-1', serviceId: 'openai-codex', groupId: 'main',
      reason: 'plan', limitCategory: 'plan_invalid', quotaScope: 'model', providerLimitId: 'gpt-6.1-sol',
      rejectedStart: true,
    };
    return { coordinator, request };
  }

  it('selects the third member after two rejected model starts without charging or enforcing turn/hour switch limits', async () => {
    const { coordinator, request } = rejectedStartFixture();
    await expect(coordinator.switchAfterClassifiedFailure({
      ...request, observedProfileId: 'primary', switchesThisTurn: 1, sessionSwitchesThisHour: 1,
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });
    await expect(coordinator.switchAfterClassifiedFailure({
      ...request, observedProfileId: 'backup', switchesThisTurn: 2,
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'third', generation: 3 });
    // Another model can use the rejected accounts; the two rejected starts must
    // not have consumed this Run's ordinary hourly switch allowance.
    const ordinaryRequest = { ...request, providerLimitId: 'another-model', rejectedStart: false };
    await expect(coordinator.switchAfterClassifiedFailure({
      ...ordinaryRequest, observedProfileId: 'third',
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'primary', generation: 4 });
    await expect(coordinator.switchAfterClassifiedFailure({
      ...ordinaryRequest, observedProfileId: 'primary',
    })).resolves.toMatchObject({ status: 'switch_limit_reached', generation: 4 });
  });

  it('exhausts model-ineligible members instead of reaching the ordinary switch limit', async () => {
    const { coordinator, request } = rejectedStartFixture();
    for (const [observedProfileId, activeProfileId] of [['primary', 'backup'], ['backup', 'third']]) {
      await expect(coordinator.switchAfterClassifiedFailure({ ...request, observedProfileId }))
        .resolves.toMatchObject({ status: 'switched', activeProfileId });
    }
    await expect(coordinator.switchAfterClassifiedFailure({ ...request, observedProfileId: 'third' }))
      .resolves.toMatchObject({ status: 'no_eligible_member', groupExhausted: true, generation: 3,
        excluded: expect.arrayContaining([
          expect.objectContaining({ profileId: 'primary', reason: 'plan_unavailable' }),
          expect.objectContaining({ profileId: 'backup', reason: 'plan_unavailable' }),
        ]) });
  });

  it('records model exclusions for exact-current rejected-start sources before selecting the next member', async () => {
    const { coordinator, request } = rejectedStartFixture();
    for (const [profileId, groupGeneration, activeProfileId] of [
      ['primary', 1, 'backup'], ['backup', 2, 'third'],
    ] as const) {
      await expect(coordinator.switchAfterClassifiedFailure({ ...request, observedProfileId: profileId,
        expectedFailureSource: { profileId, groupGeneration, credentialRevision: failedCredentialRevision },
      })).resolves.toMatchObject({ status: 'switched', activeProfileId });
    }
  });

  it.each(['after_write', 'generation_conflict'] as const)('does not act on a replaced rejected-start source %s', async (replacementPoint) => {
    let current = stateWithCredential('primary', 1, failedCredentialRevision);
    const recordObservedFailureState = vi.fn(async () => {
      current = stateWithCredential('backup', 2, replacementCredentialRevision);
      if (replacementPoint === 'generation_conflict') throw new TestGenerationConflictError(2);
    });
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000, quotaFreshnessMs: 60_000, loadState: async () => current,
      recordObservedFailureState,
      resolveGenerationConflict: (error) => error instanceof TestGenerationConflictError ? error.generation : null,
      commitSwitch: async () => { throw new Error('must not switch a replaced source'); },
      applyGeneration: async () => { throw new Error('must not apply a replaced source'); },
    });
    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex', groupId: 'main', observedProfileId: 'primary',
      reason: 'plan', limitCategory: 'plan_invalid', quotaScope: 'model', providerLimitId: 'gpt-6.1-sol', rejectedStart: true,
      expectedFailureSource: { profileId: 'primary', groupGeneration: 1, credentialRevision: failedCredentialRevision },
    })).resolves.toMatchObject({ status: 'stale_context', generation: 2 });
    expect(recordObservedFailureState).toHaveBeenCalledOnce();
  });

  it('does not adopt a divergent active member excluded for the rejected-start model', async () => {
    const { coordinator, request } = rejectedStartFixture({
      activeProfileId: 'backup',
      memberStatesByProfileId: new Map([['backup', { modelUnavailableUntilMsByModelId: { 'gpt-6.1-sol': 86_401_000 } }]]),
    });
    await expect(coordinator.switchAfterClassifiedFailure({ ...request, observedProfileId: 'primary' }))
      .resolves.toMatchObject({ status: 'switched', activeProfileId: 'third' });
  });

  it('selects a model-eligible member before a new turn instead of reusing model-cooled priority members', async () => {
    const { coordinator } = rejectedStartFixture({
      memberStatesByProfileId: new Map(['primary', 'backup'].map((profileId) => [profileId, {
        modelUnavailableUntilMsByModelId: { 'gpt-6.1-sol': 86_401_000 },
      }])),
    });
    const request = { serviceId: 'openai-codex', groupId: 'main', reason: 'soft_threshold' as const,
      observedProfileId: 'primary', providerLimitId: 'gpt-6.1-sol' };
    await expect(coordinator.switchBeforeTurn(request))
      .resolves.toMatchObject({ status: 'switched', activeProfileId: 'third' });
  });

  it('selects around persisted model entitlement cooldowns before a turn without quota probes and retains ordinary limits', async () => {
    let current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      memberStatesByProfileId: new Map([['primary', {
        modelUnavailableUntilMsByModelId: { 'gpt-6.1-sol': 86_401_000 },
      }]]),
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000, quotaFreshnessMs: 60_000,
      loadState: async () => current,
      probeQuotaSnapshotsForGroup: async () => { throw new Error('persisted model entitlement must not open quota transport'); },
      commitSwitch: async ({ toProfileId }) => {
        current = { ...current, activeProfileId: toProfileId, generation: current.generation + 1 };
        return current;
      },
      applyGeneration: async () => ({ ok: true }),
    });
    const request = { serviceId: 'openai-codex', groupId: 'main', reason: 'plan' as const,
      observedProfileId: 'primary', providerLimitId: 'gpt-6.1-sol' };
    await expect(coordinator.switchBeforeTurn(request))
      .resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });
    await expect(coordinator.switchBeforeTurn({ ...request, observedProfileId: 'backup', switchesThisTurn: 1 }))
      .resolves.toMatchObject({ status: 'switch_limit_reached', generation: 2 });
  });

  it('does not adopt a model-cooled divergent active member before a new turn despite healthy usage quota', async () => {
    const { coordinator } = rejectedStartFixture({
      activeProfileId: 'backup',
      memberStatesByProfileId: new Map([['primary', { authInvalidUntilMs: 86_401_000 }], ['backup', {
        modelUnavailableUntilMsByModelId: { 'gpt-6.1-sol': 86_401_000 },
        quotaSnapshot: { capturedAtMs: 900, effectiveRemainingPercent: 80 },
      }]]),
    });
    const request = { serviceId: 'openai-codex', groupId: 'main', reason: 'soft_threshold' as const,
      observedProfileId: 'primary', providerLimitId: 'gpt-6.1-sol' };
    await expect(coordinator.switchBeforeTurn(request))
      .resolves.toMatchObject({ status: 'switched', activeProfileId: 'third' });
  });

  it.each(['state_read', 'candidate_preparation'] as const)('ignores a rejected-start source revoked during %s', async (revocationPoint) => {
    let current = true;
    const stateSnapshot = stateWithCredential('primary', 1, failedCredentialRevision);
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000, quotaFreshnessMs: 60_000,
      loadState: async () => { if (revocationPoint === 'state_read') current = false; return stateSnapshot; },
      prepareCandidateForSwitch: async () => { current = false; return { status: 'ready' }; },
      recordObservedFailureState: async () => { if (!current) throw new Error('must not persist revoked source'); },
      commitSwitch: async () => { throw new Error('must not switch revoked source'); },
      applyGeneration: async () => { throw new Error('must not apply revoked source'); },
    });
    const expectedFailureSource = { profileId: 'primary', groupGeneration: 1, credentialRevision: failedCredentialRevision,
      isCurrent: () => current };
    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex', groupId: 'main', observedProfileId: 'primary',
      reason: 'plan', limitCategory: 'plan_invalid', quotaScope: 'model', providerLimitId: 'gpt-6.1-sol', rejectedStart: true,
      expectedFailureSource,
    })).resolves.toMatchObject({ status: 'stale_context', generation: 1 });
  });

  it.each([
    { rejectedStart: false }, { reason: 'usage_limit' }, { limitCategory: 'usage_limit' },
    { quotaScope: 'account' }, { providerLimitId: ' ' },
  ])('retains ordinary limits unless rejected-start model entitlement evidence is complete (%j)', async (override) => {
    const { coordinator, request } = rejectedStartFixture();
    await expect(coordinator.switchAfterClassifiedFailure({
      ...request, ...override, observedProfileId: 'primary', switchesThisTurn: 1,
    })).resolves.toMatchObject({ status: 'switch_limit_reached', generation: 1 });
  });

  it('does not poison or rotate a pool for an exact unselected quota-family failure', async () => {
    const current = {
      ...state('primary', 7),
      policy: {
        ...state('primary', 7).policy,
        quotaLimitSelection: { mode: 'selected' as const, providerLimitIds: ['weekly'] },
      },
    };
    const recordObservedFailureState = vi.fn(async () => {});
    const commitSwitch = vi.fn();
    const applyGeneration = vi.fn();
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      recordObservedFailureState,
      commitSwitch,
      applyGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      observedProfileId: 'primary',
      reason: 'usage_limit',
      providerLimitId: 'spark',
    })).resolves.toEqual({ status: 'switch_reason_disabled', generation: 7 });
    expect(recordObservedFailureState).not.toHaveBeenCalled();
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).not.toHaveBeenCalled();
  });

  it('re-applies the sole current member after a scheduled reset only with fresh positive quota proof', async () => {
    const currentState: ConnectedServiceAuthGroupSwitchState = {
      ...stateWithCredential('primary', 7, failedCredentialRevision, [
        { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      ]),
      memberStatesByProfileId: new Map([['primary', {
        quotaSnapshot: { capturedAtMs: 20_000, effectiveRemainingPercent: 100 },
      }]]),
    };
    const applyGeneration = vi.fn(async () => ({ ok: true as const, mode: 'hot_apply' as const }));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 20_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => currentState,
      commitSwitch: async () => { throw new Error('must not advance the generation'); },
      applyGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      sessionId: 'session-1',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      allowCurrentProfileRetry: true,
    } as Parameters<typeof coordinator.switchAfterClassifiedFailure>[0])).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'primary',
      generation: 7,
      quotaRecovery: {
        quotaSnapshot: { capturedAtMs: 20_000, effectiveRemainingPercent: 100 },
      },
    });
    expect(applyGeneration).toHaveBeenCalledOnce();
  });

  it('keeps the current member excluded when a scheduled reset has no fresh positive quota proof', async () => {
    const currentState: ConnectedServiceAuthGroupSwitchState = {
      ...stateWithCredential('primary', 7, failedCredentialRevision, [
        { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      ]),
      memberStatesByProfileId: new Map([['primary', {
        quotaSnapshot: { capturedAtMs: 10_000, effectiveRemainingPercent: 100 },
      }]]),
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 20_000,
      quotaFreshnessMs: 1_000,
      loadState: async () => currentState,
      commitSwitch: async () => { throw new Error('must not advance the generation'); },
      applyGeneration: async () => { throw new Error('must not re-apply without current proof'); },
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      sessionId: 'session-1',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      allowCurrentProfileRetry: true,
    })).resolves.toMatchObject({ status: 'no_eligible_member', generation: 7 });
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
      applyGeneration: async () => ({ ok: true, mode: 'hot_apply' }),
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

  it.each([
    ['primary', 'switchAfterClassifiedFailure'], ['backup', 'switchAfterClassifiedFailure'],
    ['primary', 'switchBeforeTurn'], ['backup', 'switchBeforeTurn'],
  ] as const)('uses one reset after quota exhaustion and reuses generation application for %s via %s', async (resetProfile, trigger) => {
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
    const resetContexts: unknown[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => stored,
      commitSwitch: async ({ toProfileId }) => (stored = { ...stored, activeProfileId: toProfileId, generation: 2 }),
      applyGeneration: async ({ activeProfileId }) => { applied.push(activeProfileId!); return { ok: true, mode: 'hot_apply' }; },
      consumeAvailableRecoveryCreditForProfile: async ({ profileId, automaticResetContext }) => {
        if (profileId !== resetProfile) return { ok: false, errorCode: 'connected_service_quota_recovery_credit_not_available', error: 'not available' };
        resetContexts.push(automaticResetContext);
        redeemed.push(profileId);
        stored = { ...stored, memberStatesByProfileId: new Map(stored.memberStatesByProfileId).set(profileId, {
          quotaSnapshot: { capturedAtMs: 1_000, effectiveRemainingPercent: 100 },
        }) };
        return { ok: true, snapshot: null, receipt: { idempotencyKey: `reset:${profileId}`, status: 'consumed' } };
      },
    });
    await expect(coordinator[trigger]({
      sessionId: 'source-session', serviceId: 'openai-codex', groupId: 'main', reason: 'usage_limit', observedProfileId: 'primary',
    })).resolves.toMatchObject({ activeProfileId: resetProfile, status: resetProfile === 'primary' ? 'observed_generation' : 'switched' });
    expect(redeemed).toEqual([resetProfile]);
    expect(resetContexts).toEqual([{ groupId: 'main', sessionId: 'source-session' }]);
    expect(applied).toEqual([resetProfile]);
    expect(stored.generation).toBe(resetProfile === 'primary' ? 1 : 2);
  });
    it.each(['needs_reauth', 'refresh_failed_retryable'] as const)('validates quota-recovery candidates before CAS and skips a member with %s', async (credentialHealthStatus) => {
        const initial = {
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
            applyGeneration: async () => ({ ok: true, mode: 'hot_apply' as const }),
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
        expect(prepareCandidateForSwitch).toHaveBeenCalledTimes(2);
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
      applyGeneration: async () => ({ ok: true, mode: 'hot_apply' }),
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
      applyGeneration: async () => ({ ok: true as const, mode: 'hot_apply' as const }),
      probeQuotaSnapshotsForGroup: async (input) => {
        notifyProbeStarted();
        await probeGate;
        return {
          status: 'complete' as const,
          requestedProfileCount: input.profileIds.length,
          completedProfileCount: input.profileIds.length,
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
      let current = stateWithCredential('primary', 1, failedCredentialRevision);
      const applyGeneration = vi.fn(async () => ({ ok: true as const, mode: 'hot_apply' as const }));
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
        expectedFailureSource: {
          profileId: 'primary',
          credentialRevision: failedCredentialRevision,
          groupGeneration: 1,
        },
      });
      current = stateWithCredential('backup', 2, replacementCredentialRevision);
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
      let current = stateWithCredential('primary', 1, failedCredentialRevision);
      const applyGeneration = vi.fn(async () => ({ ok: true as const, mode: 'hot_apply' as const }));
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
      current = stateWithCredential('backup', 2, replacementCredentialRevision);
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
      }));
      owner.finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      'replacement credential',
      stateWithCredential('primary', 7, replacementCredentialRevision),
    ],
    [
      'newer group generation with the same active member',
      stateWithCredential('primary', 8, failedCredentialRevision),
    ],
    [
      'newer group generation with a different active member',
      stateWithCredential('backup', 8, replacementCredentialRevision),
    ],
    [
      'removed failed member',
      stateWithCredential(
        'backup',
        8,
        replacementCredentialRevision,
        [{ profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true }],
      ),
    ],
  ])('ignores exact request-auth evidence after a %s without effects', async (_label, current) => {
    const recordObservedFailureState = vi.fn(async () => {});
    const probeQuotaSnapshotsForGroup = vi.fn(async () => {});
    const commitSwitch = vi.fn(async () => stateWithCredential(
      'backup',
      current.generation + 1,
      replacementCredentialRevision,
    ));
    const applyGeneration = vi.fn(async () => ({ ok: true as const }));
    const emitEvent = vi.fn();
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      recordObservedFailureState,
      probeQuotaSnapshotsForGroup,
      commitSwitch,
      applyGeneration,
      emitEvent,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      observedProfileId: 'primary',
      expectedFailureSource: {
        profileId: 'primary',
        credentialRevision: failedCredentialRevision,
        groupGeneration: 7,
      },
      reason: 'usage_limit',
    })).resolves.toEqual({
      status: 'stale_context',
      generation: current.generation,
    });

    expect(recordObservedFailureState).not.toHaveBeenCalled();
    expect(probeQuotaSnapshotsForGroup).not.toHaveBeenCalled();
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('revalidates exact request-auth evidence after an awaited load before any effect', async () => {
    let current = stateWithCredential(
      'primary',
      7,
      failedCredentialRevision,
    );
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const loadState = vi.fn(async () => {
      await loadGate;
      return current;
    });
    const recordObservedFailureState = vi.fn(async () => {});
    const commitSwitch = vi.fn();
    const applyGeneration = vi.fn();
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState,
      recordObservedFailureState,
      commitSwitch,
      applyGeneration,
    });

    const result = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      observedProfileId: 'primary',
      expectedFailureSource: {
        profileId: 'primary',
        credentialRevision: failedCredentialRevision,
        groupGeneration: 7,
      },
      reason: 'usage_limit',
    });
    await vi.waitFor(() => {
      expect(loadState).toHaveBeenCalledOnce();
    });
    current = stateWithCredential(
      'primary',
      7,
      replacementCredentialRevision,
    );
    releaseLoad();

    await expect(result).resolves.toEqual({
      status: 'stale_context',
      generation: 7,
    });
    expect(recordObservedFailureState).not.toHaveBeenCalled();
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).not.toHaveBeenCalled();
  });

  it('retains canonical failure-state persistence for generic failures without an exact request-auth source', async () => {
    let current = state('primary', 7);
    const recordObservedFailureState = vi.fn(async () => {});
    const commitSwitch = vi.fn(async () => {
      current = state('backup', 8);
      return current;
    });
    const applyGeneration = vi.fn(async () => ({
      ok: true as const,
      mode: 'spawn_next_turn' as const,
    }));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      recordObservedFailureState,
      commitSwitch,
      applyGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      observedProfileId: 'primary',
      reason: 'usage_limit',
    })).resolves.toMatchObject({
      status: 'switched',
      generation: 8,
    });
    expect(recordObservedFailureState).toHaveBeenCalledOnce();
    expect(commitSwitch).toHaveBeenCalledOnce();
    expect(applyGeneration).toHaveBeenCalledOnce();
  });

  it('applies an exact current request-auth switch once without an unfenced failure-state write', async () => {
    let current = stateWithCredential(
      'primary',
      7,
      failedCredentialRevision,
    );
    const recordObservedFailureState = vi.fn(async () => {});
    const commitSwitch = vi.fn(async () => {
      current = stateWithCredential(
        'backup',
        8,
        replacementCredentialRevision,
      );
      return current;
    });
    const applyGeneration = vi.fn(async () => ({
      ok: true as const,
      mode: 'spawn_next_turn' as const,
    }));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      recordObservedFailureState,
      commitSwitch,
      applyGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      observedProfileId: 'primary',
      expectedFailureSource: {
        profileId: 'primary',
        credentialRevision: failedCredentialRevision,
        groupGeneration: 7,
      },
      reason: 'usage_limit',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 8,
    });
    expect(recordObservedFailureState).not.toHaveBeenCalled();
    expect(commitSwitch).toHaveBeenCalledOnce();
    expect(applyGeneration).toHaveBeenCalledOnce();
  });

  it('does not let a stale lease owner suppress a current exact failure', async () => {
    let current = stateWithCredential(
      'primary',
      7,
      replacementCredentialRevision,
    );
    let releaseFirstLoad!: () => void;
    const firstLoadGate = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    let loadCount = 0;
    const loadState = vi.fn(async () => {
      loadCount += 1;
      if (loadCount === 1) await firstLoadGate;
      return current;
    });
    const recordObservedFailureState = vi.fn(async () => {});
    const commitSwitch = vi.fn(async () => {
      current = stateWithCredential(
        'backup',
        8,
        failedCredentialRevision,
      );
      return current;
    });
    const applyGeneration = vi.fn(async () => ({
      ok: true as const,
      mode: 'spawn_next_turn' as const,
    }));
    const emitEvent = vi.fn();
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState,
      recordObservedFailureState,
      commitSwitch,
      applyGeneration,
      emitEvent,
    });
    const stale = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      observedProfileId: 'primary',
      expectedFailureSource: {
        profileId: 'primary',
        credentialRevision: failedCredentialRevision,
        groupGeneration: 7,
      },
      reason: 'usage_limit',
    });
    await vi.waitFor(() => {
      expect(loadState).toHaveBeenCalledOnce();
    });
    const currentFailure = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      observedProfileId: 'primary',
      expectedFailureSource: {
        profileId: 'primary',
        credentialRevision: replacementCredentialRevision,
        groupGeneration: 7,
      },
      reason: 'usage_limit',
    });
    releaseFirstLoad();

    await expect(stale).resolves.toEqual({
      status: 'stale_context',
      generation: 7,
    });
    await expect(currentFailure).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 8,
    });
    expect(recordObservedFailureState).not.toHaveBeenCalled();
    expect(commitSwitch).toHaveBeenCalledOnce();
    expect(applyGeneration).toHaveBeenCalledOnce();
    expect(emitEvent).toHaveBeenCalledOnce();
  });

  it('does not coalesce different qualified services that share a group id', () => {
    const leases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<
      Readonly<{ pluginId: string; localId: string }>
    >();
    const first = leases.acquire({
      serviceId: {
        pluginId: 'acme.alpha',
        localId: 'shared',
      },
      groupId: 'main',
    });
    const second = leases.acquire({
      serviceId: {
        pluginId: 'acme.beta',
        localId: 'shared',
      },
      groupId: 'main',
    });

    expect(first.kind).toBe('owner');
    expect(second.kind).toBe('owner');
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
      expect(leases.acquire({ serviceId: 'openai-codex', groupId: 'main' }).kind).toBe('loser');
      if (owner.kind !== 'owner') throw new Error('owner expected');
      owner.complete({ serviceId: 'openai-codex', groupId: 'main', activeProfileId: 'backup', generation: 2 });
      expect(leases.acquire({ serviceId: 'openai-codex', groupId: 'main' }).kind).toBe('loser');
      owner.finish();
      expect(leases.acquire({ serviceId: 'openai-codex', groupId: 'main' }).kind).toBe('owner');

    } finally {
      vi.useRealTimers();
    }
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
        current = withQuota('primary', 3);
        return { ok: true as const, mode: 'hot_apply' as const };
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
        return { ok: true as const, mode: 'hot_apply' as const };
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

  it('waits after a classified usage limit when switching is disabled but recovery allows waiting', async () => {
    let didCommit = false;
    const events: unknown[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      loadState: async () => ({
        ...state('primary', 1),
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: false },
      }),
      commitSwitch: async () => {
        didCommit = true;
        return state('backup', 2);
      },
      applyGeneration: async () => ({ ok: true }),
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
    expect(events).toContainEqual(expect.objectContaining({
      type: 'connected_service_auth_group_switch',
      resultStatus: 'no_eligible_member',
      success: false,
    }));
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
      applyGeneration: async () => ({ ok: true }),
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
    const applyGeneration = vi.fn(async () => ({ ok: true as const }));
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
      reason: 'usage_limit',
    })).resolves.toEqual({ status: 'auto_switch_disabled', generation: 1 });
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).not.toHaveBeenCalled();
  });

  it('treats capacity failures as usage-limit gated automatic switches', async () => {
    const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 2));
    const applyGeneration = vi.fn(async () => ({ ok: true as const }));
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
            usageLimit: true,
          },
        },
        memberStatesByProfileId: new Map([
          ['primary', { capacityLimitedUntilMs: 30_000 }],
        ]),
      }),
      commitSwitch,
      applyGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'capacity',
      observedProfileId: 'primary',
      retryAtMs: 30_000,
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });
    expect(commitSwitch).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'capacity',
      fromProfileId: 'primary',
      toProfileId: 'backup',
    }));
  });

  it('honors recoveryMode wait_until_reset by recording failure state without switching accounts', async () => {
    const commitSwitch = vi.fn(async () => state('backup', 2));
    const applyGeneration = vi.fn(async () => ({ ok: true as const }));
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

  it('does not ask lease losers to apply a generation when no switch was committed', async () => {
    const applied: string[] = [];
    const events: unknown[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          ...state('primary', 1),
          policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: false },
        };
      },
      commitSwitch: async () => state('backup', 2),
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
        return { ok: true };
      },
      emitEvent: (event) => events.push(event),
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

    await expect(first).resolves.toMatchObject({
      status: 'no_eligible_member',
      generation: 1,
      groupExhausted: true,
    });
    await expect(second).resolves.toMatchObject({
      status: 'no_eligible_member',
      generation: 1,
      groupExhausted: true,
    });
    expect(applied).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        resultStatus: 'no_eligible_member',
        success: false,
        fromProfileId: 'primary',
      }),
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        resultStatus: 'no_eligible_member',
        success: false,
        fromProfileId: 'primary',
      }),
    ]);
  });

  it('treats permanent refresh failure as auth recovery when auth-expired fallback is enabled', async () => {
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
      applyGeneration: async () => ({ ok: true }),
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'refresh_failed',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
    });
    expect(didCommit).toBe(true);
  });

  it('treats permission denial as auth recovery when auth-expired fallback is enabled', async () => {
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
      applyGeneration: async () => ({ ok: true }),
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'permission_denied',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
    });
    expect(didCommit).toBe(true);
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
      applyGeneration: async () => ({ ok: true }),
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
      applyGeneration: async () => ({ ok: true }),
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
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
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
      applyGeneration: async () => ({ ok: true }),
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
      applyGeneration: async () => ({ ok: true }),
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      retryAtMs: 30_000,
      limitCategory: 'usage_limit',
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
        limitCategory: 'usage_limit',
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
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      loadState: async () => ({
        ...state('primary', 1),
        activeProfileId: null,
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaExhaustedUntilMs: 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: 1_000,
          }],
        ]),
      }),
      commitSwitch: async ({ fromProfileId, toProfileId }) => {
        expect(fromProfileId).toBeNull();
        expect(toProfileId).toBe('backup');
        return state(toProfileId, 2);
      },
      applyGeneration: async () => ({ ok: true }),
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
    const now = 1_000_000;
    let current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      members: [
        { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
        { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
        { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
      ],
      memberStatesByProfileId: new Map([
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 1,
            effectiveRemainingPercent: 50,
            exhausted: false,
          },
        }],
        ['tertiary', {
          quotaSnapshot: {
            capturedAtMs: 1,
            effectiveRemainingPercent: 80,
            exhausted: false,
          },
        }],
      ]),
    };
    const probeQuotaSnapshotsForGroup = vi.fn(async () => {
      current = {
        ...current,
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaExhaustedUntilMs: now + 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: now,
          }],
          ['backup', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 0,
              exhausted: true,
            },
          }],
          ['tertiary', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 80,
              exhausted: false,
            },
          }],
        ]),
      };
    });
    const deps = {
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      recordObservedFailureState: vi.fn(async () => {}),
      probeQuotaSnapshotsForGroup,
      commitSwitch: vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 2)),
      applyGeneration: vi.fn(async () => ({ ok: true as const })),
    } satisfies ConstructorParameters<typeof ConnectedServiceAuthGroupSwitchCoordinator>[0] & {
      probeQuotaSnapshotsForGroup: typeof probeQuotaSnapshotsForGroup;
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator(deps);

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: now + 30_000,
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'tertiary', generation: 2 });

    expect(probeQuotaSnapshotsForGroup).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileIds: ['backup', 'tertiary'],
      reason: 'usage_limit',
    });
    expect(deps.commitSwitch).toHaveBeenCalledWith(expect.objectContaining({ toProfileId: 'tertiary' }));
  });

  it('applies a divergent group-active profile only after proving that profile is eligible', async () => {
    const now = 1_000_000;
    const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
    const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 3));
    const applyGeneration = vi.fn(async () => ({ ok: true as const }));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('backup', 2),
        credentialRevision,
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaExhaustedUntilMs: now + 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: now,
          }],
          ['backup', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 80,
              exhausted: false,
            },
          }],
        ]),
      }),
      commitSwitch,
      applyGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: now + 30_000,
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision,
      diagnostics: {
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
    expect(applyGeneration).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision,
      reason: 'usage_limit',
    }));
  });

  it('adopts the current group-active profile before globally advancing a group after a stale session member fails', async () => {
    const now = 1_000_000;
    const applied: string[] = [];
    const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 3));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
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
            quotaExhaustedUntilMs: now + 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: now,
          }],
        ]),
      }),
      commitSwitch,
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
        return { ok: true as const, mode: 'hot_apply' };
      },
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: now + 30_000,
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply',
      diagnostics: {
        decisionTrace: expect.objectContaining({
          activeProfileId: 'primary',
          reason: 'selected',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              profileId: 'backup',
              decision: 'eligible',
            }),
          ]),
        }),
      },
    });

    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applied).toEqual(['backup:2']);
  });

  it('still falls back globally when the current group-active profile is already blocked', async () => {
    const now = 1_000_000;
    const committed: string[] = [];
    const applied: string[] = [];
    const members = [
      { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
      { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
    ];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('backup', 2),
        members,
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaExhaustedUntilMs: now + 30_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: now,
          }],
          ['backup', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 0,
              exhausted: true,
            },
          }],
          ['tertiary', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 80,
              exhausted: false,
            },
          }],
        ]),
      }),
      commitSwitch: async ({ fromProfileId, toProfileId }) => {
        committed.push(`${fromProfileId}->${toProfileId}`);
        return {
          ...state(toProfileId, 3),
          members,
        };
      },
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
        return { ok: true as const, mode: 'restart_resume' };
      },
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAtMs: now + 30_000,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'tertiary',
      generation: 3,
      mode: 'restart_resume',
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

    expect(committed).toEqual(['backup->tertiary']);
    expect(applied).toEqual(['tertiary:3']);
  });

  it('post-fences a same-generation credential revision that was superseded during apply', async () => {
    const adoptedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const authoritativeRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const current = { ...state('backup', 2), credentialRevision: authoritativeRevision };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: vi.fn(),
      applyGeneration: async () => ({ ok: true as const, mode: 'hot_apply' as const }),
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

  it('treats an apply-time credential revision fence as authoritative supersession', async () => {
    const adoptedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const authoritativeRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const current = { ...state('backup', 2), credentialRevision: authoritativeRevision };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: vi.fn(),
      applyGeneration: async () => ({
        ok: false as const,
        errorCode: 'credential_revision_superseded',
      }),
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

  it('keeps an unverified apply-time credential revision fence as an apply failure', async () => {
    const adoptedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const current = { ...state('backup', 2), credentialRevision: adoptedRevision };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: vi.fn(),
      applyGeneration: async () => ({
        ok: false as const,
        errorCode: 'credential_revision_superseded',
      }),
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
      status: 'generation_apply_failed',
      errorCode: 'credential_revision_superseded',
    });
  });

  it('probes stale group quota state before selecting a soft-threshold pre-turn candidate', async () => {
    const now = 1_000_000;
    let current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: 1,
            effectiveRemainingPercent: 5,
            exhausted: false,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 1,
            effectiveRemainingPercent: 50,
            exhausted: false,
          },
        }],
      ]),
    };
    const probeQuotaSnapshotsForGroup = vi.fn(async () => {
      current = {
        ...current,
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 5,
              exhausted: false,
            },
          }],
          ['backup', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 90,
              exhausted: false,
            },
          }],
        ]),
      };
    });
    const deps = {
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      probeQuotaSnapshotsForGroup,
      commitSwitch: vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 2)),
      applyGeneration: vi.fn(async () => ({ ok: true as const })),
    } satisfies ConstructorParameters<typeof ConnectedServiceAuthGroupSwitchCoordinator>[0] & {
      probeQuotaSnapshotsForGroup: typeof probeQuotaSnapshotsForGroup;
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator(deps);

    await expect(coordinator.switchBeforeTurn({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });

    expect(probeQuotaSnapshotsForGroup).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileIds: ['primary', 'backup'],
      reason: 'soft_threshold',
    });
  });

  it.each(['soft_threshold', 'usage_limit'] as const)(
    'does not select or commit from incomplete quota evidence for %s',
    async (reason) => {
      const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 2));
      const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
        leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
        nowMs: () => 1_000,
        quotaFreshnessMs: 60_000,
        loadState: async () => state('primary', 1),
        probeQuotaSnapshotsForGroup: async () => ({
          status: 'incomplete' as const,
          requestedProfileCount: 2,
          completedProfileCount: 1,
          reason: 'deadline_exceeded' as const,
        }),
        commitSwitch,
        applyGeneration: async () => ({ ok: true as const }),
      });

      await expect(coordinator.switchBeforeTurn({
        serviceId: 'openai-codex',
        groupId: 'main',
        reason,
      })).rejects.toBeInstanceOf(ConnectedServiceAuthGroupQuotaProbeIncompleteError);
      expect(commitSwitch).not.toHaveBeenCalled();
    },
  );

  it('applies an already-advanced pre-turn group generation to a stale session profile', async () => {
    const now = 1_000_000;
    const applied: string[] = [];
    const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 3));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('backup', 2),
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 5,
              exhausted: false,
            },
          }],
          ['backup', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 90,
              exhausted: false,
            },
          }],
        ]),
      }),
      commitSwitch,
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
        return { ok: true as const, mode: 'hot_apply' };
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply',
      diagnostics: {
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
    expect(applied).toEqual(['backup:2']);
  });

  it('applies an already-advanced hard usage-limit generation with quota-unknown target evidence', async () => {
    const now = 1_000_000;
    const applied: string[] = [];
    const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 3));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => state('backup', 2),
      commitSwitch,
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
        return { ok: true as const, mode: 'hot_apply' };
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
      mode: 'hot_apply',
      diagnostics: {
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
    expect(applied).toEqual(['backup:2']);
  });

  it('does not return observed_generation for an unproven already-advanced pre-turn group profile', async () => {
    const now = 1_000_000;
    const members = [
      { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
      { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
      { profileId: 'tertiary', priority: 3, createdAtMs: 3, enabled: true },
    ];
    const applied: string[] = [];
    const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => ({
      ...state(toProfileId, 3),
      members,
    }));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('backup', 2),
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
        members,
        memberStatesByProfileId: new Map([
          ['primary', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 5,
              exhausted: false,
            },
          }],
          ['tertiary', {
            quotaSnapshot: {
              capturedAtMs: now,
              effectiveRemainingPercent: 90,
              exhausted: false,
            },
          }],
        ]),
      }),
      commitSwitch,
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
        return { ok: true as const, mode: 'hot_apply' };
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'tertiary',
      generation: 3,
      mode: 'hot_apply',
      diagnostics: {
        decisionTrace: expect.objectContaining({
          activeProfileId: 'backup',
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
    expect(applied).toEqual(['tertiary:3']);
  });

  it('commits one switch while lease losers only apply the observed generation', async () => {
    let current = state('primary', 1);
    let commitCount = 0;
    const applied: string[] = [];
    const events: unknown[] = [];
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
        return { ok: true };
      },
      emitEvent: (event) => events.push(event),
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
    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        resultStatus: 'switched',
        success: true,
        toProfileId: 'backup',
      }),
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        resultStatus: 'observed_generation',
        success: true,
        toProfileId: 'backup',
      }),
    ]);
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
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
        return { ok: true };
      },
    });

    const first = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    });
    const second = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'backup',
    });

    await expect(first).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });
    await expect(second).resolves.toMatchObject({ status: 'switched', activeProfileId: 'tertiary', generation: 3 });
    expect(committed).toEqual(['1:primary->backup', '2:backup->tertiary']);
    expect(applied).toEqual(['backup:2', 'tertiary:3']);
  });

  it('lets waiting runtime-auth sessions apply a committed generation when the owner apply fails', async () => {
    let current = state('primary', 1);
    let releaseCommit!: () => void;
    let notifyCommitStarted: (() => void) | null = null;
    const commitStartedSignal = new Promise<void>((resolve) => {
      notifyCommitStarted = resolve;
    });
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const applyGeneration = vi.fn(async () => {
      if (applyGeneration.mock.calls.length === 1) {
        return {
          ok: false as const,
          errorCode: 'owner_apply_failed',
          diagnostics: { failurePhase: 'hot_apply' },
        };
      }
      return { ok: true as const };
    });
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => {
        notifyCommitStarted?.();
        await commitRelease;
        current = state(toProfileId, 2);
        return current;
      },
      applyGeneration,
    });

    const first = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    });
    await commitStartedSignal;
    const second = coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    });

    releaseCommit();

    await expect(first).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'owner_apply_failed',
      diagnostics: { failurePhase: 'hot_apply' },
    });
    await expect(second).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
    });
    expect(applyGeneration).toHaveBeenCalledTimes(2);
  });

  it('does not surface a failed switch when a proactive hot apply is temporarily unavailable', async () => {
    let current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
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
    };
    let releaseCommit!: () => void;
    let notifyCommitStarted: (() => void) | null = null;
    const commitStartedSignal = new Promise<void>((resolve) => {
      notifyCommitStarted = resolve;
    });
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const events: unknown[] = [];
    const applyGeneration = vi.fn(async () => {
      if (applyGeneration.mock.calls.length === 1) {
        return {
          ok: false as const,
          errorCode: 'hot_apply_failed',
          diagnostics: { failurePhase: 'hot_apply' },
        };
      }
      return { ok: true as const };
    });
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => {
        notifyCommitStarted?.();
        await commitRelease;
        current = state(toProfileId, 2);
        return current;
      },
      applyGeneration,
      emitEvent: (event) => events.push(event),
    });

    const first = coordinator.switchBeforeTurn({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    });
    await commitStartedSignal;
    const second = coordinator.switchBeforeTurn({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    });

    releaseCommit();

    await expect(first).resolves.toMatchObject({
      status: 'predictive_apply_unavailable',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'hot_apply_failed',
      diagnostics: { failurePhase: 'hot_apply' },
    });
    await expect(second).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      resultStatus: 'generation_apply_failed',
    }));
    expect(applyGeneration).toHaveBeenCalledTimes(2);
  });

  it('recovers observed failure recording generation conflicts by applying the winning generation', async () => {
    let loadCount = 0;
    const applied: string[] = [];
    const events: unknown[] = [];
    const recordObservedFailureState = vi.fn(async () => {
      throw new TestGenerationConflictError(2);
    });
    const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 3));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
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
      recordObservedFailureState,
      commitSwitch,
      applyGeneration: async ({ activeProfileId, generation }) => {
        applied.push(`${activeProfileId}:${generation}`);
        return { ok: true };
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
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      diagnostics: {
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
    expect(recordObservedFailureState).toHaveBeenCalledOnce();
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applied).toEqual(['backup:2']);
    expect(events).toEqual([
      expect.objectContaining({
        resultStatus: 'observed_generation',
        success: true,
        fromProfileId: 'primary',
        toProfileId: 'backup',
        fromGeneration: 1,
        toGeneration: 2,
      }),
    ]);
  });

  it('reselects after a generation conflict instead of retrying a stale target', async () => {
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
        return { ok: true };
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

  it('reselects before a turn after a generation conflict instead of retrying a stale target', async () => {
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
        return { ok: true };
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
    });
    expect(committed).toEqual(['1:primary->backup', '2:backup->tertiary']);
    expect(applied).toEqual(['tertiary:3']);
  });

  it('returns an apply failure without reporting a successful switch when the committed generation cannot apply', async () => {
    const applyResult = {
      ok: false,
      errorCode: 'partial_applied_pending_reconciliation',
      diagnostics: {
        failurePhase: 'reconciliation',
        rollback: {
          status: 'bindings_rollback_failed',
          pendingReconciliation: true,
        },
      },
    } as const;
    const events: unknown[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      loadState: async () => state('primary', 1),
      commitSwitch: async ({ toProfileId }) => state(toProfileId, 2),
      applyGeneration: async () => applyResult,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'partial_applied_pending_reconciliation',
      diagnostics: {
        failurePhase: 'reconciliation',
        rollback: {
          status: 'bindings_rollback_failed',
          pendingReconciliation: true,
        },
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
    expect(events).toEqual([
      expect.objectContaining({
        resultStatus: 'generation_apply_failed',
        success: false,
        fromProfileId: 'primary',
        toProfileId: 'backup',
        fromGeneration: 1,
        toGeneration: 2,
      }),
    ]);
  });

  it('rejects a committed switch when generation apply does not explicitly confirm success', async () => {
    const events: unknown[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      emitEvent: (event) => events.push(event),
      loadState: async () => state('primary', 1),
      commitSwitch: async ({ toProfileId }) => state(toProfileId, 2),
      applyGeneration: async () => undefined as never,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'generation_apply_not_confirmed',
      diagnostics: {
        serviceId: 'openai-codex',
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
    expect(events).toEqual([
      expect.objectContaining({
        resultStatus: 'generation_apply_failed',
        success: false,
        fromProfileId: 'primary',
        toProfileId: 'backup',
        decisionTrace: expect.objectContaining({
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
        return { ok: true };
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

  it('preflights same-account exhausted fanout before committing the group generation', async () => {
    const now = 1_000;
    const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 2));
    const applyGeneration = vi.fn(async () => ({ ok: true as const, mode: 'restart_resume' as const }));
    const preflightApplyGeneration = vi.fn(async () => ({ ok: true as const, mode: 'restart_resume' as const }));
    const current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: now,
            effectiveRemainingPercent: 0,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: now,
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
    };
    const deps = {
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch,
      applyGeneration,
      preflightApplyGeneration,
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator(deps);

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

  it('preflights lease-loser observed predictive generations before applying them to the session', async () => {
    const now = 1_000;
    let current: ConnectedServiceAuthGroupSwitchState = {
      ...state('primary', 1),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
      memberStatesByProfileId: new Map([
        ['primary', {
          quotaSnapshot: {
            capturedAtMs: now,
            effectiveRemainingPercent: 0,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: now,
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
    };
    let releaseCommit!: () => void;
    let notifyCommitStarted: (() => void) | null = null;
    const commitStartedSignal = new Promise<void>((resolve) => {
      notifyCommitStarted = resolve;
    });
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => {
      notifyCommitStarted?.();
      await commitRelease;
      current = state(toProfileId, 2);
      return current;
    });
    const applyGeneration = vi.fn(async ({ sessionId }: { sessionId?: string }) => (
      sessionId === 'owner-session'
        ? { ok: true as const, mode: 'hot_apply' as const }
        : { ok: true as const, mode: 'restart_resume' as const }
    ));
    const preflightApplyGeneration = vi.fn(async ({ sessionId }: { sessionId?: string }) => (
      sessionId === 'owner-session'
        ? { ok: true as const, mode: 'hot_apply' as const }
        : { ok: true as const, mode: 'restart_resume' as const }
    ));
    const deps = {
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch,
      applyGeneration,
      preflightApplyGeneration,
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator(deps);

    const owner = coordinator.switchBeforeTurn({
      sessionId: 'owner-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'same_provider_account_exhausted',
      observedProfileId: 'primary',
    });
    await commitStartedSignal;
    const loser = coordinator.switchBeforeTurn({
      sessionId: 'loser-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'same_provider_account_exhausted',
      observedProfileId: 'primary',
    });

    releaseCommit();

    await expect(owner).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply',
      diagnostics: {
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
    expect(applyGeneration).toHaveBeenCalledTimes(1);
    expect(applyGeneration).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'owner-session' }));
    expect(preflightApplyGeneration).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'loser-session' }));
  });
});
