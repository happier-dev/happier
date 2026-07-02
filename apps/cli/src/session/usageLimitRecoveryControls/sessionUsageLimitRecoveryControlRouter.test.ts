import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

const mocks = vi.hoisted(() => ({
  updateSessionMetadataWithRetry: vi.fn(async (params: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  }) => ({
    version: 2,
    metadata: params.updater({ concurrent: 'preserved' }),
  })),
  createSessionClientDurableMutationOutbox: vi.fn((params: {
    deliverRegisteredSessionStateFieldMutation?: (mutation: unknown) => Promise<boolean>;
  }) => ({
    enqueueSessionTurnMutation: vi.fn(),
    enqueueSessionEnd: vi.fn(),
    enqueueTranscriptMessage: vi.fn(),
    enqueueRegisteredSessionStateFieldMutation: vi.fn(async (mutation: unknown) => {
      await params.deliverRegisteredSessionStateFieldMutation?.(mutation);
    }),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
}));
vi.mock('@/api/session/client/transport/mutations/createSessionClientDurableMutationOutbox', () => ({
  createSessionClientDurableMutationOutbox: mocks.createSessionClientDurableMutationOutbox,
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
    providerTurnId: 'turn-1',
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

describe('sessionUsageLimitRecoveryControlRouter', () => {
  beforeEach(() => {
    mocks.updateSessionMetadataWithRetry.mockClear();
    mocks.createSessionClientDurableMutationOutbox.mockClear();
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
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.createSessionClientDurableMutationOutbox).toHaveBeenCalledTimes(1);
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

    expect(result).toMatchObject({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_1',
    });
    expect(retryTemporaryThrottleNow).toHaveBeenCalledWith({ sessionId: 'sess_1' });
    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(resolveAdapter).not.toHaveBeenCalled();
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
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.createSessionClientDurableMutationOutbox).toHaveBeenCalledTimes(1);
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

    expect(result).toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect((result as Record<string, unknown>).metadata).toMatchObject({
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

  it('clears inactive local wait-resume metadata without live session RPC', async () => {
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
      request: { sessionId: 'sess_1', issueFingerprint: null },
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
    });
    expect((result as Record<string, unknown>).metadata).not.toHaveProperty('sessionUsageLimitRecoveryV1');

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.createSessionClientDurableMutationOutbox).toHaveBeenCalledTimes(1);
  });

  it('returns a stable provider-unsupported result for inactive check-now without a provider adapter', async () => {
    await expect(routeSessionUsageLimitRecoveryCheckNow({
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
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'session_usage_limit_recovery_control_provider_unsupported',
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', provider: 'codex', resumePromptMode: 'off' },
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_same_machine', provider: 'codex' },
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_home_mismatch', provider: 'codex' },
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
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_host_mismatch', provider: 'codex' },
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
      ctx,
      mode: 'plain',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'sess_off' });

    expect(checkNow).toHaveBeenCalledTimes(1);
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
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
    })).resolves.toMatchObject({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_1',
    });

    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      metadata: expect.objectContaining({
        sessionUsageLimitRecoveryV1: expect.objectContaining({ status: 'cancelled' }),
      }),
    }));
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

    await expect(routeSessionUsageLimitRecoveryCheckNow(params)).resolves.toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_rate_limited',
    });
    await expect(routeSessionUsageLimitRecoveryCheckNow(params)).resolves.toEqual({
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

    await expect(routeSessionUsageLimitRecoveryWaitResumeEnable({
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
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess_1' });

    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });
});
