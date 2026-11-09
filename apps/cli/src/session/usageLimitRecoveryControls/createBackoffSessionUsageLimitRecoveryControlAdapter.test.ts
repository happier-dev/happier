import { describe, expect, it } from 'vitest';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import { createBackoffSessionUsageLimitRecoveryControlAdapter } from './createBackoffSessionUsageLimitRecoveryControlAdapter';

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

function createParams() {
  return {
    token: 'token',
    sessionId: 'sess_1',
    rawSession: createRawSession({
      latestTurnStatus: 'failed',
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        agentId: 'codex',
        agentTurnId: 'turn-1',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: 1_700_000_060_000,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
          connectedService: {
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            profileId: null,
          },
        },
      },
    }),
    metadata: {},
    currentMachineId: 'machine-local',
    sessionMachineId: 'machine-local',
    cwd: '/repo',
    ctx: null,
    mode: 'plain' as const,
  };
}

function createWaitingIntent() {
  return {
    v: 1 as const,
    status: 'waiting' as const,
    issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
    armedAtMs: 1_700_000_000_000,
    resetAtMs: 1_700_000_060_000,
    nextCheckAtMs: 1_700_000_060_000,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    resumePromptMode: 'standard' as const,
    selectedAuth: { kind: 'native' as const },
  };
}

function createAdapter() {
  return createBackoffSessionUsageLimitRecoveryControlAdapter({
    providerId: 'codex',
    defaultNativeServiceId: 'openai-codex',
    nowMs: () => 1_700_000_120_000,
  });
}

