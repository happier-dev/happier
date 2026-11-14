import { describe, expect, it } from 'vitest';
import { resolveSessionStopAbsenceOutcome } from './sessionStop.js';

describe('resolveSessionStopAbsenceOutcome', () => {
  it('confirms daemon absence only with an authoritative inactive Session', () => {
    expect(resolveSessionStopAbsenceOutcome({ sessionInactive: true, targetKind: 'owning_machine' }))
      .toEqual({ status: 'already_stopped', reason: 'no_runtime_session_inactive' });
  });

  it.each([false, null])('preserves unconfirmed physical stop when inactive is %s', sessionInactive => {
    expect(resolveSessionStopAbsenceOutcome({ sessionInactive, targetKind: 'owning_machine' }))
      .toEqual({ status: 'physical_stop_unconfirmed', reason: 'target_session_not_found' });
    expect(resolveSessionStopAbsenceOutcome({ sessionInactive, targetKind: 'caller_local' }))
      .toEqual({ status: 'physical_stop_unconfirmed', reason: 'local_session_not_found' });
  });
});
