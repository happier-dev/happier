import { describe, expect, it, vi } from 'vitest';
import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceAuthGroupV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { mapCommittedGenerationApplyResult } from '../accountGroups/generation/mapCommittedGenerationApplyResult';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from './createDaemonConnectedServiceAuthGroupSwitchCoordinator';
import { handleConnectedServiceRuntimeAuthFailureForSession } from './handleConnectedServiceRuntimeAuthFailureForSession';

function group(activeProfileId: string, generation: number): ConnectedServiceAuthGroupV1 {
  return {
    v: 1 as const,
    serviceId: 'openai-codex',
    groupId: 'main',
    displayName: null,
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
    activeProfileId,
    generation,
    runtimeStateRevision: 0,
    state: { v: 1 as const },
    members: [
      {
        v: 1 as const,
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'primary',
        enabled: true,
        priority: 1,
        state: { v: 1 as const },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        v: 1 as const,
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'backup',
        enabled: true,
        priority: 2,
        state: { v: 1 as const },
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

function claudeIncidentGroup(input: Readonly<{
  activeProfileId: string;
  generation: number;
  memberStateByProfileId?: Readonly<Record<string, ConnectedServiceAuthGroupV1['members'][number]['state']>>;
}>): ConnectedServiceAuthGroupV1 {
  const profileIds = [
    'batiplus_ai',
    'edison_bat',
    'lb_bat',
    'leeroy_bat',
    'leeroy_batiplus',
    'leeroy',
  ];
  return {
    v: 1,
    serviceId: 'claude-subscription',
    groupId: 'claude',
    displayName: null,
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'least_limited', autoSwitch: true },
    activeProfileId: input.activeProfileId,
    generation: input.generation,
    runtimeStateRevision: 0,
    state: { v: 1 },
    members: profileIds.map((profileId, index) => ({
      v: 1 as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'claude',
      profileId,
      enabled: true,
      priority: index + 1,
      state: input.memberStateByProfileId?.[profileId] ?? { v: 1 as const },
      createdAt: index + 1,
      updatedAt: index + 1,
    })),
    createdAt: 1,
    updatedAt: 1,
  };
}

function accountUsageSnapshot(profileId: string, remainingPct: number): ProviderAccountUsageSnapshotV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId: `acct_${profileId}`,
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: 100 - remainingPct,
      limit: 100,
      remaining: remainingPct,
      remainingPct,
      usedPct: 100 - remainingPct,
      utilizationPct: 100 - remainingPct,
      resetsAt: 10_000,
      resetAtMs: 10_000,
      unit: 'credits',
      status: 'ok',
      limitScope: 'account',
      confidence: 'exact',
      details: { limitCategory: 'usage_limit' },
    }],
  };
}

type TestCoordinatorParams =
  Omit<
    Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0],
    'resolveCurrentCredentialRevision'
  >
  & Readonly<{
    resolveCurrentCredentialRevision?: Parameters<
      typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator
    >[0]['resolveCurrentCredentialRevision'];
  }>;

function createTestDaemonConnectedServiceAuthGroupSwitchCoordinator(
  params: TestCoordinatorParams,
) {
  return createDaemonConnectedServiceAuthGroupSwitchCoordinator({
    resolveCredentialRevision: () => 'csr_testcredentialrevision',
    resolveCurrentCredentialRevision: async () => 'csr_testcredentialrevision',
    ...params,
  });
}

