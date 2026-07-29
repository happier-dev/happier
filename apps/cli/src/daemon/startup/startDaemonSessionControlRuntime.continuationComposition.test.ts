import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createConnectedServiceSwitchDeferralQueue } from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { resolveConnectedServiceContinuationInterruptionForSwitch } from './startDaemonSessionControlRuntime';

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
