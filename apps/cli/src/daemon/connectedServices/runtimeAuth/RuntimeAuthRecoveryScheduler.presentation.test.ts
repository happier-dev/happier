import { describe, expect, it, vi } from 'vitest';

import { DaemonSessionMutationAdmissionError } from '../usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { RuntimeAuthRecoveryScheduler, type RuntimeAuthRecoveryVisibleEventDelivery } from './RuntimeAuthRecoveryScheduler';

describe('runtime-auth background presentation admission', () => {
  it('parks an unavailable receiver without polling and delivers retained custody after an explicit wake', async () => {
    vi.useFakeTimers();
    let accepts = false;
    let requests = 0;
    let admitted = 0;
    let providerCalls = 0;
    const sessionId = 'session-presentation';
    const otherSessionId = 'other-parked-session';
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => Date.now(),
      recover: async () => { providerCalls += 1; throw new Error('No provider deadline in this fixture'); },
    });
    // Delivery is the external Session receiver boundary; all scheduler/intent logic is real.
    const deliver = async (delivery: RuntimeAuthRecoveryVisibleEventDelivery) => {
      requests += 1;
      if (!accepts || delivery.sessionId !== sessionId) throw new DaemonSessionMutationAdmissionError('session_unavailable');
      admitted += 1;
    };
    try {
      for (const id of [sessionId, otherSessionId]) {
        await scheduler.beginClassifiedFailure({
          reportId: `runtime-auth-report:${id}`, sessionId: id, switchesThisTurn: 0,
          classification: { kind: 'usage_limit', serviceId: 'happier.agent.codex/openai-codex',
            profileId: 'fixture', groupId: null, resetsAtMs: null, planType: null,
            rateLimits: null, source: 'structured_provider_error' },
        });
        await scheduler.cancel({ sessionId: id });
      }
      expect(scheduler.readForSession(sessionId)[0]).toMatchObject({ status: 'cancelled', nextRetryAtMs: null });
      scheduler.schedulePendingVisibleEventDrain({ deliver, delayMs: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(2);
      const before = requests;
      await vi.advanceTimersByTimeAsync(60_000);
      const idleRequests = requests - before;
      expect(scheduler.readForSession(sessionId)[0].pendingVisibleEvents?.length).toBeGreaterThan(0);
      scheduler.wakePendingVisibleEventDrain('unrelated-session');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests - before).toBe(idleRequests);
      accepts = true;
      scheduler.wakePendingVisibleEventDrain(sessionId);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(admitted).toBe(1);
      expect(scheduler.readForSession(sessionId)[0].pendingVisibleEvents ?? []).toEqual([]);
      expect(scheduler.readForSession(otherSessionId)[0].pendingVisibleEvents?.length).toBeGreaterThan(0);
      const settled = requests;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toBe(settled);
      expect(providerCalls).toBe(0);
      expect(idleRequests).toBe(0);
    } finally {
      scheduler.dispose();
      vi.useRealTimers();
    }
  });
});
