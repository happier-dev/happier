import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectedServiceAuthGroupV1,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator } from './createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator';

function quotaSnapshot(profileId: string, remainingPct: number): ConnectedServiceQuotaSnapshotV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    profileId,
    fetchedAt: 1_000,
    staleAfterMs: 60_000,
    planLabel: null,
    accountLabel: null,
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: null,
      limit: null,
      unit: 'unknown',
      utilizationPct: 100 - remainingPct,
      remainingPct,
      resetsAt: null,
      status: 'ok',
      details: {},
    }],
  };
}

function group(activeProfileId: string, generation: number): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    groupId: 'main',
    displayName: null,
    policy: {
      ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      autoSwitch: true,
      softSwitchRemainingPercent: 15,
      preTurnProbeMode: 'when_stale',
      preTurnProbeOrder: 'current_first_then_candidates',
    },
    activeProfileId,
    generation,
    runtimeStateRevision: 0,
    state: { v: 1 },
    members: [
      {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'primary',
        enabled: true,
        priority: 1,
        state: { v: 1 },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'backup',
        enabled: true,
        priority: 2,
        state: { v: 1 },
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

function completeQuotaProbe(profileIds: ReadonlyArray<string> = []) {
  return {
    status: 'complete' as const,
    requestedProfileCount: profileIds.length,
    completedProfileCount: profileIds.length,
    completedProfileIds: [...profileIds],
  };
}

describe('createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator', () => {
  it('preserves an explicit runtime-failure switch reason for recipient-only committed-generation apply', async () => {
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
    };
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'hot_applied' as const,
    }));
    const coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      resolveCurrentCredentialRevision: async () => 'csr_testcredentialrevision',
      restartSession: vi.fn(async () => {}),
      applyConnectedServiceAuthGeneration,
      switchReasonForApplyGeneration: 'automatic_runtime_failure',
      quotaCoordinator: {
        probeGroupQuotaSnapshots: vi.fn(async (input) => completeQuotaProbe(input.profileIds)),
      },
    });

    await expect(coordinator.applyCommittedGeneration({
      sessionId: 'sibling-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: 'csr_testcredentialrevision',
      reason: 'same_provider_account_exhausted',
      fromProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
    });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({
      sessionId: 'sibling-session',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: 'csr_testcredentialrevision',
      reason: 'same_provider_account_exhausted',
      switchReason: 'automatic_runtime_failure',
      fromProfileId: 'primary',
    });
  });

  it('fails closed without restarting when proactive soft-threshold switching has no hot-apply path', async () => {
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      snapshot: quotaSnapshot('primary', 5),
    });

    const probeGroupQuotaSnapshots = vi.fn(async (input: Readonly<{ profileIds: ReadonlyArray<string> }>) => {
      runtimeQuotaSnapshots.recordSnapshot({
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'backup',
        snapshot: quotaSnapshot('backup', 80),
      });
      return completeQuotaProbe(input.profileIds);
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const restartSession = vi.fn(async () => {});

    const coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      resolveCurrentCredentialRevision: async () => 'csr_testcredentialrevision',
      restartSession,
      quotaCoordinator: {
        probeGroupQuotaSnapshots,
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'hot_apply_restart_required',
    });
    expect(probeGroupQuotaSnapshots).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileIds: ['backup'],
      reason: 'soft_threshold',
    });
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('routes the proactive switch through applyConnectedServiceAuthGeneration and hot-applies without a bare restart (K2)', async () => {
    // K2 (cmpn4hhdi regression): the proactive quota switch must reach the FSM
    // hot-apply/gated path, NOT a bare respawn. When an applyConnectedServiceAuthGeneration
    // hook is wired and reports a hot-apply, the coordinator must surface mode:'hot_apply'
    // and must NOT call the bare restartSession.
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      snapshot: quotaSnapshot('primary', 5),
    });
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      snapshot: quotaSnapshot('backup', 80),
    });

    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'hot_applied' as const,
    }));

    const coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      resolveCurrentCredentialRevision: async () => 'csr_testcredentialrevision',
      restartSession,
      applyConnectedServiceAuthGeneration,
      quotaCoordinator: {
        probeGroupQuotaSnapshots: vi.fn(async (input) => completeQuotaProbe(input.profileIds)),
      },
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
      mode: 'hot_apply',
    });

    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: 'csr_testcredentialrevision',
      reason: 'soft_threshold',
      switchReason: 'pre_turn_group_policy',
      // Pre-switch active member, threaded so the transcript "from" is the real member, not null.
      fromProfileId: 'primary',
    });
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('fails closed without restarting when proactive soft-threshold switching only produces metadata updates', async () => {
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      snapshot: quotaSnapshot('primary', 5),
    });
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      snapshot: quotaSnapshot('backup', 80),
    });

    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'metadata_updated' as const,
    }));

    const coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      resolveCurrentCredentialRevision: async () => 'csr_testcredentialrevision',
      restartSession,
      applyConnectedServiceAuthGeneration,
      quotaCoordinator: {
        probeGroupQuotaSnapshots: vi.fn(async (input) => completeQuotaProbe(input.profileIds)),
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'hot_apply_restart_required',
      diagnostics: {
        attemptedMode: 'spawn_next_turn',
        policyReason: 'predictive_soft_switch_hot_apply_required',
      },
    });

    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: 'csr_testcredentialrevision',
      reason: 'soft_threshold',
      switchReason: 'pre_turn_group_policy',
      fromProfileId: 'primary',
    });
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('surfaces a fail-closed generation_apply_failed when the proactive switch cannot resume (K2)', async () => {
    // K2 fail-closed: if the apply path reports the target is unresumable, the
    // coordinator surfaces the structured failure (no infinite loop, no bare respawn).
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      snapshot: quotaSnapshot('primary', 5),
    });
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      snapshot: quotaSnapshot('backup', 80),
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'provider_session_state_unavailable_for_resume',
    }));

    const coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      resolveCurrentCredentialRevision: async () => 'csr_testcredentialrevision',
      restartSession,
      applyConnectedServiceAuthGeneration,
      quotaCoordinator: {
        probeGroupQuotaSnapshots: vi.fn(async (input) => completeQuotaProbe(input.profileIds)),
      },
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'provider_session_state_unavailable_for_resume',
    });
    expect(restartSession).not.toHaveBeenCalled();
  });
});
