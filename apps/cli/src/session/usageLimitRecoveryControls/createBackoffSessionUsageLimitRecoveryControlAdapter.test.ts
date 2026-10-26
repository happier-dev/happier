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
        provider: 'codex',
        providerTurnId: 'turn-1',
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
    ctx: {
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy' as const,
    },
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
    fallbackBackoffEnvKey: 'HAPPIER_TEST_FALLBACK_BACKOFF_MS',
    maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
    defaultFallbackBackoffMs: 60_000,
    defaultMaxAttempts: 3,
    defaultNativeServiceId: 'openai-codex',
    nowMs: () => 1_700_000_120_000,
    processEnv: {},
  });
}

describe('createBackoffSessionUsageLimitRecoveryControlAdapter', () => {
  it('preserves the continuation budget across repeated checks before the reset', async () => {
    let nowMs = 1_700_000_000_000;
    const adapter = createBackoffSessionUsageLimitRecoveryControlAdapter({
      providerId: 'codex',
      fallbackBackoffEnvKey: 'HAPPIER_TEST_FALLBACK_BACKOFF_MS',
      maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
      nowMs: () => nowMs,
      processEnv: {},
    });
    let metadata: Record<string, unknown> = { sessionUsageLimitRecoveryV1: createWaitingIntent() };
    for (let check = 0; check < 4; check += 1) {
      const result = await adapter.checkNow?.({ ...createParams(), metadata });
      expect(result).toMatchObject({ ok: true, status: 'waiting', metadata: {
        sessionUsageLimitRecoveryV1: { status: 'waiting', attemptCount: 0 },
      } });
      if (result && typeof result === 'object' && 'metadata' in result
        && result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)) {
        metadata = { ...result.metadata };
      }
    }
    nowMs = 1_700_000_060_000;
    expect(await adapter.checkNow?.({ ...createParams(), metadata })).toMatchObject({
      ok: true, status: 'ready', metadata: {
        sessionUsageLimitRecoveryV1: { status: 'paused', attemptCount: 0 },
      },
    });
  });

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

  it('uses the shared fallback policy when a provider supplies no overrides', async () => {
    const params = createParams();
    params.rawSession.lastRuntimeIssue!.usageLimit!.resetAtMs = null;
    const adapter = createBackoffSessionUsageLimitRecoveryControlAdapter({
      providerId: 'codex',
      nowMs: () => 1_700_000_000_000,
      processEnv: {},
    });
    expect(await adapter.checkNow?.(params)).toMatchObject({
      status: 'waiting',
      metadata: { sessionUsageLimitRecoveryV1: {
        nextCheckAtMs: 1_700_000_600_000,
        maxAttempts: 3,
      } },
    });
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

    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'paused',
          nextCheckAtMs: null,
        },
      },
    });
  });

  it('declares a persisted pending intent ready when turn status evidence is unavailable', async () => {
    const adapter = createAdapter();

    const result = await adapter.checkNow?.({
      ...createParams(),
      rawSession: createRawSession(),
      metadata: { sessionUsageLimitRecoveryV1: createWaitingIntent() },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'paused',
          nextCheckAtMs: null,
        },
      },
    });
  });

  it('preserves group identity when the latest issue omits profileId', async () => {
    const adapter = createBackoffSessionUsageLimitRecoveryControlAdapter({
      providerId: 'codex',
      fallbackBackoffEnvKey: 'HAPPIER_TEST_FALLBACK_BACKOFF_MS',
      maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
      defaultFallbackBackoffMs: 60_000,
      defaultMaxAttempts: 3,
      defaultNativeServiceId: 'openai-codex',
      nowMs: () => 1_700_000_000_000,
      processEnv: {},
    });

    const result = await adapter.checkNow?.(createParams());

    expect(result).toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          selectedAuth: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            profileId: null,
          },
        },
      },
    });
  });
});
