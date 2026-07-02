import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
  type ConnectedServiceAuthGroupSwitchState,
} from './ConnectedServiceAuthGroupSwitchCoordinator';

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

class TestGenerationConflictError extends Error {
  constructor(readonly generation: number) {
    super('connected_service_auth_group_generation_conflict');
  }
}

describe('ConnectedServiceAuthGroupSwitchCoordinator', () => {
  it('expires lease losers instead of waiting forever for an abandoned owner', async () => {
    vi.useFakeTimers();
    try {
      const leases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry({ leaseTimeoutMs: 10 });
      const owner = leases.acquire({ serviceId: 'openai-codex', groupId: 'main' });
      expect(owner.kind).toBe('owner');
      const loser = leases.acquire({ serviceId: 'openai-codex', groupId: 'main' });
      expect(loser.kind).toBe('loser');
      const wait = loser.kind === 'loser' ? loser.waitForOwner() : Promise.resolve({ activeProfileId: null, generation: 0, serviceId: '', groupId: '' });
      const assertion = expect(wait).rejects.toThrow('connected_service_auth_group_switch_lease_expired');

      await vi.advanceTimersByTimeAsync(10);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not switch when automatic switching is disabled by group policy', async () => {
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
    })).resolves.toEqual({ status: 'auto_switch_disabled', generation: 1 });
    expect(didCommit).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        resultStatus: 'auto_switch_disabled',
        success: false,
        fromProfileId: 'primary',
        toProfileId: 'primary',
      }),
    ]);
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
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
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
      excluded: [],
    });
    expect(recordObservedFailureState).toHaveBeenCalledOnce();
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).not.toHaveBeenCalled();
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

    await expect(first).resolves.toEqual({ status: 'auto_switch_disabled', generation: 1 });
    await expect(second).resolves.toEqual({ status: 'auto_switch_disabled', generation: 1 });
    expect(applied).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        resultStatus: 'auto_switch_disabled',
        success: false,
        fromProfileId: 'primary',
        toProfileId: 'primary',
      }),
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        resultStatus: 'auto_switch_disabled',
        success: false,
        fromProfileId: 'primary',
        toProfileId: 'primary',
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
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });

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
    const commitSwitch = vi.fn(async ({ toProfileId }: { toProfileId: string }) => state(toProfileId, 3));
    const applyGeneration = vi.fn(async () => ({ ok: true as const }));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => ({
        ...state('backup', 2),
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
    })).resolves.toEqual({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
    });

    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
    });
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
    })).resolves.toEqual({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'restart_resume',
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
    })).resolves.toEqual({
      status: 'switched',
      activeProfileId: 'tertiary',
      generation: 3,
      mode: 'restart_resume',
    });

    expect(committed).toEqual(['backup->tertiary']);
    expect(applied).toEqual(['tertiary:3']);
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
        return { ok: true as const, mode: 'restart_resume' };
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
      observedProfileId: 'primary',
    })).resolves.toEqual({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'restart_resume',
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
        return { ok: true as const, mode: 'restart_resume' };
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
      observedProfileId: 'primary',
    })).resolves.toEqual({
      status: 'switched',
      activeProfileId: 'tertiary',
      generation: 3,
      mode: 'restart_resume',
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

  it('lets waiting proactive sessions apply a committed generation when the owner apply fails', async () => {
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
    })).resolves.toEqual({ status: 'observed_generation', activeProfileId: 'backup', generation: 2 });
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
    })).resolves.toEqual({
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
    })).resolves.toEqual({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'generation_apply_not_confirmed',
      diagnostics: {
        serviceId: 'openai-codex',
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        resultStatus: 'generation_apply_failed',
        success: false,
        fromProfileId: 'primary',
        toProfileId: 'backup',
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
});
