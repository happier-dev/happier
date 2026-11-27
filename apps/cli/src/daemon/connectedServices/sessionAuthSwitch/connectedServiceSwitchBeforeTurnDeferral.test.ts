import { describe, expect, it, vi } from 'vitest';

import {
  createConnectedServiceSwitchDeferralQueue,
} from './connectedServiceSwitchDeferralQueue';
import {
  applyConnectedServiceGenerationAtTurnEnd,
  requestConnectedServiceSwitchBeforeTurnWithDeferral,
} from './connectedServiceSwitchBeforeTurnDeferral';
import { resolveConnectedServiceCredentialLifecycleDescriptor } from '@/backends/catalog';

describe('requestConnectedServiceSwitchBeforeTurnWithDeferral', () => {
  it('queues an explicit deferral-policy switch until the next turn boundary', async () => {
    const queue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
    });
    const runSwitch = vi.fn(async () => ({ status: 'switched' as const }));
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });

    await expect(requestConnectedServiceSwitchBeforeTurnWithDeferral({
      deferralQueue: queue,
      sessionId: 'sess_1',
      source: 'automatic',
      policy: 'defer_until_turn_boundary',
      target: {
        serviceId: 'anthropic',
        profileId: 'primary',
        groupId: 'main',
        generation: 0,
      },
      runSwitch,
    })).resolves.toEqual({
      status: 'deferred',
      policy: 'defer_until_turn_boundary',
      reason: 'turn_in_flight',
    });

    expect(runSwitch).not.toHaveBeenCalled();

    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
    await vi.waitFor(() => {
      expect(runSwitch).toHaveBeenCalledTimes(1);
    });
  });
});

describe('applyConnectedServiceGenerationAtTurnEnd', () => {
  const target = { serviceId: 'antigravity', profileId: 'second', groupId: 'pool', generation: 4 };

  it('holds a restart-only provider switch until its turn ends, with no forced deadline', async () => {
    vi.useFakeTimers();
    try {
      const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
      const apply = vi.fn(async (_holdUntilTurnEnd: boolean) => ({ ok: true as const }));
      queue.recordTurnLifecycleEvent({ sessionId: 'sess_agy', event: 'prompt_or_steer' });

      const result = await applyConnectedServiceGenerationAtTurnEnd({
        deferralQueue: queue,
        sessionId: 'sess_agy',
        target,
        switchReason: 'manual',
        executionAuthority: 'runtime_recovery',
        runtimeAuthApply: (await resolveConnectedServiceCredentialLifecycleDescriptor('agy')).runtimeAuthApply,
        apply,
      });

      expect(result).toEqual({ status: 'deferred', policy: 'defer_until_turn_boundary', reason: 'turn_in_flight' });
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(apply).not.toHaveBeenCalled();
      expect(queue.isTurnInFlight('sess_agy')).toBe(true);

      queue.recordTurnLifecycleEvent({ sessionId: 'sess_agy', event: 'assistant_message_end' });
      await vi.advanceTimersByTimeAsync(0);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a mid-turn capable provider switch immediately, even mid-turn', async () => {
    for (const agentId of ['codex', 'claude'] as const) {
      const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
      const apply = vi.fn(async (_holdUntilTurnEnd: boolean) => ({ ok: true as const }));
      queue.recordTurnLifecycleEvent({ sessionId: 'sess_live', event: 'prompt_or_steer' });

      await expect(applyConnectedServiceGenerationAtTurnEnd({
        deferralQueue: queue,
        sessionId: 'sess_live',
        target,
        switchReason: 'pre_turn_group_policy',
        executionAuthority: 'runtime_recovery',
        runtimeAuthApply: (await resolveConnectedServiceCredentialLifecycleDescriptor(agentId)).runtimeAuthApply,
        apply,
      })).resolves.toEqual({ ok: true });
      expect(apply).toHaveBeenCalledWith(false);
    }
  });

  it('keeps failure recovery on the existing path for restart-only providers', async () => {
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    const apply = vi.fn(async (_holdUntilTurnEnd: boolean) => ({ ok: true as const }));
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_agy', event: 'prompt_or_steer' });

    await expect(applyConnectedServiceGenerationAtTurnEnd({
      deferralQueue: queue,
      sessionId: 'sess_agy',
      target,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      runtimeAuthApply: (await resolveConnectedServiceCredentialLifecycleDescriptor('agy')).runtimeAuthApply,
      apply,
    })).resolves.toEqual({ ok: true });
    expect(apply).toHaveBeenCalledWith(false);
  });
});
