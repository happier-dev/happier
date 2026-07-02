import type { HostRuntimeControlServiceV1 } from '@happier-dev/agents';
import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { checkCodexUsageLimitRecoveryNow } from './usageLimitRecovery.js';

function createWaitingIntent(overrides: Partial<SessionUsageLimitRecoveryV1> = {}): SessionUsageLimitRecoveryV1 {
  return {
    v: 1,
    status: 'waiting',
    resumePromptMode: 'standard',
    issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
    armedAtMs: 1_700_000_000_000,
    resetAtMs: null,
    nextCheckAtMs: null,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    ...overrides,
  };
}

function createRuntimeControlStub(request = vi.fn(async () => ({ ok: false as const, error: 'unexpected probe' }))) {
  // Boundary harness stub: only the appServer.request surface is exercised by checkNow.
  return {
    runtimeControl: { appServer: { request } } as unknown as HostRuntimeControlServiceV1,
    request,
  };
}

describe('checkCodexUsageLimitRecoveryNow', () => {
  it('clears a persisted pending intent without probing when the latest turn completed normally', async () => {
    const { runtimeControl, request } = createRuntimeControlStub();

    const result = await checkCodexUsageLimitRecoveryNow({
      runtimeControl,
      params: {
        cwd: '/repo',
        metadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: createWaitingIntent() },
        rawSession: { latestTurnStatus: 'completed' },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_superseded_by_turn_completion',
      metadata: {
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
          status: 'cancelled',
        },
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps probing a persisted pending intent when the latest turn is still failed', async () => {
    const { runtimeControl, request } = createRuntimeControlStub(vi.fn(async () => ({
      ok: true as const,
      value: { rateLimits: null },
    })));

    const result = await checkCodexUsageLimitRecoveryNow({
      runtimeControl,
      params: {
        cwd: '/repo',
        metadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: createWaitingIntent() },
        rawSession: { latestTurnStatus: 'failed' },
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps probing a persisted pending intent when turn status evidence is unavailable', async () => {
    const { runtimeControl, request } = createRuntimeControlStub(vi.fn(async () => ({
      ok: true as const,
      value: { rateLimits: null },
    })));

    const result = await checkCodexUsageLimitRecoveryNow({
      runtimeControl,
      params: {
        cwd: '/repo',
        metadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: createWaitingIntent() },
        rawSession: {},
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit custom resume prompt mode when arming from the latest failed issue', async () => {
    const { runtimeControl, request } = createRuntimeControlStub(vi.fn(async () => ({
      ok: true as const,
      value: { rateLimits: null },
    })));

    const result = await checkCodexUsageLimitRecoveryNow({
      runtimeControl,
      params: {
        cwd: '/repo',
        metadata: {},
        rawSession: {
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
              resetAtMs: null,
              retryAfterMs: null,
              quotaScope: 'account',
              recoverability: 'wait',
            },
          },
        },
        resumePromptMode: 'custom',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      metadata: {
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
          resumePromptMode: 'custom',
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
