import { describe, expect, it } from 'vitest';
import { readSessionStopConfirmationFailure } from './stopConfirmation.js';
import { StopSessionResultSchema } from '../../../sessionStop.js';

describe('Session Stop dependent effects', () => {
  it('reads the daemon retirement failure diagnostics without opening the receipt envelope', () => {
    const failureCause = { phase: 'stop.plain_control_serviceability_retirement', errorClass: 'Error', errorCode: null, httpStatus: null };
    const daemon = StopSessionResultSchema.safeParse({ status: 'incomplete',
      reason: 'terminal_control_serviceability_retirement_failed', failureCause, effectAttempted: true });
    expect(daemon.success).toBe(true);
    expect(StopSessionResultSchema.safeParse({ status: 'incomplete', reason: 'runner_exit_timeout' }).success).toBe(true);
    expect(StopSessionResultSchema.safeParse({ status: 'incomplete', reason: 'runner_exit_timeout', unrelated: true }).success).toBe(false);
  });
  it('retains a retirement failure cause and attempted effect without permitting the dependent effect', () => {
    const failureCause = { phase: 'stop.plain_control_serviceability_retirement', errorClass: 'Error', errorCode: null, httpStatus: null };
    expect(readSessionStopConfirmationFailure('s1', { sessionId: 's1', stopped: false,
      code: 'session_stop_failed', failureCause, effectAttempted: true }))
      .toMatchObject({ ok: false, errorCode: 'session_stop_failed', failureCause, effectAttempted: true });
  });
  it.each([
    { sessionId: 's1', stopped: true },
    { sessionId: 's1', stopped: false, stopOutcome: { status: 'already_stopped', reason: 'no_runtime_session_inactive' } },
  ])('permits a confirmed exact Session', result => {
    expect(readSessionStopConfirmationFailure('s1', result)).toBeNull();
  });
  it.each([
    { sessionId: 'other', stopped: true },
    { sessionId: 's1', stopped: false },
    { success: true },
    null,
  ])('does not advance without exact physical confirmation', result => {
    expect(readSessionStopConfirmationFailure('s1', result)).toMatchObject({ ok: false, errorCode: 'session_stop_unconfirmed' });
  });
  it.each([
    { code: 'session_stop_control_unavailable', recovery: 'retry_when_runtime_available' },
    { code: 'session_stop_requested', recovery: 'wait_for_inactive' },
  ])('retains the Stop owner cause and recovery: $code', ({ code, recovery }) => {
    expect(readSessionStopConfirmationFailure('s1', { sessionId: 's1', stopped: false, code, recovery, message: 'Owner diagnostic' }))
      .toEqual({ ok: false, errorCode: code, error: 'Owner diagnostic', details: { sessionId: 's1', recovery } });
  });
});