describe('createDaemonConnectedServiceAuthGroupSwitchCoordinator', () => {
  it('recovers an unattributed goal failure through fresh pool probes without stamping an unproven member', async () => {
    let current = group('primary', 1);
    current.policy = { ...current.policy, strategy: 'least_limited', recoveryMode: 'switch_or_wait' };
    const snapshots = new Map<string, ProviderAccountUsageSnapshotV1>();
    const updateRuntimeState = vi.fn(async () => current);
    const api = {
      getConnectedServiceAuthGroup: async () => current,
      updateConnectedServiceAuthGroupRuntimeState: updateRuntimeState,
      updateConnectedServiceAuthGroupActiveProfile: async (input: { activeProfileId: string }) => {
        current = { ...current, activeProfileId: input.activeProfileId, generation: current.generation + 1 };
        return current;
      },
    };
    const probed: string[] = [];
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api, runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      accountUsageStore: { resolveBySource: ({ profileId }) => snapshots.get(profileId) ?? null },
      quotaFreshnessMs: 60_000, nowMs: () => 1_000, restartSession: async () => {},
      probeQuotaSnapshotsForGroup: async ({ profileIds }) => {
        for (const profileId of profileIds) {
          probed.push(profileId);
          snapshots.set(profileId, accountUsageSnapshot(profileId, profileId === 'backup' ? 90 : 0));
        }
      },
    });
    const tracked = { startedBy: 'daemon' as const, happySessionId: 'goal-pool-failure', pid: 123,
      spawnOptions: { directory: '/tmp/project' } };
    const result = await handleConnectedServiceRuntimeAuthFailureForSession({
      sessionId: tracked.happySessionId, getChildren: () => [tracked], switchesThisTurn: 0,
      classification: { kind: 'usage_limit', serviceId: 'openai-codex', profileId: null, groupId: null,
        resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' },
      resolveRegisteredRuntimeAuthFailureSource: () => ({ serviceId: 'openai-codex', groupId: 'main',
        profileId: 'primary', generation: 1, credentialRevision: 'csr_testcredentialrevision' }),
      switchCoordinator: coordinator,
    });
    expect(result).toMatchObject({ status: 'switch_attempted', result: { status: 'switched', activeProfileId: 'backup' } });
    expect(probed).toContain('backup');
    expect(current.activeProfileId).toBe('backup');
    expect(updateRuntimeState).not.toHaveBeenCalled();
    expect(current.members.map(member => member.state)).toEqual([{ v: 1 }, { v: 1 }]);
  });

  it('loads group state, commits the selected member, and requests a session restart for rematerialization', async () => {
    const backupRevision = 'csr_abcdefghijklmnopqrstuv';
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      resolveCredentialRevision: () => null,
      resolveCurrentCredentialRevision: vi.fn(async (_serviceId, profileId) => (
        profileId === 'backup' ? backupRevision : null
      )),
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: backupRevision,
      providerApplication: 'applied',
    });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      expectedGeneration: 1,
      overrideRuntimeCooldown: true,
      switchReason: 'usage_limit',
    });
    expect(restartSession).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: backupRevision,
      reason: 'usage_limit',
    });
  });

  it('fails the committed generation when the canonical target credential is legacy-unfenced', async () => {
    const restartSession = vi.fn(async () => {});
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: {
        getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
        updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      },
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      resolveCredentialRevision: () => 'csr_staleprojectionrevision',
      resolveCurrentCredentialRevision: vi.fn(async () => null),
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'credential_revision_missing',
    });

    expect(restartSession).not.toHaveBeenCalled();
  });

  it('records runtime auth_failed as credential-unhealthy before selecting a fresh-quota candidate', async () => {
    let currentGroup = claudeIncidentGroup({ activeProfileId: 'batiplus_ai', generation: 205 });
    const snapshots = new Map<string, ProviderAccountUsageSnapshotV1>([
      ['leeroy_bat', accountUsageSnapshot('leeroy_bat', 78)],
      ['leeroy_batiplus', accountUsageSnapshot('leeroy_batiplus', 71)],
      ['leeroy', accountUsageSnapshot('leeroy', 0)],
    ]);
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => currentGroup),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'claude-subscription' as const,
        profiles: currentGroup.members.map((member) => ({
          profileId: member.profileId,
          status: 'connected' as const,
        })),
      })),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async (input: {
        memberStates: ReadonlyArray<Readonly<{
          profileId: string;
          state: ConnectedServiceAuthGroupV1['members'][number]['state'];
        }>>;
      }) => {
        const patch = new Map(input.memberStates.map((entry) => [entry.profileId, entry.state]));
        currentGroup = {
          ...currentGroup,
          members: currentGroup.members.map((member) => ({
            ...member,
            state: patch.get(member.profileId) ?? member.state,
          })),
        };
        return currentGroup;
      }),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async (input: {
        activeProfileId: string;
      }) => {
        currentGroup = {
          ...currentGroup,
          activeProfileId: input.activeProfileId,
          generation: currentGroup.generation + 1,
        };
        return currentGroup;
      }),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      accountUsageStore: {
        resolveBySource: (source) => snapshots.get(source.profileId) ?? null,
      },
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: vi.fn(async () => {}),
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-1',
      serviceId: 'claude-subscription',
      groupId: 'claude',
      reason: 'auth_failed',
      observedProfileId: 'leeroy_bat',
      limitCategory: 'auth_invalid',
      switchesThisTurn: 0,
    })).resolves.toEqual(expect.objectContaining({
      activeProfileId: expect.not.stringMatching(/^leeroy_bat$/),
    }));

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      memberStates: [
        expect.objectContaining({
          profileId: 'leeroy_bat',
          state: expect.objectContaining({
            credentialHealthStatus: 'needs_reauth',
          }),
        }),
      ],
    }));
    expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalledWith(expect.objectContaining({
      activeProfileId: 'leeroy_bat',
    }));
  });

  it('marks metadata-only generation updates as observed rather than provider-applied', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'metadata_updated' as const,
    }));
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      applyConnectedServiceAuthGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'spawn_next_turn',
      providerApplication: 'observed',
    });
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('surfaces the FSM-proven continuity context on the switched result for switch telemetry (INC-6)', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const continuity = {
      materializationIdentityId: 'csm_abc',
      targetMaterializedRoot: '/home/user/.happier/csm/csm_abc',
      vendorResumeId: 'resume-123',
      candidatePersistedSessionFile: '/home/user/.codex/sessions/rollout.jsonl',
      requestedStateMode: 'shared',
      effectiveStateMode: 'shared',
    };
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'metadata_updated' as const,
      diagnostics: { continuity },
    }));
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: vi.fn(async () => {}),
      applyConnectedServiceAuthGeneration,
    });

    // The proven continuity context from the session FSM must reach the coordinator result —
    // reactive switch-attempt telemetry reads `result.diagnostics.continuity`, and dropping it
    // here is what left vendorResumeId/targetMaterializedRoot/effectiveStateMode all-null in
    // the Jun-10 incident telemetry (INC-6).
    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'spawn_next_turn',
      diagnostics: { continuity },
    });
  });

  it('does not claim a restart or provider application when the FSM reports the binding unchanged (RD-SW-5)', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'unchanged' as const,
    }));
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      applyConnectedServiceAuthGeneration,
    });

    const result = await coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    });

    expect(result).toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
    });
    // An `unchanged` apply performed no restart and no provider application — the diagnostic
    // mode/providerApplication must not fabricate a `restart_resume`/`applied` transition.
    expect(result).not.toHaveProperty('mode');
    expect(result).not.toHaveProperty('providerApplication');
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('retries a transient auth-group load failure with backoff before switching', async () => {
    const getConnectedServiceAuthGroup = vi.fn<() => Promise<ConnectedServiceAuthGroupV1 | null>>()
      .mockRejectedValueOnce(new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'))
      .mockResolvedValue(group('primary', 1));
    const api = {
      getConnectedServiceAuthGroup,
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const sleepMs = vi.fn(async () => {});
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      sleepMs,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });

    // The first GET timed out (a transient local-server blip); the recovery retried with one
    // backoff rather than throwing at the first step and being swallowed as
    // recovery_handler_failed. The switch resolving (above) + exactly one backoff prove it.
    expect(sleepMs).toHaveBeenCalledTimes(1);
  });

  it('does not detach a timed-out quota probe and commit while it can still refresh the candidate', async () => {
    vi.useFakeTimers();
    try {
      const api = {
        getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
        updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      };
      let releaseProbe!: () => void;
      const probePending = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      const restartSession = vi.fn(async () => {});
      const probeQuotaSnapshotsForGroup = vi.fn(async () => {
        await probePending;
      });
      const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
        api,
        runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
        quotaFreshnessMs: 60_000,
        nowMs: () => 1_000,
        restartSession,
        probeQuotaSnapshotsForGroup,
      });

      const result = coordinator.switchAfterClassifiedFailure({
        serviceId: 'openai-codex',
        groupId: 'main',
        reason: 'usage_limit',
        switchesThisTurn: 0,
      });

      await vi.advanceTimersByTimeAsync(25);

      expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
      releaseProbe();
      await expect(result).resolves.toMatchObject({
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
      });
      expect(probeQuotaSnapshotsForGroup).toHaveBeenCalledWith({
        serviceId: 'openai-codex',
        groupId: 'main',
        profileIds: ['backup'],
        reason: 'usage_limit',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies committed generations through the shared auth primitive when a session id is present', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'hot_applied' as const,
    }));
    const params = {
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      resolveCurrentCredentialRevision: async () => 'csr_testcredentialrevision',
      restartSession,
      applyConnectedServiceAuthGeneration,
    } satisfies Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0] & Readonly<{
      applyConnectedServiceAuthGeneration: typeof applyConnectedServiceAuthGeneration;
    }>;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator(params);

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply',
    });

    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: 'csr_testcredentialrevision',
      reason: 'usage_limit',
      switchReason: 'automatic_runtime_failure',
      // Pre-switch active member, threaded so the transcript "from" is the real member, not null.
      fromProfileId: 'primary',
    });
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('forwards one exact hot-apply verification unchanged into committed-generation settlement', async () => {
    const credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const exactVerification = {
      status: 'verified' as const,
      proofStrength: 'exact' as const,
      providerAccountId: 'acct_backup',
      source: 'runtime_hot_apply',
      generationApplication: {
        serviceId: 'openai-codex' as const,
        groupId: 'main',
        profileId: 'backup',
        generation: 2,
        credentialRevision,
        credentialFingerprint: 'sha256:abcdef12',
      },
    };
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'hot_applied' as const,
      verificationByServiceId: {
        'openai-codex': exactVerification,
      },
    }));
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: {
        getConnectedServiceAuthGroup: vi.fn(async () => group('backup', 2)),
        updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      },
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: vi.fn(async () => {}),
      applyConnectedServiceAuthGeneration,
      resolveCredentialRevision: () => credentialRevision,
      resolveCurrentCredentialRevision: async () => credentialRevision,
    });
    const committedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-exact-forwarding',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'backup',
        generation: 2,
        credentialRevision,
      },
    });

    const result = await coordinator.applyCommittedGeneration({
      sessionId: 'sess_exact_forwarding',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision,
      reason: 'reconciliation',
    });

    expect(result.status).toBe('observed_generation');
    if (result.status !== 'observed_generation') {
      throw new Error(`expected observed_generation, received ${result.status}`);
    }
    expect(result.verificationByServiceId).toEqual({
      'openai-codex': exactVerification,
    });
    expect(mapCommittedGenerationApplyResult({
      committedGeneration,
      result,
    })).toMatchObject({
      reconciliationDisposition: 'converged',
      providerAdoptedTarget: {
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'backup',
        generation: 2,
        credentialRevision,
        proof: {
          status: 'verified',
          source: 'runtime_hot_apply',
          providerAccountId: 'acct_backup',
          credentialRevision,
          credentialFingerprint: 'sha256:abcdef12',
        },
      },
    });
  });

  it('threads exact revisions through application and post-fences a revision-only supersession', async () => {
    const adoptedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const authoritativeRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'hot_applied' as const,
    }));
    const params = {
      api: {
        getConnectedServiceAuthGroup: vi.fn(async () => group('backup', 2)),
        updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      },
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: vi.fn(async () => {}),
      applyConnectedServiceAuthGeneration,
      resolveCredentialRevision: (_serviceId: string, profileId: string | null) => (
        profileId === 'backup' ? authoritativeRevision : null
      ),
      resolveCurrentCredentialRevision: async () => authoritativeRevision,
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator(params);

    await expect(coordinator.applyCommittedGeneration({
      sessionId: 'sess_revision',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: adoptedRevision,
      reason: 'credential_revision_changed',
    })).resolves.toMatchObject({
      status: 'superseded_after_apply',
      generation: 2,
      credentialRevision: authoritativeRevision,
      adoptedGeneration: 2,
      adoptedCredentialRevision: adoptedRevision,
    });
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith(expect.objectContaining({
      credentialRevision: adoptedRevision,
    }));
  });

  it('does not let a stale projection author a revision-only supersession after apply', async () => {
    const adoptedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const staleProjectionRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'hot_applied' as const,
    }));
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: {
        getConnectedServiceAuthGroup: vi.fn(async () => group('backup', 2)),
        updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      },
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: vi.fn(async () => {}),
      applyConnectedServiceAuthGeneration,
      resolveCredentialRevision: () => staleProjectionRevision,
      resolveCurrentCredentialRevision: async () => adoptedRevision,
    });

    await expect(coordinator.applyCommittedGeneration({
      sessionId: 'sess_stale_projection',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: adoptedRevision,
      reason: 'credential_revision_changed',
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: adoptedRevision,
    });
  });

  it('notifies committed group switches before post-commit generation apply work', async () => {
    const events: string[] = [];
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const onCommittedSwitch = vi.fn(async () => {
      events.push('committed');
    });
    const applyConnectedServiceAuthGeneration = vi.fn(async () => {
      events.push('apply');
      expect(events).toEqual(['committed', 'apply']);
      return {
        ok: true as const,
        action: 'hot_applied' as const,
      };
    });
    const params = {
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      resolveCurrentCredentialRevision: async () => 'csr_testcredentialrevision',
      restartSession,
      applyConnectedServiceAuthGeneration,
      onCommittedSwitch,
    } satisfies Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0] & Readonly<{
      applyConnectedServiceAuthGeneration: typeof applyConnectedServiceAuthGeneration;
      onCommittedSwitch: typeof onCommittedSwitch;
    }>;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator(params);

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply',
    });

    expect(onCommittedSwitch).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      expectedGeneration: 1,
    });
  });

  it('returns typed apply failures from the shared auth primitive without collapsing to a thrown hook error', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'provider_session_state_unavailable_for_resume',
    }));
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      applyConnectedServiceAuthGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'provider_session_state_unavailable_for_resume',
    });

    expect(restartSession).not.toHaveBeenCalled();
  });

  it('emits a failed group-switch result when post-switch owner verification still observes the old profile', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('codex3', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('bot', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('codex3', 1)),
    };
    const emitEvent = vi.fn();
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'provider_account_adoption_mismatch',
      diagnostics: {
        failurePhase: 'post_switch_verification',
        retryable: true,
        verification: {
          expectedProviderAccountId: 'acct_bot',
          actualProviderAccountId: 'acct_codex3',
        },
      },
    }));
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: vi.fn(async () => {}),
      applyConnectedServiceAuthGeneration,
      emitEvent,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'generation_apply_failed',
      activeProfileId: 'bot',
      generation: 2,
      errorCode: 'provider_account_adoption_mismatch',
      diagnostics: {
        failurePhase: 'post_switch_verification',
        retryable: true,
        verification: {
          expectedProviderAccountId: 'acct_bot',
          actualProviderAccountId: 'acct_codex3',
        },
      },
    });

    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      resultStatus: 'generation_apply_failed',
      success: false,
      toProfileId: 'bot',
    }));
  });

  it('uses persisted member runtime state from the auth-group API before selecting a candidate', async () => {
    const initial = group('primary', 1);
    const groupWithPersistedCooldown: ConnectedServiceAuthGroupV1 = {
      ...initial,
      members: [
        initial.members[0]!,
        {
          ...initial.members[1]!,
          state: {
            v: 1,
            cooldownUntilMs: 5_000,
          },
        },
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'tertiary',
          enabled: true,
          priority: 3,
          state: { v: 1 },
          createdAt: 3,
          updatedAt: 3,
        },
      ],
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => groupWithPersistedCooldown),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => groupWithPersistedCooldown),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
        ...groupWithPersistedCooldown,
        activeProfileId,
        generation: 2,
      })),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'tertiary' });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      activeProfileId: 'tertiary',
    }));
  });

  it('uses persisted quota exhaustion from the auth-group API after daemon restart', async () => {
    const initial = group('primary', 1);
    const groupWithPersistedExhaustion: ConnectedServiceAuthGroupV1 = {
      ...initial,
      members: [
        initial.members[0]!,
        {
          ...initial.members[1]!,
          state: {
            v: 1,
            quotaExhaustedUntilMs: 5_000,
          },
        },
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'tertiary',
          enabled: true,
          priority: 3,
          state: { v: 1 },
          createdAt: 3,
          updatedAt: 3,
        },
      ],
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => groupWithPersistedExhaustion),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => groupWithPersistedExhaustion),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
        ...groupWithPersistedExhaustion,
        activeProfileId,
        generation: 2,
      })),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'tertiary' });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      activeProfileId: 'tertiary',
    }));
  });

  it('does not use runtime quota snapshots to clear persisted target limiter state without source-backed account usage', async () => {
    const initial = group('primary', 1);
    const groupWithStaleBackupLimiter: ConnectedServiceAuthGroupV1 = {
      ...initial,
      members: [
        initial.members[0]!,
        {
          ...initial.members[1]!,
          state: {
            v: 1,
            quotaExhaustedUntilMs: 20_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: 900,
          },
        },
      ],
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
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
          utilizationPct: 30,
          remainingPct: 70,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => groupWithStaleBackupLimiter),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => groupWithStaleBackupLimiter),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({
        activeProfileId,
        overrideRuntimeCooldown,
      }: {
        activeProfileId: string;
        overrideRuntimeCooldown?: boolean;
      }) => {
        if (overrideRuntimeCooldown !== true) {
          throw new Error('expected automated runtime-cooldown override');
        }
        return {
          ...groupWithStaleBackupLimiter,
          activeProfileId,
          generation: 2,
        };
      }),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({ status: 'no_eligible_member' });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
  });

  it('does not use persisted quota snapshots for group members before pre-turn selection', async () => {
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
        ...group(activeProfileId, 2),
        activeProfileId,
        generation: 2,
      })),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await expect(coordinator.switchBeforeTurn({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({ status: 'observed_generation', activeProfileId: 'primary' });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
  });

  it('drives pre-turn soft switching from source-backed provider account usage without runtime quota snapshots', async () => {
    const primary = accountUsageSnapshot('primary', 0);
    const backup = accountUsageSnapshot('backup', 90);
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
        ...group(activeProfileId, 2),
        activeProfileId,
        generation: 2,
      })),
    };
    const accountUsageStore = {
      resolveBySource: vi.fn((source: { profileId: string; groupGeneration?: number }) => {
        if (source.groupGeneration !== 1) return null;
        if (source.profileId === 'primary') return primary;
        if (source.profileId === 'backup') return backup;
        return null;
      }),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      accountUsageStore,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    } as TestCoordinatorParams & Readonly<{
      accountUsageStore: typeof accountUsageStore;
    }>);

    await expect(coordinator.switchBeforeTurn({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup' });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      activeProfileId: 'backup',
      expectedGeneration: 1,
    }));
  });

  it('preflights a session-scoped soft switch before CAS without requiring an exact revision', async () => {
    const primary = accountUsageSnapshot('primary', 0);
    const backup = accountUsageSnapshot('backup', 90);
    let currentGroup = group('primary', 1);
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => currentGroup),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => currentGroup),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => {
        currentGroup = group(activeProfileId, 2);
        return currentGroup;
      }),
    };
    const preflightConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'hot_applied' as const,
    }));
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'hot_applied' as const,
    }));
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      accountUsageStore: {
        resolveBySource: vi.fn((source: { profileId: string; groupGeneration?: number }) => {
          if (source.groupGeneration !== 1) return null;
          if (source.profileId === 'primary') return primary;
          if (source.profileId === 'backup') return backup;
          return null;
        }),
      },
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: vi.fn(async () => {}),
      preflightConnectedServiceAuthGeneration,
      applyConnectedServiceAuthGeneration,
      resolveCredentialRevision: (_serviceId, profileId) => (
        profileId === 'backup' ? 'csr_bbbbbbbbbbbbbbbbbbbbbb' : 'csr_aaaaaaaaaaaaaaaaaaaaaa'
      ),
      resolveCurrentCredentialRevision: async () => 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    });

    await expect(coordinator.switchBeforeTurn({
      sessionId: 'sess_soft_preflight',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      mode: 'hot_apply',
    });

    expect(preflightConnectedServiceAuthGeneration).toHaveBeenCalledWith(expect.not.objectContaining({
      credentialRevision: expect.anything(),
    }));
    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledOnce();
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith(expect.objectContaining({
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    }));
  });

  it('treats an existing empty account-usage store as authoritative for pre-turn evidence', async () => {
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
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
          utilizationPct: 100,
          remainingPct: 0,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    });
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
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
          utilizationPct: 10,
          remainingPct: 90,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
        ...group(activeProfileId, 2),
        activeProfileId,
        generation: 2,
      })),
    };
    const accountUsageStore = {
      resolveBySource: vi.fn(() => null),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      accountUsageStore,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    } as TestCoordinatorParams & Readonly<{
      accountUsageStore: typeof accountUsageStore;
    }>);

    await expect(coordinator.switchBeforeTurn({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({ status: 'observed_generation', activeProfileId: 'primary' });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
  });

  it('persists observed quota failure state before relying on selector state', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAfterMs: 5_000,
      planType: 'team',
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      expectedGeneration: 1,
      expectedRuntimeStateRevision: 0,
      memberStates: [{
        profileId: 'primary',
          state: expect.objectContaining({
          quotaExhaustedUntilMs: 6_000,
          lastFailureKind: 'usage_limit',
          lastObservedPlanType: 'team',
          lastObservedAtMs: 1_000,
        }),
      }],
    });
  });

  it('persists generic plan-incompatible permission failures with a 24-hour cooldown', async () => {
    const loadedGroup = {
      ...group('primary', 1),
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        cooldownMs: 45_000,
      },
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => loadedGroup),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => loadedGroup),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'permission_denied',
      limitCategory: 'plan_invalid',
      observedProfileId: 'primary',
      planType: null,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          lastFailureKind: 'permission_denied',
          lastObservedAtMs: 1_000,
          planUnavailableUntilMs: 86_401_000,
        }),
      }],
    }));
  });

  it('persistently disables a model-incompatible member when the pool opts in', async () => {
    const loadedGroup = {
      ...group('primary', 1),
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        autoSwitch: true,
        autoDisablePlanInvalidAccounts: true,
      },
    };
    const disabledGroup = {
      ...loadedGroup,
      activeProfileId: 'backup',
      generation: 2,
      members: loadedGroup.members.map((member) => member.profileId === 'primary'
        ? { ...member, enabled: false, state: { ...member.state, autoDisabledReason: 'model_not_entitled' as const } }
        : member),
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn()
        .mockResolvedValueOnce(loadedGroup)
        .mockResolvedValue(disabledGroup),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => loadedGroup),
      updateConnectedServiceAuthGroupMember: vi.fn(async () => disabledGroup),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => disabledGroup),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'plan',
      limitCategory: 'plan_invalid',
      quotaScope: 'model',
      providerLimitId: 'gpt-5.6-sol',
      observedProfileId: 'primary',
      planType: null,
    });

    expect(api.updateConnectedServiceAuthGroupMember).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      enabled: false,
      expectedGeneration: 1,
      expectedRuntimeStateRevision: 0,
      state: expect.objectContaining({
        autoDisabledReason: 'model_not_entitled',
        lastFailureCode: 'model_not_entitled',
        modelUnavailableUntilMsByModelId: { 'gpt-5.6-sol': 86_401_000 },
      }),
    });
    expect(api.updateConnectedServiceAuthGroupRuntimeState).not.toHaveBeenCalled();
  });

  it('records only short herd-backoff evidence when usage-limit provider timing is missing', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        ...group('primary', 1),
        policy: {
          ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
          autoSwitch: true,
          cooldownMs: 45_000,
        },
      })),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      planType: null,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.not.objectContaining({
          quotaExhaustedUntilMs: expect.any(Number),
        }),
      }],
    }));
    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 1_000,
        }),
      }],
    }));
  });

  it('records only short herd-backoff evidence for rate-limit and capacity failures without provider timing', async () => {
    const loadedGroup = {
      ...group('primary', 1),
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        autoSwitch: true,
        cooldownMs: 45_000,
      },
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => loadedGroup),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => loadedGroup),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'rate_limit',
      observedProfileId: 'primary',
      planType: null,
    });
    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'capacity',
      observedProfileId: 'primary',
      planType: null,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(1, expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.not.objectContaining({
          rateLimitedUntilMs: expect.any(Number),
        }),
      }],
    }));
    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(2, expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.not.objectContaining({
          capacityLimitedUntilMs: expect.any(Number),
        }),
      }],
    }));
    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(1, expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          lastFailureKind: 'rate_limit',
          lastObservedAtMs: 1_000,
        }),
      }],
    }));
    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(2, expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          lastFailureKind: 'capacity',
          lastObservedAtMs: 1_000,
        }),
      }],
    }));
  });

  it('does not switch away from disabled accounts through raw auth policy', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'account_disabled',
      observedProfileId: 'primary',
      retryAfterMs: 5_000,
    })).resolves.toMatchObject({ status: 'switch_reason_disabled', generation: 1 });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
  });

  it('does not switch away from spawn-confirmed unusable credentials through auth policy', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'credential_unusable',
      observedProfileId: 'primary',
      retryAfterMs: 5_000,
    })).resolves.toMatchObject({ status: 'switch_reason_disabled', generation: 1 });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
  });

  it('treats API generation conflicts as observed cross-daemon switches', async () => {
    let loadCount = 0;
    const restartSession = vi.fn(async () => {});
    const generationConflict = Object.assign(
      new Error('connected_service_auth_group_generation_conflict'),
      { generation: 2 },
    );
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [{
          meterId: 'daily',
          label: 'Daily',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 20,
          remainingPct: 80,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => {
        loadCount += 1;
        return loadCount <= 2 ? group('primary', 1) : group('backup', 2);
      }),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => {
        throw generationConflict;
      }),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'restart_resume',
      providerApplication: 'applied',
    });
    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledTimes(1);
    expect(restartSession).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      credentialRevision: 'csr_testcredentialrevision',
      reason: 'usage_limit',
    });
  });

  it('retries observed-failure runtime-state patches after generation conflicts before selecting a candidate', async () => {
    let loadCount = 0;
    const generationConflict = Object.assign(
      new Error('connected_service_auth_group_generation_conflict'),
      { generation: 2 },
    );
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => {
        loadCount += 1;
        return loadCount === 1 ? group('primary', 1) : group('primary', 2);
      }),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async ({ expectedGeneration }: { expectedGeneration?: number }) => {
        if (expectedGeneration === 1) {
          throw generationConflict;
        }
        return group('primary', 2);
      }),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId, expectedGeneration }: { activeProfileId: string; expectedGeneration?: number }) => ({
        ...group(activeProfileId, 3),
        generation: expectedGeneration === 2 ? 3 : 999,
      })),
    };
    const restartSession = vi.fn(async () => {});
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
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
      mode: 'restart_resume',
      providerApplication: 'applied',
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledTimes(2);
    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(1, expect.objectContaining({
      expectedGeneration: 1,
    }));
    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedGeneration: 2,
    }));
    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      activeProfileId: 'backup',
      expectedGeneration: 2,
    }));
    expect(restartSession).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 3,
      credentialRevision: 'csr_testcredentialrevision',
      reason: 'usage_limit',
    });
  });

  it('persists disabled account failures as auth blockers', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'account_disabled',
      observedProfileId: 'primary',
      retryAfterMs: 5_000,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          authInvalidUntilMs: 6_000,
          lastFailureKind: 'account_disabled',
          lastObservedAtMs: 1_000,
        }),
      }],
    }));
  });

  it('persists auth-expired failures without provider retry metadata as bounded auth blockers', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'auth_expired',
      observedProfileId: 'primary',
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          authInvalidUntilMs: 31_000,
          lastFailureKind: 'auth_expired',
          lastObservedAtMs: 1_000,
        }),
      }],
    }));
  });

  it('forwards structured switch events from the daemon factory', async () => {
    const events: unknown[] = [];
    const coordinator = createTestDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: {
        getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
        updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
        updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      },
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
      emitEvent: (event) => events.push(event),
    });

    await coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        success: true,
      }),
    ]);
  });
});
