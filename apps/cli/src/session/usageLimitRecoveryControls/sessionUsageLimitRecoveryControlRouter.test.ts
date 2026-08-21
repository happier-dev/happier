import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import {
  SessionUsageLimitRecoveryOperationResultV1Schema,
  type SessionUsageLimitRecoveryOperationResultV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

const mocks = vi.hoisted(() => ({
  fetchAccountMachineReplacements: vi.fn(),
  updateSessionMetadataWithRetry: vi.fn(async (params: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  }) => ({
    version: 2,
    metadata: params.updater({ concurrent: 'preserved' }),
  })),
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
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
      vendorSessionId: 'thread-1',
    }),
    ...overrides,
  };
}

function createUsageLimitIssue(overrides: Partial<{
  resetAtMs: number | null;
  retryAfterMs: number | null;
}> = {}) {
  const resetAtMs = overrides.resetAtMs === undefined ? 1_700_000_060_000 : overrides.resetAtMs;
  const retryAfterMs = overrides.retryAfterMs === undefined ? null : overrides.retryAfterMs;
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    provider: 'codex',
    providerTurnId: 'turn-1',
    occurredAt: 1_700_000_000_000,
    usageLimit: {
      v: 1,
      resetAtMs,
      retryAfterMs,
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
    source: 'provider_status_error',
    provider: 'codex',
    providerTurnId: 'turn-throttle',
    occurredAt: 1_700_000_000_000,
    sanitizedPreview: 'Provider is temporarily limiting requests',
    temporaryThrottle: {
      v: 1,
      retryAfterMs: 30_000,
      recoverability: 'retry',
    },
  } as const;
}

const ctx = {
  encryptionKey: new Uint8Array(32).fill(1),
  encryptionVariant: 'legacy' as const,
};

