import { describe, expect, it, vi } from 'vitest';

import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';

import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { createConnectedServiceRecoverySwitchGuard } from './connectedServiceRecoverySwitchGuard';

const SERVICE_ID = 'openai-codex' as const;

function runtimeAuthIntent(input: Readonly<{
  sessionId: string;
  serviceId: typeof SERVICE_ID;
  profileId: string | null;
  groupId: string | null;
  status?: RuntimeAuthRecoveryIntent['status'];
}>): RuntimeAuthRecoveryIntent {
  return {
    v: 1,
    sessionId: input.sessionId,
    serviceId: input.serviceId,
    profileId: input.profileId,
    groupId: input.groupId,
    status: input.status ?? 'waiting',
    armedAtMs: 1_000,
    nextRetryAtMs: 2_000,
    attemptCount: 0,
    maxAttempts: 5,
    switchesThisTurn: 1,
    classification: {
      kind: 'usage_limit',
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
      recoveryAction: { kind: 'quota_recovery_required' },
    },
    failurePhase: 'handler',
    failureReason: 'usage_limit',
    lastError: 'usage limit',
    lastErrorClassification: null,
    terminalAtMs: null,
  };
}

function usageLimitIntent(input: Readonly<{
  status?: SessionUsageLimitRecoveryV1['status'];
  serviceId: typeof SERVICE_ID;
  groupId: string;
  profileId: string;
}>): SessionUsageLimitRecoveryV1 {
  return {
    v: 1,
    issueFingerprint: 'usage-limit:test',
    status: input.status ?? 'waiting',
    resumePromptMode: 'standard',
    armedAtMs: 1_000,
    resetAtMs: 3_000,
    nextCheckAtMs: 3_000,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    selectedAuth: {
      kind: 'group',
      serviceId: input.serviceId,
      groupId: input.groupId,
      profileId: input.profileId,
    },
  };
}

describe('createConnectedServiceRecoverySwitchGuard', () => {
  it('suppresses a quota soft switch when a matching runtime-auth recovery is pending', async () => {
    const runtimeAuthRecovery = {
      readForSession: vi.fn(() => [
        runtimeAuthIntent({
          sessionId: 'session-1',
          serviceId: SERVICE_ID,
          profileId: 'active',
          groupId: 'team',
        }),
      ]),
    };
    const guard = createConnectedServiceRecoverySwitchGuard({
      runtimeAuthRecovery,
      usageLimitRecovery: null,
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({
      status: 'suppress',
      reason: 'quota_soft_switch_suppressed_recovery_pending',
    });
  });

  it('allows a quota soft switch when a matching runtime-auth recovery already terminalized', async () => {
    const runtimeAuthRecovery = {
      readForSession: vi.fn(() => [
        runtimeAuthIntent({
          sessionId: 'session-1',
          serviceId: SERVICE_ID,
          profileId: 'active',
          groupId: 'team',
          status: 'cancelled',
        }),
      ]),
    };
    const guard = createConnectedServiceRecoverySwitchGuard({
      runtimeAuthRecovery,
      usageLimitRecovery: null,
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'usage_limit',
    })).resolves.toEqual({ status: 'allow' });
  });

  it('suppresses a quota soft switch when a matching usage-limit recovery is waiting', async () => {
    const usageLimitRecovery = {
      read: vi.fn(() => usageLimitIntent({
        serviceId: SERVICE_ID,
        groupId: 'team',
        profileId: 'active',
      })),
    };
    const guard = createConnectedServiceRecoverySwitchGuard({
      runtimeAuthRecovery: null,
      usageLimitRecovery,
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({
      status: 'suppress',
      reason: 'quota_soft_switch_suppressed_recovery_pending',
    });
  });

  it('suppresses predictive soft-threshold switching for restart-only providers before checking recovery queues', async () => {
    const resolvePredictiveSoftSwitchMode = vi.fn(async () => 'unsupported' as const);
    const runtimeAuthRecovery = {
      readForSession: vi.fn(() => []),
    };
    const guard = createConnectedServiceRecoverySwitchGuard({
      runtimeAuthRecovery,
      usageLimitRecovery: null,
      resolvePredictiveSoftSwitchMode,
      readTurnState: vi.fn(() => ({ inFlight: false })),
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    });
    expect(resolvePredictiveSoftSwitchMode).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    });
    expect(runtimeAuthRecovery.readForSession).not.toHaveBeenCalled();
  });

  it('suppresses predictive soft-threshold switching while the canonical turn state is still in flight', async () => {
    const guard = createConnectedServiceRecoverySwitchGuard({
      runtimeAuthRecovery: null,
      usageLimitRecovery: null,
      resolvePredictiveSoftSwitchMode: vi.fn(async () => 'supported' as const),
      readTurnState: vi.fn(() => ({ inFlight: true })),
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    });
  });
});
