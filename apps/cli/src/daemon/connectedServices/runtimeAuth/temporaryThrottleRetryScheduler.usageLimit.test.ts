import { describe, expect, it, vi } from 'vitest';

import { createConnectedServiceContinuationMessageDispatcher } from '../continuation/createConnectedServiceContinuationMessageDispatcher';
import { ConnectedServiceTemporaryThrottleRetryScheduler } from './temporaryThrottleRetryScheduler';
import type { SessionUsageLimitRecoveryReadinessProbeResult } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';

describe('temporary usage-limit continuation readiness', () => {
  it('keeps Stop effective when a pending quota check later reports ready', async () => {
    const rows = new Map<string, unknown>();
    const prompts: string[] = [];
    let finishProbe!: (result: SessionUsageLimitRecoveryReadinessProbeResult) => void;
    let started!: () => void;
    const probeStarted = new Promise<void>(resolve => { started = resolve; });
    const probe = new Promise<SessionUsageLimitRecoveryReadinessProbeResult>(resolve => { finishProbe = resolve; });
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({
      credentials: { token: 'dummy-cancelled-continuation', encryption: null },
      sendMessage: async input => {
        prompts.push(input.message);
        return { ok: true, sessionId: input.idOrPrefix, localId: input.localId!, waited: false,
          admissionResult: { status: 'accepted', localId: input.localId! } };
      },
    });
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: Date.now,
      store: { read: key => rows.get(key) ?? null, write: (key, value) => { rows.set(key, value); } },
      readUsageLimitReadiness: async () => { started(); return await probe; },
      resume: async intent => {
        await dispatcher.enqueueInterruptedOriginContinuation({ sessionId: intent.sessionId,
          attemptId: intent.issueFingerprint, interruptedOriginId: intent.continuation!.interruptedOriginId,
          interruption: 'provider_failed_turn', resumePromptMode: 'standard', recoveryKind: 'usage_limit' });
        return { status: 'continued' };
      },
    });
    try {
      await scheduler.enable({ sessionId: 'cancelled-session', serviceId: 'service', profileId: 'account',
        groupId: null, issueFingerprint: 'usage-limit', continuation: { interruptedOriginId: 'failed-turn',
          resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'usage_limit' } });
      const wake = scheduler.wake({ sessionId: 'cancelled-session', reason: 'manual' });
      await probeStarted;
      await scheduler.cancel({ sessionId: 'cancelled-session' });
      finishProbe({ status: 'ready' });
      await wake;
      expect(prompts).toHaveLength(0);
      expect(scheduler.read('cancelled-session')?.status).toBe('cancelled');
    } finally { finishProbe({ status: 'ready' }); scheduler.dispose(); }
  });

  it.each([true, false])('sends zero prompts for unchanged exhaustion, then one after readiness (reset known=%s)', async knownReset => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const rows = new Map<string, unknown>();
    const prompts: string[] = [];
    let ready = false;
    let probes = 0;
    const resetAtMs = Date.now() + 5 * 24 * 60 * 60 * 1_000;
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({
      credentials: { token: 'dummy-continuation', encryption: null },
      // Pending transport is the external boundary; prompt construction remains real.
      sendMessage: async input => {
        prompts.push(input.message);
        return { ok: true, sessionId: 'limited-session', localId: input.localId!, waited: false,
          admissionResult: { status: 'accepted', localId: input.localId! } };
      },
    });
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: Date.now,
      store: { read: key => rows.get(key) ?? null, write: (key, value) => { rows.set(key, value); } },
      // Native quota SDK is the external boundary, including a provider reset five days away.
      readUsageLimitReadiness: async (): Promise<SessionUsageLimitRecoveryReadinessProbeResult> => {
        probes += 1;
        return ready ? { status: 'ready' } : { status: 'waiting',
          ...(knownReset ? { retryAfterMs: resetAtMs - Date.now() } : {}) };
      },
      resume: async intent => {
        await dispatcher.enqueueInterruptedOriginContinuation({ sessionId: intent.sessionId,
          attemptId: intent.issueFingerprint, interruptedOriginId: intent.continuation!.interruptedOriginId,
          interruption: 'provider_failed_turn', resumePromptMode: 'standard', recoveryKind: 'usage_limit' });
        return { status: 'continued' };
      },
    });
    const failure = (origin: string) => scheduler.enable({ sessionId: 'limited-session', serviceId: 'service',
      profileId: 'exhausted-account', groupId: null, issueFingerprint: 'usage-limit',
      continuation: { interruptedOriginId: origin, resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'usage_limit' } });
    try {
      for (let turn = 0; turn < 3; turn += 1) {
        await failure(`failed-turn-${turn}`);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(prompts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000);
      expect(prompts).toHaveLength(0);
      if (knownReset) {
        expect(probes).toBe(3);
        expect(scheduler.read('limited-session')?.nextRetryAtMs).toBe(resetAtMs);
      }
      ready = true;
      await vi.advanceTimersByTimeAsync(knownReset ? resetAtMs - Date.now() : 60_000);
      expect(prompts).toEqual(['Continue where you left off']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(prompts).toHaveLength(1);
    } finally { scheduler.dispose(); vi.useRealTimers(); }
  });
});
