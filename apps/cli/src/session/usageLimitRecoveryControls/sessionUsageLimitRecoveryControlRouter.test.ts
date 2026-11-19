import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';
import { buildTestCodexRuntimeDescriptorV1 as buildCodexAgentRuntimeDescriptor } from '@/testkit/runtimeDescriptorFixtures';
import { createBackoffSessionUsageLimitRecoveryControlAdapter } from './createBackoffSessionUsageLimitRecoveryControlAdapter';

const stageUsageLimitRecoveryMutation = vi.fn(async () => undefined);

const mocks = vi.hoisted(() => ({
  fetchAccountMachineReplacements: vi.fn(),
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

import {
  routeSessionUsageLimitRecoveryCheckNow,
  routeSessionUsageLimitRecoveryWaitResumeCancel,
  routeSessionUsageLimitRecoveryWaitResumeEnable,
} from './sessionUsageLimitRecoveryControlRouter';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(9),
    },
  };
}

function createRawSession(overrides: Partial<RawSessionRecord> = {}): RawSessionRecord {
  return {
    id: 'sess_1',
    active: false,
    path: '/repo',
    machineId: 'machine-local',
    metadata: '{}',
    metadataVersion: 1,
    encryptionMode: 'plain',
    ...overrides,
  } as RawSessionRecord;
}

function createMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    machineId: 'machine-local',
    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
      backendMode: 'appServer',
      providerSessionId: 'thread-1',
    }),
    ...overrides,
  };
}

function createUsageLimitIssue(overrides: Partial<{
  resetAtMs: number | null;
  retryAfterMs: number | null;
}> = {}) {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    provider: 'codex',
    agentTurnId: 'turn-1',
    occurredAt: 1_700_000_000_000,
    usageLimit: {
      v: 1,
      resetAtMs: overrides.resetAtMs === undefined ? 1_700_000_060_000 : overrides.resetAtMs,
      retryAfterMs: overrides.retryAfterMs === undefined ? null : overrides.retryAfterMs,
      quotaScope: 'account',
      recoverability: 'wait',
    },
  } as const;
}

function createTemporaryThrottleIssue() {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'provider_temporary_throttle',
    source: 'agent_status_error',
    provider: 'codex',
    agentTurnId: 'turn-throttle',
    occurredAt: 1_700_000_000_000,
    sanitizedPreview: 'Provider is temporarily limiting requests',
    temporaryThrottle: {
      v: 1,
      retryAfterMs: 30_000,
      recoverability: 'retry',
    },
  } as const;
}

