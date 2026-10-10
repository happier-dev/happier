import { describe, expect, it } from 'vitest';

import { RuntimeAuthRecoveryScheduler } from './RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthRecoveryKey } from './recoveryKey/runtimeAuthRecoveryKey';
import { checkRuntimeAuthUsageLimitRecovery } from './checkRuntimeAuthUsageLimitRecovery';

describe('checkRuntimeAuthUsageLimitRecovery', () => {
  it('reports matching provider proof that arrives while a manual handoff is in flight', async () => {
    let signalStarted!: () => void;
    let finishHandoff!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const handoff = new Promise<void>((resolve) => { finishHandoff = resolve; });
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 1000,
      recover: async () => ({}),
      continueAfterUsageLimitReset: async () => {
        signalStarted(); await handoff;
        return { ok: true, status: 'continuation_enqueued' };
      },
    });
    try {
      const classification = { kind: 'usage_limit' as const, serviceId: 'claude-subscription', profileId: 'work',
        groupId: null, resetsAtMs: 1000, planType: null, rateLimits: null, source: 'structured_provider_error' as const };
      const begun = await scheduler.beginClassifiedFailure({ sessionId: 'fast-provider', switchesThisTurn: 0, classification });
      if (!begun.attemptId) throw new Error('Expected armed attempt');
      const check = checkRuntimeAuthUsageLimitRecovery({ scheduler, sessionId: 'fast-provider', attemptId: begun.attemptId });
      await started;
      await scheduler.markProviderOutcomeProofByKey({
        recoveryKey: buildRuntimeAuthRecoveryKey({ sessionId: 'fast-provider', ...classification }), proofKind: 'provider_activity',
      });
      finishHandoff();
      expect(await check).toEqual({ ok: true, status: 'resumed' });
    } finally { finishHandoff(); scheduler.dispose(); }
  });
});