function parseOperationResult(value: unknown): SessionUsageLimitRecoveryOperationResultV1 {
  const parsed = SessionUsageLimitRecoveryOperationResultV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Expected SessionUsageLimitRecoveryOperationResultV1: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

function lastMetadataUpdaterResult(input: Record<string, unknown>): Record<string, unknown> {
  const call = mocks.updateSessionMetadataWithRetry.mock.calls.at(-1)?.[0];
  if (!call) throw new Error('Expected updateSessionMetadataWithRetry to be called');
  return call.updater(input);
}

describe('sessionUsageLimitRecoveryControlRouter', () => {
  beforeEach(() => {
    mocks.updateSessionMetadataWithRetry.mockClear();
    mocks.fetchAccountMachineReplacements.mockReset();
    // The Account genuinely knows both machines and neither replaced the other,
    // so a refusal below is the guard deciding, not an empty chain.
    mocks.fetchAccountMachineReplacements.mockResolvedValue([
      { id: 'machine-local' },
      { id: 'machine-remote' },
    ]);
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', remember: true, resumePromptMode: 'off' } as any,
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    });

    expect(parseOperationResult(result)).toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
      // RD-REC-17: persisted metadata now rides the typed result as an enumerable field.
      metadata: expect.any(Object),
    });
    expect(lastMetadataUpdaterResult({ concurrent: 'preserved' })).toMatchObject({
      concurrent: 'preserved',
      sessionUsageLimitRecoveryV1: {
        status: 'waiting',
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
        resumePromptMode: 'off',
        resetAtMs: 1_700_000_060_000,
        nextCheckAtMs: 1_700_000_060_000,
        selectedAuth: { kind: 'native' },
      },
    });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
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

    await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue(),
      }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: cancelled }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    const persisted = lastMetadataUpdaterResult({ sessionUsageLimitRecoveryV1: cancelled });
    expect(persisted.sessionUsageLimitRecoveryV1).toMatchObject({
      status: 'waiting',
      issueFingerprint: cancelled.issueFingerprint,
      attemptCount: 0,
    });
    expect((persisted.sessionUsageLimitRecoveryV1 as { armedAtMs: number }).armedAtMs)
      .toBeGreaterThan(cancelled.armedAtMs);
  });

  it('preserves an existing inactive recovery resumePromptMode when re-arming without explicit input', async () => {
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
      resumePromptMode: 'off',
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    };

    await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue(),
      }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: recovery }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    expect(lastMetadataUpdaterResult({ sessionUsageLimitRecoveryV1: recovery })).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        resumePromptMode: 'off',
      },
    });
  });

  it('keeps explicit standard over a stored off intent when re-arming', async () => {
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
      resumePromptMode: 'off',
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    };

    await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue(),
      }),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: recovery }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', remember: true, resumePromptMode: 'standard' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    expect(lastMetadataUpdaterResult({ sessionUsageLimitRecoveryV1: recovery })).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        resumePromptMode: 'standard',
      },
    });
  });

  it('arms inactive wait-resume from the account-settings tier when no explicit or stored mode exists', async () => {
    await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue(),
      }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
      resumePromptTierSources: {
        accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
      },
    });

    expect(lastMetadataUpdaterResult({})).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        resumePromptMode: 'off',
      },
    });
  });

  it('arms inactive wait-resume from the group-policy tier when explicit, intent, and account tiers are silent', async () => {
    const loadGroupPolicy = vi.fn(async () => ({ resumePromptMode: 'off' }));

    await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue(),
      }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
      resumePromptTierSources: { loadGroupPolicy },
    });

    expect(loadGroupPolicy).toHaveBeenCalledTimes(1);
    expect(lastMetadataUpdaterResult({})).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        resumePromptMode: 'off',
      },
    });
  });

  it('passes the resolved account-tier resume prompt mode to the inactive check-now adapter', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));

    await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_check_account_tier',
      rawSession: createRawSession({ id: 'sess_check_account_tier' }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_check_account_tier', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumePromptTierSources: {
        accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
      },
    });

    expect(checkNow).toHaveBeenCalledWith(expect.objectContaining({
      resumePromptMode: 'off',
    }));
  });

  it('routes reset-credit consumption through the provider adapter without live-session check-now', async () => {
    const consumeResetCredit = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const callLiveSessionRpc = vi.fn(async () => ({ ok: true, status: 'waiting' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_consume_reset',
      rawSession: createRawSession({ id: 'sess_consume_reset', active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: {
        sessionId: 'sess_consume_reset',
        provider: 'codex',
        operation: 'consume_reset_credit',
      },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(async () => ({ consumeResetCredit })),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_consume_reset',
    });
    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(consumeResetCredit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_consume_reset',
    }));
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    });

    expect(parseOperationResult(result)).toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
      // RD-REC-17: persisted metadata now rides the typed result as an enumerable field.
      metadata: expect.any(Object),
    });
    expect(lastMetadataUpdaterResult({})).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        status: 'waiting',
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
        resetAtMs: null,
        nextCheckAtMs: 1_700_000_090_000,
        selectedAuth: { kind: 'native' },
      },
    });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    expect(parseOperationResult(result)).toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
      // RD-REC-17: persisted metadata now rides the typed result as an enumerable field.
      metadata: expect.any(Object),
    });
    expect(lastMetadataUpdaterResult({})).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        selectedAuth: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          profileId: null,
        },
      },
    });
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', provider: 'codex' },
      callLiveSessionRpc,
      resolveAdapter,
      retryTemporaryThrottleNow,
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_1',
    });
    expect(retryTemporaryThrottleNow).toHaveBeenCalledWith({ sessionId: 'sess_1' });
    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(resolveAdapter).not.toHaveBeenCalled();
  });

  it('terminally cancels inactive local wait-resume metadata without live session RPC', async () => {
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
      ctx,
      mode: 'plain',
      request: {
        sessionId: 'sess_1',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
      },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    });

    expect(parseOperationResult(result)).toMatchObject({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_1',
      // RD-REC-17: persisted metadata now rides the typed result as an enumerable field.
      metadata: expect.any(Object),
    });
    expect(lastMetadataUpdaterResult({ concurrent: 'preserved', sessionUsageLimitRecoveryV1: recovery }))
      .toMatchObject({
        concurrent: 'preserved',
        sessionUsageLimitRecoveryV1: {
          issueFingerprint: 'usage-limit:sess_1:reset',
          armedAtMs: 1,
          status: 'cancelled',
          nextCheckAtMs: null,
        },
      });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
  });

  it('does not let delayed exact cancel A mutate newer same-fingerprint attempt B at metadata CAS', async () => {
    const attemptA = {
      v: 1 as const,
      status: 'waiting' as const,
      issueFingerprint: 'same-issue',
      armedAtMs: 100,
      resetAtMs: 200,
      nextCheckAtMs: 200,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      resumePromptMode: 'standard' as const,
      selectedAuth: { kind: 'native' as const },
    };
    const attemptB = { ...attemptA, armedAtMs: 101 };
    mocks.updateSessionMetadataWithRetry.mockImplementationOnce(async (params: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      version: 2,
      metadata: params.updater(createMetadata({ sessionUsageLimitRecoveryV1: attemptB })),
    }));

    const result = await routeSessionUsageLimitRecoveryWaitResumeCancel({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: attemptA }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', issueFingerprint: 'same-issue', armedAtMs: 100 },
      callLiveSessionRpc: vi.fn(),
    });

    expect(parseOperationResult(result)).toMatchObject({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_issue_mismatch',
    });
    expect((result as { metadata?: Record<string, unknown> }).metadata).toBeUndefined();
  });

  it('does not let delayed runtime cancel A mutate runtime B with the same usage tuple at metadata CAS', async () => {
    const attemptA = {
      v: 1 as const,
      status: 'waiting' as const,
      issueFingerprint: 'same-issue',
      armedAtMs: 100,
      runtimeAuthRecoveryAttemptId: 'runtime-a',
      resetAtMs: 200,
      nextCheckAtMs: 200,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      resumePromptMode: 'standard' as const,
      selectedAuth: { kind: 'native' as const },
    };
    const attemptB = { ...attemptA, runtimeAuthRecoveryAttemptId: 'runtime-b' };
    mocks.updateSessionMetadataWithRetry.mockImplementationOnce(async (params: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      version: 2,
      metadata: params.updater(createMetadata({ sessionUsageLimitRecoveryV1: attemptB })),
    }));

    const result = await routeSessionUsageLimitRecoveryWaitResumeCancel({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: attemptA }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: {
        sessionId: 'sess_1',
        issueFingerprint: attemptA.issueFingerprint,
        armedAtMs: attemptA.armedAtMs,
        runtimeAuthRecoveryAttemptId: attemptA.runtimeAuthRecoveryAttemptId,
      },
      callLiveSessionRpc: vi.fn(),
    });

    expect(parseOperationResult(result)).toMatchObject({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_issue_mismatch',
    });
    expect((result as { metadata?: Record<string, unknown> }).metadata).toBeUndefined();
  });

  it('returns a schema-valid inactive result when wait-resume cannot derive a recovery issue', async () => {
    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      rawSession: createRawSession({ id: 'sess_inactive' }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_inactive', remember: true },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'inactive',
      sessionId: 'sess_inactive',
      errorCode: 'session_usage_limit_recovery_control_inactive',
    });
  });

  it('returns a stable provider-unsupported result for inactive check-now without a provider adapter', async () => {
    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => null),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'session_usage_limit_recovery_control_provider_unsupported',
    });
  });

  it('uses the request provider for inactive check-now when session metadata is stale', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const resolveAdapter = vi.fn(async (agentId) => (
      agentId === 'codex' ? { checkNow } : null
    ));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_1',
    });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(checkNow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      metadata: expect.objectContaining({
        agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
      }),
    }));
  });

  it('accepts inactive check-now on a re-registered daemon when host and home still match', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_same_machine', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_stale_same_machine',
    });

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('accepts inactive check-now on a re-registered Windows daemon when host case and home separators drift', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_windows_machine',
      rawSession: createRawSession({
        id: 'sess_stale_windows_machine',
        path: 'C:\\Users\\Leeroy\\workspace\\repo',
        machineId: 'machine-before-restart',
      }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'LEEROY-MBP.local',
        homeDir: 'C:\\Users\\Leeroy\\',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'leeroy-mbp',
      currentMachineHomeDir: 'c:/users/leeroy',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_windows_machine', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_stale_windows_machine',
    });

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('rejects inactive check-now on a stale machine id when the current daemon home differs', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_home_mismatch', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_stale_home_mismatch',
      errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
    });

    expect(checkNow).not.toHaveBeenCalled();
  });

  it('rejects inactive check-now on a stale machine id when the current daemon host differs', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_host_mismatch', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_stale_host_mismatch',
      errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
    });

    expect(checkNow).not.toHaveBeenCalled();
  });

  it('resumes an inactive local session when check-now returns ready', async () => {
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const checkNow = vi.fn(async () => ({
      ok: true,
      status: 'ready',
      metadata: {
        machineId: 'machine-local',
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'paused',
          issueFingerprint: 'usage-limit:claude:turn-1:1:2',
          armedAtMs: 1,
          resetAtMs: 2,
          nextCheckAtMs: null,
          attemptCount: 1,
          maxAttempts: 3,
          lastProbeError: null,
          selectedAuth: { kind: 'native', serviceId: 'claude-subscription' },
        },
      },
    }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
    });

    expect(parseOperationResult(result)).toMatchObject({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_1',
      // RD-REC-17: persisted metadata now rides the typed result as an enumerable field.
      metadata: expect.any(Object),
    });

    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(2);
    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      metadata: expect.objectContaining({
        sessionUsageLimitRecoveryV1: expect.objectContaining({ status: 'paused' }),
      }),
    }));
  });

  it('resumes an inactive local session when check-now normalizes to ready', async () => {
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const checkNow = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'ready',
      },
      metadata: {
        machineId: 'machine-local',
      },
    }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_nested_ready',
      rawSession: createRawSession({ id: 'sess_nested_ready' }),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
    });

    expect(parseOperationResult(result)).toMatchObject({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_nested_ready',
      // RD-REC-17: persisted metadata now rides the typed result as an enumerable field.
      metadata: expect.any(Object),
    });

    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledTimes(1);
  });

  it('does not surface ready when inactive check-now cannot resume the local session', async () => {
    const resumeInactiveSessionWhenReady = vi.fn(async () => false);
    const checkNow = vi.fn(async () => ({
      ok: true,
      status: 'ready',
      metadata: {
        machineId: 'machine-local',
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'paused',
          issueFingerprint: 'usage-limit:claude:turn-1:1:2',
          armedAtMs: 1,
          resetAtMs: 2,
          nextCheckAtMs: null,
          attemptCount: 1,
          maxAttempts: 3,
          lastProbeError: null,
          selectedAuth: { kind: 'native', serviceId: 'claude-subscription' },
        },
      },
    }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_resume_failed',
      rawSession: createRawSession({ id: 'sess_resume_failed' }),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_resume_failed',
      errorCode: 'session_usage_limit_recovery_resume_failed',
    });

    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledTimes(1);
  });

  it('rate-limits repeated inactive check-now probes before calling the provider adapter again', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const resolveAdapter = vi.fn(async () => ({ checkNow }));
    const params = {
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_rate_limited',
      rawSession: createRawSession({ id: 'sess_rate_limited' }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain' as const,
      request: { sessionId: 'sess_rate_limited', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    };

    expect(parseOperationResult(await routeSessionUsageLimitRecoveryCheckNow(params))).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_rate_limited',
    });
    expect(parseOperationResult(await routeSessionUsageLimitRecoveryCheckNow(params))).toEqual({
      ok: false,
      status: 'rate_limited',
      sessionId: 'sess_rate_limited',
      errorCode: 'probe_rate_limited',
      retryAfterMs: expect.any(Number),
    });

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('keeps active wait-resume enable on live session RPC when supported', async () => {
    const callLiveSessionRpc = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));

    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1' },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });

    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
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

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_replaced',
      rawSession: createRawSession({ id: 'sess_replaced', machineId: 'machine-old' }),
      metadata: createMetadata({ machineId: 'machine-old', host: 'old-laptop', homeDir: '/Users/leeroy' }),
      currentMachineId: 'machine-new',
      currentMachineHost: 'new-laptop',
      currentMachineHomeDir: '/Users/leeroy',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_replaced', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    });

    expect(parseOperationResult(result)).toMatchObject({ ok: true, sessionId: 'sess_replaced' });
    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('still refuses inactive check-now when the replacement chain is unreadable', async () => {
    mocks.fetchAccountMachineReplacements.mockResolvedValue(null);
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_chain_unreadable',
      rawSession: createRawSession({ id: 'sess_chain_unreadable', machineId: 'machine-old' }),
      metadata: createMetadata({ machineId: 'machine-old' }),
      currentMachineId: 'machine-new',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_chain_unreadable', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    });

    expect(parseOperationResult(result)).toMatchObject({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
    });
    expect(checkNow).not.toHaveBeenCalled();
  });
});