describe('createBackoffSessionUsageLimitRecoveryControlAdapter', () => {
  it('checks the current failure instead of reusing an earlier issue reset', async () => {
    const params = createParams();
    const issue = params.rawSession.lastRuntimeIssue!;
    const result = await createAdapter().checkNow?.({
      ...params,
      rawSession: { ...params.rawSession, lastRuntimeIssue: { ...issue, occurredAt: 1_700_000_100_000,
        usageLimit: { ...issue.usageLimit!, resetAtMs: 1_700_000_160_000 },
      } },
      metadata: { sessionUsageLimitRecoveryV1: createWaitingIntent() },
    });
    expect(result).toMatchObject({ status: 'waiting', metadata: { sessionUsageLimitRecoveryV1: {
      issueFingerprint: 'usage-limit:codex:turn-1:1700000100000:1700000160000',
      armedAtMs: 1_700_000_100_000, resetAtMs: 1_700_000_160_000,
    } } });
  });

  it.each([
    { name: 'known absence', connectedServices: null, kind: 'native' },
    { name: 'qualified native binding', connectedServices: { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'native' },
    } }, kind: 'native' },
    { name: 'actual same-name profile', connectedServices: { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: `native:${'a'.repeat(48)}` },
    } }, kind: 'profile' },
    { name: 'malformed binding evidence', connectedServices: { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'unexpected' },
    } }, kind: 'profile' },
  ])('interprets predecessor native quota identity using $name', async ({ connectedServices, kind }) => {
    const params = createParams();
    params.rawSession.lastRuntimeIssue!.usageLimit!.connectedService = {
      serviceId: 'openai-codex', profileId: `native:${'a'.repeat(48)}`, groupId: null,
    };
    const result = await createAdapter().checkNow?.({ ...params, metadata: { connectedServices } });
    expect(result).toMatchObject({ metadata: { sessionUsageLimitRecoveryV1: {
      selectedAuth: { kind, serviceId: 'happier.agent.codex/openai-codex',
        ...(kind === 'profile' ? { profileId: `native:${'a'.repeat(48)}` } : {}),
      },
    } } });
  });

  it.each([
    { name: 'ordinary pending recovery', runtimeAuthRecoveryAttemptId: undefined, kind: 'native' },
    { name: 'runtime-auth-owned recovery', runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt', kind: 'profile' },
  ])('normalizes persisted predecessor quota identity only for $name', async ({ runtimeAuthRecoveryAttemptId, kind }) => {
    const profileId = `native:${'a'.repeat(48)}`;
    const params = createParams();
    params.rawSession.lastRuntimeIssue!.usageLimit!.connectedService = {
      serviceId: 'openai-codex', profileId, groupId: null,
    };
    const result = await createAdapter().checkNow?.({ ...params, metadata: {
      connectedServices: null,
      sessionUsageLimitRecoveryV1: { ...createWaitingIntent(), runtimeAuthRecoveryAttemptId,
        selectedAuth: { kind: 'profile', serviceId: 'openai-codex', profileId },
      },
    } });
    expect(result).toMatchObject({ metadata: { sessionUsageLimitRecoveryV1: {
      selectedAuth: { kind, serviceId: 'happier.agent.codex/openai-codex' },
    } } });
  });

  it('retains an untimed explicit wait without inventing a provider reset or attempt budget', async () => {
    const params = createParams();
    params.rawSession.lastRuntimeIssue!.usageLimit!.resetAtMs = null;
    const adapter = createBackoffSessionUsageLimitRecoveryControlAdapter({
      providerId: 'codex', nowMs: () => 1_700_000_000_000,
    });
    expect(await adapter.checkNow?.(params)).toMatchObject({ status: 'waiting', metadata: { sessionUsageLimitRecoveryV1: {
      nextCheckAtMs: null, maxAttempts: 0,
    } } });
  });

  it('checks native readiness for an untimed wait and uses only its real retry-after', async () => {
    const params = createParams();
    params.rawSession.lastRuntimeIssue!.usageLimit!.resetAtMs = null;
    let probes = 0;
    const adapter = createBackoffSessionUsageLimitRecoveryControlAdapter({
      providerId: 'codex', nowMs: () => 1_700_000_000_000,
      readinessProbe: async () => ++probes === 1
        ? { status: 'waiting', retryAfterMs: 42_000 }
        : { status: 'ready' },
    });
    expect(await adapter.checkNow?.(params)).toMatchObject({ status: 'waiting', metadata: { sessionUsageLimitRecoveryV1: {
      nextCheckAtMs: 1_700_000_042_000, maxAttempts: 0,
    } } });
    expect(await adapter.checkNow?.(params)).toMatchObject({ status: 'ready', metadata: { sessionUsageLimitRecoveryV1: {
      nextCheckAtMs: null, status: 'paused',
    } } });
    expect(probes).toBe(2);
  });

  it('does not turn a held wait back into readiness from its historical reset', async () => {
    const result = await createAdapter().checkNow?.({ ...createParams(), metadata: {
      sessionUsageLimitRecoveryV1: { ...createWaitingIntent(), nextCheckAtMs: null,
        lastProbeError: 'usage_limit_recovery_readiness_probe_failed' },
    } });
    expect(result).toMatchObject({ status: 'waiting', metadata: { sessionUsageLimitRecoveryV1: {
      nextCheckAtMs: null,
    } } });
  });

  it('clears a persisted pending intent instead of declaring ready when the latest turn completed normally', async () => {
    const adapter = createAdapter();

    const result = await adapter.checkNow?.({
      ...createParams(),
      rawSession: createRawSession({ latestTurnStatus: 'completed' }),
      metadata: { sessionUsageLimitRecoveryV1: createWaitingIntent() },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_superseded_by_turn_completion',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'cancelled',
        },
      },
    });
  });

  it('declares a persisted pending intent ready when the latest turn is still failed', async () => {
    const adapter = createAdapter();

    const result = await adapter.checkNow?.({
      ...createParams(),
      rawSession: createRawSession({ latestTurnStatus: 'failed' }),
      metadata: { sessionUsageLimitRecoveryV1: createWaitingIntent() },
    });

    expect(result).toMatchObject({ ok: true, status: 'ready' });
  });

  it('declares a persisted pending intent ready when turn status evidence is unavailable', async () => {
    const adapter = createAdapter();

    const result = await adapter.checkNow?.({
      ...createParams(),
      rawSession: createRawSession(),
      metadata: { sessionUsageLimitRecoveryV1: createWaitingIntent() },
    });

    expect(result).toMatchObject({ ok: true, status: 'ready' });
  });

  it('preserves group identity when the latest issue omits profileId', async () => {
    const adapter = createBackoffSessionUsageLimitRecoveryControlAdapter({
      providerId: 'codex',
      defaultNativeServiceId: 'openai-codex',
      nowMs: () => 1_700_000_000_000,
    });

    const result = await adapter.checkNow?.(createParams());

    expect(result).toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          selectedAuth: {
            kind: 'group',
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'codex-main',
            profileId: null,
          },
        },
      },
    });
  });
});
