import { describe, expect, it, vi } from 'vitest';

import { createConnectedServiceSwitchDeferralQueue } from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../connectedServices/accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import {
  isSupersededRuntimeAuthFailure,
  resolveConnectedServiceContinuationInterruptionForSwitch,
  settleSupersedingRuntimeAuthGenerationForSource,
} from './startDaemonSessionControlRuntime';

function createConsumer(adopt = true) {
  return new ConnectedServiceAuthGroupGenerationConsumer({
    resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'per_session_runtime', ownerId: 'runner' }),
    verifySharedGenerationApplication: async () => null,
    clearAdoptedGeneration: async () => {},
    applyCommittedGeneration: async ({ committedGeneration }) => adopt
      ? { reconciliationDisposition: 'converged', errorCode: null,
          providerAdoptedTarget: { ...committedGeneration.decisionCommittedTarget, proof: { status: 'verified', source: 'provider_runtime',
            providerAccountId: 'current-account', credentialRevision: committedGeneration.decisionCommittedTarget.credentialRevision } } }
      : { reconciliationDisposition: 'failed', errorCode: 'provider_application_unavailable' },
  });
}

describe('runtime-v2 connected-service continuation composition', () => {
  it('classifies only the interrupted origin session as continuation-eligible', () => {
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({ disableDeferral: false });
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

  it('recognizes an exact-identity superseded report as passive', () => {
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

  it('recognizes an identity-poor superseded report as passive', () => {
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

  it('does not classify non-superseded recovery results as passive supersession', () => {
    expect(isSupersededRuntimeAuthFailure({
      result: { status: 'switch_attempted' },
    })).toBe(false);
  });

  it('reconsumes a superseding runtime-auth target through the existing generation consumer', async () => {
    const consumer = createConsumer();
    const consumeCommittedAuthGroupGeneration = vi.fn((input: Parameters<typeof consumer.consume>[0]) => consumer.consume(input));

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
    })).resolves.toMatchObject({ profileId: 'profile-current', generation: 7, credentialRevision: 'csr_cccccccccccccccccccccc' });

    expect(consumeCommittedAuthGroupGeneration).toHaveBeenCalledWith({
      committedGeneration: expect.objectContaining({
        provenance: 'runtime_failure',
        decisionCommittedTarget: {
          serviceId: 'happier.agent.codex/openai-codex',
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
      consumeCommittedAuthGroupGeneration: input => createConsumer(false).consume(input),
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
      consumeCommittedAuthGroupGeneration: input => createConsumer().consume(input),
    })).rejects.toMatchObject({
      code: 'connected_service_runtime_auth_superseding_generation_target_unavailable',
      retryable: true,
    });
  });

});