describe('sessionUsageLimitRecoveryControlRouter', () => {
  it('probes a due inactive wait and clears old timing when the blocking reset is now unknown', async () => {
    const issue = createUsageLimitIssue();
    const providerProbe = vi.fn(async () => ({ status: 'waiting' as const }));
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const adapter = createBackoffSessionUsageLimitRecoveryControlAdapter({
      providerId: 'codex', readinessProbe: providerProbe,
    });
    const params = {
      token: 'token', credentials: createCredentials(), sessionId: 'sess_local_timing',
      rawSession: createRawSession({ id: 'sess_local_timing', latestTurnStatus: 'failed', lastRuntimeIssue: issue }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: {
        v: 1, status: 'waiting', resumePromptMode: 'off',
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
        armedAtMs: issue.occurredAt, resetAtMs: issue.usageLimit.resetAtMs,
        nextCheckAtMs: issue.usageLimit.resetAtMs, attemptCount: 0, maxAttempts: 3,
        lastProbeError: null, selectedAuth: { kind: 'native' },
      } }),
      currentMachineId: 'machine-local', ctx: null, mode: 'plain' as const,
      stageUsageLimitRecoveryMutation, request: { sessionId: 'sess_local_timing' },
      callLiveSessionRpc: async () => undefined,
      resolveAdapter: async () => adapter,
      resumeInactiveSessionWhenReady,
    };
    await expect(routeSessionUsageLimitRecoveryCheckNow(params)).resolves.toMatchObject({
      ok: true, status: 'waiting',
      metadata: { sessionUsageLimitRecoveryV1: { resetAtMs: null, nextCheckAtMs: null } },
    });
    expect(providerProbe).toHaveBeenCalledOnce();
    expect(resumeInactiveSessionWhenReady).not.toHaveBeenCalled();
  });

  it.each([
    [{ meterId: 'weekly', remainingPct: 0, resetAtMs: 1_700_000_120_000 }, 1_700_000_120_000],
    [{ meterId: 'weekly', remainingPct: 0 }, null],
    [{ meterId: 'weekly', remainingPct: 40, resetAtMs: 1_700_000_120_000 }, 1_700_000_060_000],
  ])('arms a Claude wait from the current windows and scalar reset (%j)', async (window, expected) => {
    const { provider: _legacyProvider, ...base } = createUsageLimitIssue({ retryAfterMs: 1_000 });
    const issue = {
      ...base, agentId: 'claude',
      usageLimit: { ...base.usageLimit, allWindows: [window] },
    };
    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token', credentials: createCredentials(), sessionId: 'sess_1',
      rawSession: createRawSession({ latestTurnStatus: 'failed', lastRuntimeIssue: issue }),
      metadata: createMetadata(), currentMachineId: 'machine-local', ctx: null, mode: 'plain',
      stageUsageLimitRecoveryMutation, request: { sessionId: 'sess_1' },
      callLiveSessionRpc: async () => undefined,
    });
    expect(result).toMatchObject({
      ok: true, metadata: { sessionUsageLimitRecoveryV1: { resetAtMs: expected, nextCheckAtMs: expected } },
    });
  });

  it.each(['enable', 'cancel'] as const)('keeps an uncertain live %s effect with its live owner', async operation => {
    const issue = createUsageLimitIssue();
    const intent = {
      v: 1, status: 'waiting', resumePromptMode: 'standard',
      issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
      armedAtMs: issue.occurredAt, resetAtMs: issue.usageLimit.resetAtMs,
      nextCheckAtMs: issue.usageLimit.resetAtMs, attemptCount: 0, maxAttempts: 3,
      lastProbeError: null, selectedAuth: { kind: 'native' },
    } as const;
    let liveEffects = 0;
    const params = {
      token: 'token', credentials: createCredentials(), sessionId: 'sess_live_uncertain',
      rawSession: createRawSession({ id: 'sess_live_uncertain', active: true,
        latestTurnStatus: 'failed', lastRuntimeIssue: issue }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: intent }),
      currentMachineId: 'machine-local', ctx: null, mode: 'plain' as const,
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_live_uncertain', issueFingerprint: intent.issueFingerprint,
        armedAtMs: intent.armedAtMs },
      // The live transport loses its response after the runtime commits the effect.
      callLiveSessionRpc: async () => {
        liveEffects++;
        return { ok: false, errorCode: 'session_rpc_failed' };
      },
    };
    const result = operation === 'enable'
      ? await routeSessionUsageLimitRecoveryWaitResumeEnable(params)
      : await routeSessionUsageLimitRecoveryWaitResumeCancel(params);
    expect(result).toMatchObject({ ok: false, errorCode: 'session_rpc_failed' });
    expect(liveEffects).toBe(1);
    expect(stageUsageLimitRecoveryMutation).not.toHaveBeenCalled();
  });

  it('checks the current issue through its real adapter instead of an unrelated old runtime attempt', async () => {
    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token', credentials: createCredentials(), sessionId: 'sess_issue_after_old_attempt',
      rawSession: createRawSession({ id: 'sess_issue_after_old_attempt', latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue({ resetAtMs: 1_700_000_160_000 }),
      }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: {
        v: 1, status: 'cancelled', issueFingerprint: 'old-attempt', runtimeAuthRecoveryAttemptId: 'old-attempt',
        armedAtMs: 1_000, resetAtMs: 2_000, nextCheckAtMs: null, attemptCount: 0, maxAttempts: 5,
        lastProbeError: null, selectedAuth: { kind: 'native' },
      } }),
      currentMachineId: 'machine-local', ctx: null, mode: 'plain', stageUsageLimitRecoveryMutation,
      callLiveSessionRpc: async () => undefined,
      resolveAdapter: async () => createBackoffSessionUsageLimitRecoveryControlAdapter({
        providerId: 'codex', nowMs: () => 1_700_000_120_000,
      }),
    });
    expect(result).toMatchObject({ ok: true, status: 'waiting' });
    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
      op: { kind: 'set', value: expect.objectContaining({
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000160000',
        resetAtMs: 1_700_000_160_000,
      }) },
    }));
  });

  beforeEach(() => {
    stageUsageLimitRecoveryMutation.mockClear();
    mocks.fetchAccountMachineReplacements.mockReset();
    // The Account genuinely knows both machines and neither replaced the other,
    // so a refusal below is the guard deciding, not an empty chain.
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-local' },
      { id: 'machine-before-restart' },
      { id: 'machine-after-restart' },
    ]);
  });

  it.each([true, false])('keeps daemon-owned check-now in exact daemon custody when active=%s', async (active) => {
    // The callback is the daemon transport boundary, not a provider recovery owner.
    const checkRuntimeAuthUsageLimitRecovery = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    const callLiveSessionRpc = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token', credentials: createCredentials(), sessionId: `sess_daemon_check_${active}`,
      rawSession: createRawSession({ id: `sess_daemon_check_${active}`, active }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: {
        v: 1, status: 'waiting', resumePromptMode: 'standard',
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
        armedAtMs: 1_700_000_000_000, resetAtMs: 1_700_000_060_000,
        nextCheckAtMs: 1_700_000_060_000, attemptCount: 1, maxAttempts: 3,
        lastProbeError: null, selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:manual-exact',
      } }),
      currentMachineId: 'machine-local', ctx: null, mode: 'plain',
      stageUsageLimitRecoveryMutation, callLiveSessionRpc,
      checkRuntimeAuthUsageLimitRecovery,
      request: { sessionId: `sess_daemon_check_${active}`, resumePromptMode: 'off' },
    });
    expect(result).toMatchObject({ ok: true, status: 'waiting' });
    expect(checkRuntimeAuthUsageLimitRecovery).toHaveBeenCalledWith({
      sessionId: `sess_daemon_check_${active}`, attemptId: 'runtime-auth-attempt:manual-exact', resumePromptMode: 'off',
    });
    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(stageUsageLimitRecoveryMutation).not.toHaveBeenCalled();
  });

  it('arms inactive local wait-resume from the latest usage-limit issue without live session RPC', async () => {
    const callLiveSessionRpc = vi.fn();

    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue(),
      }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_1', remember: true, resumePromptMode: 'off' },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(Object.keys(result as Record<string, unknown>)).not.toContain('metadata');
    expect((result as Record<string, unknown>).metadata).toMatchObject({
      machineId: 'machine-local',
      sessionUsageLimitRecoveryV1: {
        status: 'waiting',
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
        resetAtMs: 1_700_000_060_000,
        nextCheckAtMs: 1_700_000_060_000,
        selectedAuth: { kind: 'native' },
        resumePromptMode: 'off',
      },
    });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledTimes(1);
  });

  it('arms predecessor native quota-source issues as native using qualified session binding evidence', async () => {
    const issue = createUsageLimitIssue();
    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token', credentials: createCredentials(), sessionId: 'sess_1',
      rawSession: createRawSession({ latestTurnStatus: 'failed', lastRuntimeIssue: {
        ...issue, usageLimit: { ...issue.usageLimit, connectedService: {
          serviceId: 'claude-subscription', profileId: `native:${'a'.repeat(48)}`, groupId: null,
        } },
      } }),
      metadata: { ...createMetadata(), connectedServices: { v: 2, bindingsByServiceId: {
        'happier.agent.claude/claude-subscription': { source: 'native' },
      } } },
      currentMachineId: 'machine-local', ctx: null, mode: 'plain', stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_1' }, callLiveSessionRpc: vi.fn(), resolveAdapter: vi.fn(),
    });
    expect(result).toMatchObject({ ok: true });
    expect((result as Record<string, unknown>).metadata).toMatchObject({ sessionUsageLimitRecoveryV1: {
      selectedAuth: { kind: 'native', serviceId: 'happier.agent.claude/claude-subscription' },
    } });
  });

  it('starts a fresh epoch when explicitly re-arming a terminal intent for the same issue', async () => {
    const cancelled = {
      v: 1,
      status: 'cancelled',
      issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
      armedAtMs: 1_700_000_000_000,
      resetAtMs: 1_700_000_060_000,
      nextCheckAtMs: 1_700_000_060_000,
      attemptCount: 2,
      maxAttempts: 3,
      lastProbeError: 'cancelled',
      resumePromptMode: 'standard',
      selectedAuth: { kind: 'native' },
    };
    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue(),
      }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: cancelled }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    const persisted = (result as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(persisted.sessionUsageLimitRecoveryV1).toMatchObject({
      status: 'waiting',
      issueFingerprint: cancelled.issueFingerprint,
      attemptCount: 0,
    });
    expect((persisted.sessionUsageLimitRecoveryV1 as { armedAtMs: number }).armedAtMs)
      .toBeGreaterThan(cancelled.armedAtMs);
  });

  it('routes temporary-throttle retry-now to the daemon-lifetime throttle scheduler', async () => {
    const callLiveSessionRpc = vi.fn();
    const retryTemporaryThrottleNow = vi.fn(async () => ({ status: 'resumed' }));
    const resolveAdapter = vi.fn();

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        active: true,
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createTemporaryThrottleIssue(),
      }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_1', agentId: 'codex' },
      callLiveSessionRpc,
      resolveAdapter,
      retryTemporaryThrottleNow,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_1',
    });
    expect(retryTemporaryThrottleNow).toHaveBeenCalledWith({ sessionId: 'sess_1' });
    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(resolveAdapter).not.toHaveBeenCalled();
  });

  it('routes reset-credit consumption through the inactive provider adapter without live session RPC', async () => {
    const callLiveSessionRpc = vi.fn(async () => ({ ok: false, errorCode: 'unexpected_live_rpc' }));
    const consumeResetCredit = vi.fn(async () => ({ ok: true, status: 'waiting' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        active: true,
        path: '/home/coder/project',
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue(),
      }),
      metadata: createMetadata({
        path: '/home/coder/project',
        agentRuntimeDescriptorV1: { v: 1, providerId: 'codex' },
        sessionWorkspaceLocationV1: {
          v: 1,
          machineId: 'machine-local',
          agentPath: '/home/coder/project',
          machinePath: '/Users/alice/project',
        },
      }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: {
        sessionId: 'sess_1',
        provider: 'codex',
        operation: 'consume_reset_credit',
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
      } as any,
      callLiveSessionRpc,
      resolveAdapter: vi.fn(async () => ({ consumeResetCredit } as any)),
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(consumeResetCredit).toHaveBeenCalledTimes(1);
    const consumeCall = consumeResetCredit.mock.calls[0] as unknown as [
      { cwd: string; metadata: Record<string, unknown> },
    ];
    expect(consumeCall[0].cwd).toBe('/Users/alice/project');
    expect(consumeCall[0].metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]).toMatchObject({
      issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
    });
  });

  it('arms inactive local wait-resume from retry-after timing when no reset timestamp exists', async () => {
    const callLiveSessionRpc = vi.fn();

    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue({
          resetAtMs: null,
          retryAfterMs: 90_000,
        }),
      }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(Object.keys(result as Record<string, unknown>)).not.toContain('metadata');
    expect((result as Record<string, unknown>).metadata).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        status: 'waiting',
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
        resetAtMs: null,
        nextCheckAtMs: 1_700_000_090_000,
        selectedAuth: { kind: 'native' },
      },
    });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledTimes(1);
  });

  it('routes inactive manual prompt policy through group-over-account precedence', async () => {
    const loadGroupPolicy = vi.fn(async () => ({ resumePromptMode: 'off' }));
    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ latestTurnStatus: 'failed', lastRuntimeIssue: createUsageLimitIssue() }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc: vi.fn(),
      resumePromptTierSources: {
        accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'custom' } },
        loadGroupPolicy,
      },
    });

    expect(result).toMatchObject({
      metadata: { sessionUsageLimitRecoveryV1: { resumePromptMode: 'off' } },
    });
    expect(loadGroupPolicy).toHaveBeenCalledTimes(1);
  });

  it('preserves group-scoped recovery identity even when the latest issue omits profileId', async () => {
    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          ...createUsageLimitIssue(),
          usageLimit: {
            ...createUsageLimitIssue().usageLimit,
            connectedService: {
              serviceId: 'openai-codex',
              groupId: 'codex-main',
              profileId: null,
            },
          },
        },
      }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect((result as Record<string, unknown>).metadata).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        selectedAuth: {
          kind: 'group',
          serviceId: 'happier.agent.codex/openai-codex',
          groupId: 'codex-main',
          profileId: null,
        },
      },
    });
  });

  it('terminally cancels inactive local wait-resume metadata with the exact attempt identity', async () => {
    const recovery = {
      v: 1,
      status: 'waiting',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      resetAtMs: 2,
      nextCheckAtMs: 2,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    };
    const callLiveSessionRpc = vi.fn();
    const result = await routeSessionUsageLimitRecoveryWaitResumeCancel({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: recovery }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: {
        sessionId: 'sess_1',
        issueFingerprint: recovery.issueFingerprint,
        armedAtMs: recovery.armedAtMs,
      },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    });

    expect(result).toEqual({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_1',
    });
    expect(Object.keys(result as Record<string, unknown>)).not.toContain('metadata');
    expect((result as Record<string, unknown>).metadata).toMatchObject({
      machineId: 'machine-local',
      sessionUsageLimitRecoveryV1: {
        status: 'cancelled',
        issueFingerprint: recovery.issueFingerprint,
        armedAtMs: recovery.armedAtMs,
      },
    });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledTimes(1);
  });

  it('fails closed for an old inactive cancel request without the exact attempt identity', async () => {
    const recovery = {
      v: 1 as const,
      status: 'waiting' as const,
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      resetAtMs: 2,
      nextCheckAtMs: 2,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      resumePromptMode: 'standard' as const,
      selectedAuth: { kind: 'native' as const },
    };

    const result = await routeSessionUsageLimitRecoveryWaitResumeCancel({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: recovery }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_1', issueFingerprint: recovery.issueFingerprint },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'session_usage_limit_recovery_control_attempt_identity_required',
    });
    expect(stageUsageLimitRecoveryMutation).not.toHaveBeenCalled();
  });

  it('stages cancellation with the exact attempt identity for durable CAS delivery', async () => {
    const attemptA = {
      v: 1 as const,
      status: 'waiting' as const,
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      resetAtMs: 2,
      nextCheckAtMs: 2,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      resumePromptMode: 'standard' as const,
      selectedAuth: { kind: 'native' as const },
    };
    const result = await routeSessionUsageLimitRecoveryWaitResumeCancel({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: attemptA }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: {
        sessionId: 'sess_1',
        issueFingerprint: attemptA.issueFingerprint,
        armedAtMs: attemptA.armedAtMs,
      },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    expect(result).toEqual({ ok: true, status: 'cancelled', sessionId: 'sess_1' });
    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'runtime.usageLimitRecovery',
      source: 'daemon',
      op: expect.objectContaining({ kind: 'set' }),
    }));
  });

  it('keeps runtime attempt identity in the staged cancellation mutation', async () => {
    const attemptA = {
      v: 1 as const,
      status: 'waiting' as const,
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-a',
      resetAtMs: 2,
      nextCheckAtMs: 2,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      resumePromptMode: 'standard' as const,
      selectedAuth: { kind: 'native' as const },
    };
    const result = await routeSessionUsageLimitRecoveryWaitResumeCancel({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: attemptA }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: {
        sessionId: 'sess_1',
        issueFingerprint: attemptA.issueFingerprint,
        armedAtMs: attemptA.armedAtMs,
        runtimeAuthRecoveryAttemptId: attemptA.runtimeAuthRecoveryAttemptId,
      },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    expect(result).toEqual({ ok: true, status: 'cancelled', sessionId: 'sess_1' });
    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
      op: {
        kind: 'set',
        value: expect.objectContaining({ runtimeAuthRecoveryAttemptId: 'runtime-a' }),
      },
    }));
  });

  it('keeps inactive check-now without a current failure inactive when no provider probe is available', async () => {
    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_no_current_failure',
      rawSession: createRawSession({ id: 'sess_no_current_failure' }),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => null),
    })).resolves.toEqual({
      ok: false,
      status: 'inactive',
      sessionId: 'sess_no_current_failure',
      errorCode: 'session_usage_limit_recovery_control_inactive',
    });
  });

  it('uses the request provider for inactive check-now when session metadata is stale', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const resolveAdapter = vi.fn(async (agentId) => (
      agentId === 'codex' ? { checkNow } : null
    ));

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_1', agentId: 'codex', resumePromptMode: 'off' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
      resumeInactiveSessionWhenReady,
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'sess_1' });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(checkNow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      resumePromptMode: 'off',
      metadata: expect.objectContaining({
        agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
      }),
    }));
    expect(resumeInactiveSessionWhenReady).not.toHaveBeenCalled();
  });

  it('accepts inactive check-now on a re-registered daemon when host and home still match', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_same_machine',
      rawSession: createRawSession({
        id: 'sess_stale_same_machine',
        machineId: 'machine-before-restart',
      }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'leeroy-mbp',
        homeDir: '/Users/leeroy',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'leeroy-mbp',
      currentMachineHomeDir: '/Users/leeroy/',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_stale_same_machine', agentId: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'sess_stale_same_machine' });

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('rejects inactive check-now on a stale machine id when the current daemon home differs', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_home_mismatch',
      rawSession: createRawSession({ id: 'sess_stale_home_mismatch', machineId: 'machine-before-restart' }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'leeroy-mbp',
        homeDir: '/Users/leeroy',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'leeroy-mbp',
      currentMachineHomeDir: '/Users/other',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_stale_home_mismatch', agentId: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    })).resolves.toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_stale_home_mismatch',
      errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
    });

    expect(checkNow).not.toHaveBeenCalled();
  });

  it('rejects inactive check-now on a stale machine id when the current daemon host differs', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_host_mismatch',
      rawSession: createRawSession({ id: 'sess_stale_host_mismatch', machineId: 'machine-before-restart' }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'old-host',
        homeDir: '/Users/leeroy',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'new-host',
      currentMachineHomeDir: '/Users/leeroy',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_stale_host_mismatch', agentId: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    })).resolves.toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_stale_host_mismatch',
      errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
    });

    expect(checkNow).not.toHaveBeenCalled();
  });

  it('discards a probe that completed after the recovery attempt was cancelled', async () => {
    const futureResetAtMs = Date.now() + 60_000;
    const armed = {
      v: 1,
      status: 'waiting',
      resumePromptMode: 'standard',
      issueFingerprint: `usage-limit:codex:turn-1:1700000000000:${futureResetAtMs}`,
      armedAtMs: 1_700_000_000_000,
      resetAtMs: futureResetAtMs,
      nextCheckAtMs: futureResetAtMs,
      attemptCount: 1,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    } as const;
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    let probeStarted = () => {};
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    let finishProbe = () => {};
    const pendingProbe = new Promise<void>((resolve) => { finishProbe = resolve; });
    let cancelled = false;
    // The provider transport remains in flight while the user cancels its exact attempt.
    const checkNow = vi.fn(async () => {
      probeStarted();
      await pendingProbe;
      return {
        ok: true,
        status: 'ready',
        metadata: {
          machineId: 'machine-local',
          sessionUsageLimitRecoveryV1: armed,
        },
      };
    });

    const pendingResult = routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_cancel_race',
      rawSession: createRawSession({ id: 'sess_cancel_race' }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: armed }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
      readCurrentUsageLimitRecovery: () => cancelled
        ? { ...armed, status: 'cancelled' as const, nextCheckAtMs: null }
        : armed,
    });

    await started;
    cancelled = true;
    finishProbe();
    const result = await pendingResult;

    expect(result).toMatchObject({
      ok: false,
      status: 'cancelled',
      sessionId: 'sess_cancel_race',
      errorCode: 'session_usage_limit_recovery_control_inactive',
    });
    expect(stageUsageLimitRecoveryMutation).not.toHaveBeenCalled();
    expect(resumeInactiveSessionWhenReady).not.toHaveBeenCalled();
  });

  it('discards a probe whose recovery attempt was superseded by a newer armed attempt', async () => {
    const armed = {
      v: 1,
      status: 'waiting',
      resumePromptMode: 'standard',
      issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
      armedAtMs: 1_700_000_000_000,
      resetAtMs: 1_700_000_060_000,
      nextCheckAtMs: 1_700_000_060_000,
      attemptCount: 1,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    } as const;
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const checkNow = vi.fn(async () => ({
      ok: true,
      status: 'ready',
      metadata: {
        machineId: 'machine-local',
        sessionUsageLimitRecoveryV1: { ...armed, attemptCount: 2 },
      },
    }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_superseded',
      rawSession: createRawSession({ id: 'sess_superseded' }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: armed }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
      readCurrentUsageLimitRecovery: vi.fn(() => ({
        ...armed,
        armedAtMs: armed.armedAtMs + 5_000,
        attemptCount: 0,
      })),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'inactive',
      sessionId: 'sess_superseded',
      errorCode: 'session_usage_limit_recovery_control_issue_mismatch',
    });
    expect(stageUsageLimitRecoveryMutation).not.toHaveBeenCalled();
    expect(resumeInactiveSessionWhenReady).not.toHaveBeenCalled();
  });

  it('settles a current ready result only after continuation acceptance', async () => {
    const futureResetAtMs = Date.now() + 60_000;
    const sessionId = 'sess_current_ready';
    const armed = {
      v: 1,
      status: 'waiting',
      resumePromptMode: 'standard',
      issueFingerprint: `usage-limit:codex:turn-1:1700000000000:${futureResetAtMs}`,
      armedAtMs: 1_700_000_000_000,
      resetAtMs: futureResetAtMs,
      nextCheckAtMs: futureResetAtMs,
      attemptCount: 1,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    } as const;
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const checkNow = vi.fn(async () => ({
      ok: true,
      status: 'ready',
      metadata: {
        machineId: 'machine-local',
        sessionUsageLimitRecoveryV1: { ...armed, status: 'cancelled', nextCheckAtMs: null },
      },
    }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId,
      rawSession: createRawSession({ id: sessionId }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: armed }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
      readCurrentUsageLimitRecovery: vi.fn(() => armed),
    });

    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      readiness: 'provider_ready',
      metadata: expect.objectContaining({
        sessionUsageLimitRecoveryV1: expect.objectContaining({
          status: 'waiting', issueFingerprint: armed.issueFingerprint, attemptCount: armed.attemptCount,
        }),
      }),
    }));
    expect(result).toMatchObject({
      ok: true,
      status: 'resumed',
      sessionId,
      metadata: { sessionUsageLimitRecoveryV1: {
        status: 'cancelled',
        nextCheckAtMs: null,
        attemptCount: armed.attemptCount,
        lastProbeError: null,
      } },
    });
    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
      op: { kind: 'set', value: expect.objectContaining({
        status: 'cancelled',
        issueFingerprint: armed.issueFingerprint,
        attemptCount: armed.attemptCount,
      }) },
    }));
  });

  it('does not auto-resume inactive check-now when persisted recovery disables resume prompts', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const recovery = {
      v: 1,
      status: 'waiting',
      resumePromptMode: 'off',
      issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
      armedAtMs: 1_700_000_000_000,
      resetAtMs: 1_700_000_060_000,
      nextCheckAtMs: 1_700_000_060_000,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    };

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_off',
      rawSession: createRawSession({ id: 'sess_off' }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: recovery }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
    })).resolves.toMatchObject({ ok: true, status: 'ready', sessionId: 'sess_off',
      metadata: { sessionUsageLimitRecoveryV1: { status: 'paused', resumePromptMode: 'off', nextCheckAtMs: null } },
    });

    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
      op: { kind: 'set', value: expect.objectContaining({ status: 'paused', resumePromptMode: 'off', nextCheckAtMs: null }) },
    }));
    expect(resumeInactiveSessionWhenReady).not.toHaveBeenCalled();
  });

  it('resumes an inactive local session with persisted ready metadata when resume prompts are enabled', async () => {
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const checkNow = vi.fn(async () => ({
      ok: true,
      status: 'ready',
      metadata: {
        machineId: 'machine-local',
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'cancelled',
          resumePromptMode: 'standard',
          issueFingerprint: 'usage-limit:claude:turn-1:1:2',
          armedAtMs: 1,
          resetAtMs: 2,
          nextCheckAtMs: 2,
          attemptCount: 1,
          maxAttempts: 3,
          lastProbeError: null,
          selectedAuth: { kind: 'native', serviceId: 'claude-subscription' },
        },
      },
    }));

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive_ready',
      rawSession: createRawSession({ id: 'sess_inactive_ready' }),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
    })).resolves.toMatchObject({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_inactive_ready',
    });

    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
      op: { kind: 'set', value: expect.objectContaining({ status: 'cancelled', nextCheckAtMs: null }) },
    }));
    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive_ready',
      metadata: expect.objectContaining({
        sessionUsageLimitRecoveryV1: expect.objectContaining({ status: 'waiting' }),
      }),
    }));
  });

  it('lets the provider owner answer each explicit inactive check-now request', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const resolveAdapter = vi.fn(async () => ({ checkNow }));
    const params = {
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_rate_limited',
      rawSession: createRawSession({ id: 'sess_rate_limited' }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain' as const,
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_rate_limited', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    };

    await expect(routeSessionUsageLimitRecoveryCheckNow(params)).resolves.toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_rate_limited',
    });
    await expect(routeSessionUsageLimitRecoveryCheckNow(params)).resolves.toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_rate_limited',
    });

    expect(checkNow).toHaveBeenCalledTimes(2);
  });

  it('keeps active wait-resume enable on live session RPC when supported', async () => {
    const callLiveSessionRpc = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));

    await expect(routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_1' },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess_1' });

    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    expect(stageUsageLimitRecoveryMutation).not.toHaveBeenCalled();
  });
  /**
   * The user's ruling: replacing a machine must not strand the Sessions the
   * previous one hosted. Nothing re-homes a Session row, so its recorded host
   * stays the PREDECESSOR forever, and a replacement is a genuinely new host
   * that cannot earn the same-host-home proof.
   */
  it('runs inactive check-now for a session whose recorded machine this one replaced', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-old', replacedByMachineId: 'machine-new' },
      { id: 'machine-new' },
    ]);
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_replaced',
      rawSession: createRawSession({ id: 'sess_replaced', machineId: 'machine-old' }),
      metadata: createMetadata({ machineId: 'machine-old', host: 'old-laptop', homeDir: '/Users/leeroy' }),
      currentMachineId: 'machine-new',
      currentMachineHost: 'new-laptop',
      currentMachineHomeDir: '/Users/leeroy',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_replaced', agentId: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'sess_replaced' });

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('still refuses inactive check-now when the replacement chain is unreadable', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue(null);
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_chain_unreadable',
      rawSession: createRawSession({ id: 'sess_chain_unreadable', machineId: 'machine-old' }),
      metadata: createMetadata({ machineId: 'machine-old' }),
      currentMachineId: 'machine-new',
      ctx: null,
      mode: 'plain',
      stageUsageLimitRecoveryMutation,
      request: { sessionId: 'sess_chain_unreadable', agentId: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    })).resolves.toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_chain_unreadable',
      errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
    });

    expect(checkNow).not.toHaveBeenCalled();
  });
});
