import { describe, expect, it, vi } from 'vitest';

import type { DaemonSessionMutationCustody } from '../usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { commitConnectedServiceAccountSwitchSessionEvent } from './commitConnectedServiceAccountSwitchSessionEvent';

type StageTranscriptEvent = DaemonSessionMutationCustody['stageTranscriptEvent'];
type StageTranscriptEventInput = Parameters<StageTranscriptEvent>[0];

function createCustody() {
  return {
    stageTranscriptEvent: vi.fn<StageTranscriptEvent>(
      async (_input: StageTranscriptEventInput) => ({ persisted: true as const, delivered: false }),
    ),
  };
}

describe('commitConnectedServiceAccountSwitchSessionEvent', () => {
  it('awaits durable admission for manual direct-profile switches with stable ids', async () => {
    const mutationCustody = createCustody();
    const event = {
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      groupId: null,
      fromProfileId: 'old-profile',
      toProfileId: 'new-profile',
      reason: 'manual',
    };

    await commitConnectedServiceAccountSwitchSessionEvent({
      mutationCustody,
      sessionId: 'sess-1',
      event,
    });
    await commitConnectedServiceAccountSwitchSessionEvent({
      mutationCustody,
      sessionId: 'sess-1',
      event,
    });

    expect(mutationCustody.stageTranscriptEvent).toHaveBeenCalledTimes(2);
    const first = mutationCustody.stageTranscriptEvent.mock.calls[0]?.[0];
    const second = mutationCustody.stageTranscriptEvent.mock.calls[1]?.[0];
    expect(first).toEqual({
      sessionId: 'sess-1',
      eventId: expect.stringMatching(/^connected-service-account-switch:anthropic:direct:/),
      data: expect.objectContaining({
        type: 'connected-service-account-switch',
        groupId: null,
        fromProfileId: 'old-profile',
        toProfileId: 'new-profile',
        reason: 'manual',
      }),
    });
    expect(first?.eventId).toBe(second?.eventId);
  });

  it('preserves deterministic ids and outcome-aware data across maintenance event families', async () => {
    const mutationCustody = createCustody();
    const events = [
      {
        type: 'connected_service_account_switch_deferred',
        policy: 'defer_until_turn_boundary',
        awaitingBoundary: true,
        timeoutMs: 30_000,
      },
      {
        type: 'connected_service_account_switch_deferral_completed',
        policy: 'defer_until_turn_boundary',
        reason: 'completed_at_boundary',
      },
      {
        type: 'connected_service_account_switch_deferral_superseded',
        policy: 'defer_until_idle',
      },
      {
        type: 'connected_service_account_switch_attempt',
        ok: false,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'failed',
        outcomeAction: 'none',
        reason: 'manual',
        errorCode: 'auth_invalid',
        partialState: 'runtime_auth_partially_applied',
      },
      {
        type: 'provider_state_sharing_degraded',
        serviceId: 'pi',
        requestedStateMode: 'enabled',
        effectiveStateMode: 'disabled',
        code: 'state_sharing_unavailable',
      },
    ] as const;

    for (const event of events) {
      await commitConnectedServiceAccountSwitchSessionEvent({
        mutationCustody,
        sessionId: 'sess-1',
        event,
      });
    }

    expect(mutationCustody.stageTranscriptEvent.mock.calls.map(([input]) => input.eventId)).toEqual([
      'connected-service-account-switch-deferral:defer_until_turn_boundary:awaiting-boundary:30000',
      'connected-service-account-switch-deferral-completed:defer_until_turn_boundary:completed_at_boundary',
      'connected-service-account-switch-deferral-superseded:defer_until_idle',
      'connected-service-account-switch-attempt:failed:hot_applied:manual:hot_apply:failed:none:auth_invalid',
      'agent-state-sharing-degraded:pi:enabled:disabled:state_sharing_unavailable',
    ]);
    expect(mutationCustody.stageTranscriptEvent.mock.calls[3]?.[0]?.data).toMatchObject({
      ok: false,
      outcome: 'failed',
      outcomeAction: 'none',
      partialState: 'runtime_auth_partially_applied',
    });
  });

  it('attaches profile and event-carried group labels without giving settings delivery ownership', async () => {
    const mutationCustody = createCustody();
    await commitConnectedServiceAccountSwitchSessionEvent({
      mutationCustody,
      sessionId: 'sess-1',
      event: {
        type: 'connected_service_auth_group_switch',
        serviceId: 'claude-subscription',
        groupId: 'team',
        groupLabel: 'Team Claude',
        fromProfileId: 'old-profile',
        toProfileId: 'new-profile',
        reason: 'usage_limit',
        mode: 'hot_apply',
        generation: 4,
      },
      listConnectedServiceProfiles: async () => ({
        serviceId: 'claude-subscription',
        profiles: [
          { profileId: 'old-profile', displayName: 'Old' },
          { profileId: 'new-profile', displayName: 'New' },
        ],
      }),
    });

    expect(mutationCustody.stageTranscriptEvent).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        groupLabel: 'Team Claude',
        fromProfileLabel: 'Old',
        toProfileLabel: 'New',
        mode: 'hot_apply',
      }),
    }));
  });

  it('suppresses same-profile and background-maintenance switches', async () => {
    const mutationCustody = createCustody();
    for (const event of [
      {
        type: 'connected_service_account_switch',
        serviceId: 'anthropic',
        groupId: null,
        fromProfileId: 'same',
        toProfileId: 'same',
        reason: 'manual',
      },
      {
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'one',
        toProfileId: 'two',
        reason: 'same_provider_account_fanout',
      },
    ]) {
      await commitConnectedServiceAccountSwitchSessionEvent({
        mutationCustody,
        sessionId: 'sess-1',
        event,
      });
    }
    expect(mutationCustody.stageTranscriptEvent).not.toHaveBeenCalled();
  });

  it('propagates journal admission failure instead of reporting a false commit', async () => {
    const mutationCustody = {
      stageTranscriptEvent: vi.fn<StageTranscriptEvent>(async (_input: StageTranscriptEventInput) => {
        throw new Error('journal unavailable');
      }),
    };

    await expect(commitConnectedServiceAccountSwitchSessionEvent({
      mutationCustody,
      sessionId: 'sess-1',
      event: {
        type: 'connected_service_account_switch_deferred',
        policy: 'defer_until_idle',
        awaitingBoundary: false,
        timeoutMs: 30_000,
      },
    })).rejects.toThrow('journal unavailable');
  });

  it('sanitizes provider state-sharing diagnostics before durable admission', async () => {
    const mutationCustody = createCustody();
    await commitConnectedServiceAccountSwitchSessionEvent({
      mutationCustody,
      sessionId: 'sess-1',
      event: {
        type: 'provider_state_sharing_degraded',
        serviceId: 'pi',
        requestedStateMode: 'enabled',
        effectiveStateMode: 'disabled',
        code: 'state_sharing_unavailable',
        reason: 'Provider state sharing unavailable',
        entryName: '/Users/alice/.pi/private-state.json',
      },
    });

    const admitted = mutationCustody.stageTranscriptEvent.mock.calls[0]?.[0];
    expect(JSON.stringify(admitted)).not.toContain('private-state.json');
  });
});
