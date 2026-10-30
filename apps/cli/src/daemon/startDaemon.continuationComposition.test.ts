import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createConnectedServiceSwitchDeferralQueue } from './connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { ConnectedServiceAuthGroupGenerationConsumer } from './connectedServices/accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import {
  doesRestartCompletionProvePreviousRunnerRetired,
  isSupersededRuntimeAuthFailure,
  settleSupersedingRuntimeAuthGenerationForSource,
  resolveConnectedServiceContinuationInterruptionForSwitch,
  resolveConnectedServiceContinuationOriginId,
  resolveContinuationResumePromptMode,
} from './startDaemon';

describe('startDaemon connected-service continuation composition', () => {
  it('freezes the routed prompt mode with group policy precedence', async () => {
    await expect(resolveContinuationResumePromptMode({
      explicit: undefined,
      readAccountSettings: () => ({ usageLimitRecoverySettingsV1: { resumePromptMode: 'custom' } }),
      loadGroupPolicy: () => ({ resumePromptMode: 'off' }),
    })).resolves.toBe('off');
  });

  it('classifies only a replacement of the interrupted origin as continuation-eligible', () => {
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    expect(resolveConnectedServiceContinuationInterruptionForSwitch({
      sessionId: 'session-1',
      action: 'hot_applied',
      failureDriven: true,
      turnDeferralQueue,
    })).toBe('none');
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
    expect(resolveConnectedServiceContinuationInterruptionForSwitch({
      sessionId: 'session-1',
      action: 'restart_requested',
      turnDeferralQueue,
    })).toBe('clean_boundary');
  });

  it('uses a fresh report identity when the failed provider turn has already cleared activeTurnId', () => {
    expect(resolveConnectedServiceContinuationOriginId({
      source: 'daemon_report',
      activeTurnId: null,
      reportId: 'runtime-auth-report:origin-a',
    })).toBe('runtime-auth-report:origin-a');
    expect(resolveConnectedServiceContinuationOriginId({
      source: 'daemon_report',
      activeTurnId: 'turn-live',
      reportId: 'runtime-auth-report:origin-a',
    })).toBe('runtime-auth-report:origin-a');
    expect(resolveConnectedServiceContinuationOriginId({
      source: 'scheduler_retry',
      activeTurnId: 'turn-stale',
      reportId: 'runtime-auth-report:origin-a',
    })).toBe('runtime-auth-report:origin-a');
    expect(resolveConnectedServiceContinuationOriginId({
      source: 'scheduler_retry',
      activeTurnId: 'turn-newer-user-work',
    })).toBeNull();
  });

  it('keeps a tuple-mismatch superseded report passive', async () => {
    expect(isSupersededRuntimeAuthFailure({
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_mismatch',
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-stale',
      },
    })).toBe(true);
  });

  it('keeps an identity-poor superseded report passive', async () => {
    expect(isSupersededRuntimeAuthFailure({
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_unavailable',
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-stale',
      },
    })).toBe(true);
  });

  it('reconsumes a superseding runtime-auth target through the existing generation consumer', async () => {
    const applyCommittedGeneration = vi.fn<ConstructorParameters<typeof ConnectedServiceAuthGroupGenerationConsumer>[0]['applyCommittedGeneration']>(async ({ committedGeneration }) => ({
      reconciliationDisposition: 'converged', errorCode: null,
      providerAdoptedTarget: { ...committedGeneration.decisionCommittedTarget,
        proof: { status: 'verified', source: 'codex_app_server', providerAccountId: 'account-current',
          credentialRevision: committedGeneration.decisionCommittedTarget.credentialRevision } },
    }));
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'per_session_runtime', ownerId: 'runner' }),
      verifySharedGenerationApplication: async () => null,
      applyCommittedGeneration, notifyCurrentGroupTruth: async () => ({ ok: true }),
    });

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
      consumeCommittedAuthGroupGeneration: (input) => consumer.consume(input),
    })).resolves.toMatchObject({ profileId: 'profile-current', generation: 7,
      credentialRevision: 'csr_cccccccccccccccccccccc', proof: { status: 'verified' } });

    expect(applyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', fromProfileId: 'profile-stale',
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
      executionAuthority: 'runtime_recovery',
    }));
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
      consumeCommittedAuthGroupGeneration: async () => ({ outcome: 'retryable_not_acknowledged', resultsBySessionId: {} }),
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
      consumeCommittedAuthGroupGeneration: async () => ({ outcome: 'adopted_current', resultsBySessionId: {} }),
    })).rejects.toMatchObject({
      code: 'connected_service_runtime_auth_superseding_generation_target_unavailable',
      retryable: true,
    });
  });

  it('accepts terminal respawn outcomes as retired-predecessor proof but fails closed on waiter timeout', () => {
    expect(doesRestartCompletionProvePreviousRunnerRetired({ ok: true })).toBe(true);
    expect(doesRestartCompletionProvePreviousRunnerRetired({
      ok: false,
      status: 'spawn_failed',
      diagnostics: { respawnTerminalReason: 'not_authenticated' },
    })).toBe(true);
    expect(doesRestartCompletionProvePreviousRunnerRetired({
      ok: false,
      status: 'partial_failure',
      diagnostics: { respawnTerminalReason: 'timeout', timeoutMs: 60_000 },
    })).toBe(false);
  });

  it('contains no daemon replay, attempt timer, or historical-original reconstruction path', async () => {
    const source = await readFile(new URL('./startDaemon.ts', import.meta.url), 'utf8');
    expect(source).toContain("input.source === 'scheduler_retry'");
    expect(source).toContain('resolveConnectedServiceContinuationOriginId({');
    expect(source).toContain('reportId: input.interruptedOriginId');
    expect(source).not.toContain('createSessionContinuationRecoveryController');
    expect(source).not.toContain('retryOriginalCommittedUserMessage');
    expect(source).not.toContain('hydratePendingConnectedServiceContinuationsForDaemon');
    expect(source).not.toContain('resolveConnectedServiceContinuationReplayPlan');
    expect(source).not.toContain('scheduleSessionContinuationRecoveryTimeout');
    expect(source).not.toContain('hasNewerExplicitUserInput');
    expect(source).not.toContain('hasCommittedUserMessageAfterMs');
    expect(source).not.toContain('failure-at:');
  });

  it('shares exact live source resolution between in-band reports and scheduler retries', async () => {
    const source = await readFile(new URL('./startDaemon.ts', import.meta.url), 'utf8');
    expect(
      source.match(/resolveCurrentRuntimeAuthFailureSource: resolveCurrentRuntimeAuthFailureSourceForSession/g),
    ).toHaveLength(2);
  });
});
