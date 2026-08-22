import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createConnectedServiceSwitchDeferralQueue } from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import {
  continueAfterSupersededRuntimeAuthFailure,
  resolveConnectedServiceContinuationInterruptionForSwitch,
  settleSupersedingRuntimeAuthGenerationForSource,
} from './startDaemonSessionControlRuntime';

describe('runtime-v2 connected-service continuation composition', () => {
  it('classifies only the interrupted origin session as continuation-eligible', () => {
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    expect(resolveConnectedServiceContinuationInterruptionForSwitch({
      sessionId: 'session-1',
      interruptedSessionId: 'session-1',
      action: 'hot_applied',
      failureDriven: true,
      turnDeferralQueue,
    })).toBe('provider_failed_turn');
    expect(resolveConnectedServiceContinuationInterruptionForSwitch({
      sessionId: 'session-1',
      interruptedSessionId: 'session-1',
      action: 'restart_requested',
      failureDriven: true,
      turnDeferralQueue,
    })).toBe('provider_failed_turn');
    expect(resolveConnectedServiceContinuationInterruptionForSwitch({
      sessionId: 'session-sibling',
      interruptedSessionId: 'session-1',
      action: 'restart_requested',
      failureDriven: true,
      turnDeferralQueue,
    })).toBe('none');
  });

  it('reconciles exact current account truth before continuing a superseded interrupted report', async () => {
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const reconcileCurrentRuntimeAuthTarget = vi.fn(async () => true);

    await expect(continueAfterSupersededRuntimeAuthFailure({
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_mismatch',
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-stale',
      },
      sessionId: 'session-1',
      interruptedOriginId: 'runtime-auth-report:origin-a',
      continueAfterRuntimeAuthSwitch,
      reconcileCurrentRuntimeAuthTarget,
    })).resolves.toBe(true);

    expect(reconcileCurrentRuntimeAuthTarget).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'group-a',
    });
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith({
      sessionId: 'session-1',
      attemptId: 'runtime-auth-report:origin-a',
      action: 'hot_applied',
    });
  });

  it('keeps a superseded interrupted report passive when exact current account truth is not adopted', async () => {
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});

    await expect(continueAfterSupersededRuntimeAuthFailure({
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_mismatch',
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-stale',
      },
      sessionId: 'session-1',
      interruptedOriginId: 'runtime-auth-report:origin-a',
      continueAfterRuntimeAuthSwitch,
      reconcileCurrentRuntimeAuthTarget: async () => false,
    })).resolves.toBe(true);

    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('reconciles a superseded runtime even when there is no continuation origin to enqueue', async () => {
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const reconcileCurrentRuntimeAuthTarget = vi.fn(async () => true);

    await expect(continueAfterSupersededRuntimeAuthFailure({
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_mismatch',
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-stale',
      },
      sessionId: 'session-1',
      interruptedOriginId: null,
      continueAfterRuntimeAuthSwitch,
      reconcileCurrentRuntimeAuthTarget,
    })).resolves.toBe(true);

    expect(reconcileCurrentRuntimeAuthTarget).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('reconciles current group truth before continuing an identity-poor interrupted report', async () => {
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const reconcileCurrentRuntimeAuthTarget = vi.fn(async () => true);

    await expect(continueAfterSupersededRuntimeAuthFailure({
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_unavailable',
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-stale',
      },
      sessionId: 'session-1',
      interruptedOriginId: 'runtime-auth-report:origin-a',
      continueAfterRuntimeAuthSwitch,
      reconcileCurrentRuntimeAuthTarget,
    })).resolves.toBe(true);

    expect(reconcileCurrentRuntimeAuthTarget).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'group-a',
    });
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith({
      sessionId: 'session-1',
      attemptId: 'runtime-auth-report:origin-a',
      action: 'hot_applied',
    });
  });

  it('keeps an identity-poor report passive when current group truth cannot be reconciled', async () => {
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});

    await expect(continueAfterSupersededRuntimeAuthFailure({
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_unavailable',
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-stale',
      },
      sessionId: 'session-1',
      interruptedOriginId: 'runtime-auth-report:origin-a',
      continueAfterRuntimeAuthSwitch,
      reconcileCurrentRuntimeAuthTarget: async () => false,
    })).resolves.toBe(true);

    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('reconsumes a superseding runtime-auth target through the existing generation consumer', async () => {
    const consumeCommittedAuthGroupGeneration = vi.fn(async () => ({ outcome: 'adopted_current' as const }));

    await expect(settleSupersedingRuntimeAuthGenerationForSource({
      recovery: {
        status: 'switch_attempted',
        result: {
          status: 'superseded_after_apply',
          activeProfileId: 'profile-current',
          generation: 7,
          credentialRevision: 'csr_cccccccccccccccccccccc',
        },
      },
      serviceId: 'openai-codex',
      groupId: 'group-a',
      sessionId: 'session-1',
      fromProfileId: 'profile-stale',
      consumeCommittedAuthGroupGeneration,
    })).resolves.toBeUndefined();

    expect(consumeCommittedAuthGroupGeneration).toHaveBeenCalledWith({
      committedGeneration: expect.objectContaining({
        provenance: 'runtime_failure',
        decisionCommittedTarget: {
          serviceId: 'openai-codex',
          groupId: 'group-a',
          profileId: 'profile-current',
          generation: 7,
          credentialRevision: 'csr_cccccccccccccccccccccc',
        },
      }),
      switchReason: 'automatic_runtime_failure',
      sessions: [{ sessionId: 'session-1', activity: 'live', fromProfileId: 'profile-stale' }],
      executionAuthority: 'runtime_recovery',
    });
  });

  it('does not report superseding runtime-auth convergence when current generation adoption is not acknowledged', async () => {
    await expect(settleSupersedingRuntimeAuthGenerationForSource({
      recovery: {
        status: 'switch_attempted',
        result: {
          status: 'superseded_after_apply',
          activeProfileId: 'profile-current',
          generation: 7,
          credentialRevision: 'csr_cccccccccccccccccccccc',
        },
      },
      serviceId: 'openai-codex',
      groupId: 'group-a',
      sessionId: 'session-1',
      fromProfileId: 'profile-stale',
      consumeCommittedAuthGroupGeneration: async () => ({ outcome: 'retryable_not_acknowledged' }),
    })).rejects.toMatchObject({
      code: 'connected_service_runtime_auth_superseding_generation_not_acknowledged',
      retryable: true,
    });
  });

  it('does not report superseding runtime-auth convergence when the authoritative target is incomplete', async () => {
    await expect(settleSupersedingRuntimeAuthGenerationForSource({
      recovery: {
        status: 'switch_attempted',
        result: {
          status: 'superseded_after_apply',
          activeProfileId: '',
          generation: 7,
        },
      },
      serviceId: 'openai-codex',
      groupId: 'group-a',
      sessionId: 'session-1',
      fromProfileId: 'profile-stale',
      consumeCommittedAuthGroupGeneration: async () => ({ outcome: 'adopted_current' }),
    })).rejects.toMatchObject({
      code: 'connected_service_runtime_auth_superseding_generation_target_unavailable',
      retryable: true,
    });
  });

  it('uses only the thin interrupted-origin Pending producer', async () => {
    const source = await readFile(new URL('./startDaemonSessionControlRuntime.ts', import.meta.url), 'utf8');
    expect(source).toContain('enqueueInterruptedOriginContinuation');
    expect(source.match(/\.enqueueInterruptedOriginContinuation\(/g)).toHaveLength(1);
    expect(source).toContain("input.recoveryInvocationSource === 'scheduler_retry'");
    expect(source).toContain('?.activeTurnId?.trim() || null');
    expect(source).not.toContain('createSessionContinuationRecoveryController');
    expect(source).not.toContain('retryOriginalCommittedUserMessage');
    expect(source).not.toContain('resolveConnectedServiceContinuationReplayPlan');
    expect(source).not.toContain('scheduleSessionContinuationRecoveryTimeout');
    expect(source).not.toContain('hasNewerExplicitUserInput');
    expect(source).not.toContain('hasCommittedUserMessageAfterMs');
    expect(source).not.toContain('failure-at:');
  });

  it('shares exact live source resolution between in-band reports and scheduler retries', async () => {
    const source = await readFile(new URL('./startDaemonSessionControlRuntime.ts', import.meta.url), 'utf8');
    expect(
      source.match(/resolveCurrentRuntimeAuthFailureSource: resolveCurrentRuntimeAuthFailureSourceForSession/g),
    ).toHaveLength(2);
  });
});
