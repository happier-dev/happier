import { describe, expect, it } from 'vitest';
import { readSessionStopConfirmationFailure } from './stopConfirmation.js';

describe('Session Stop dependent effects', () => {
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
