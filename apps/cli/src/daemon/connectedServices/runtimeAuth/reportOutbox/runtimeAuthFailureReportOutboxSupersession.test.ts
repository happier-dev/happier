import { describe, expect, it, vi } from 'vitest';

import {
  clearRuntimeAuthFailureReportOutboxForSupersession,
  shouldClearRuntimeAuthFailureReportOutboxForSupersession,
} from './runtimeAuthFailureReportOutboxSupersession';

describe('runtimeAuthFailureReportOutboxSupersession', () => {
  it('clears stale reports when the interrupted turn is cancelled', () => {
    expect(shouldClearRuntimeAuthFailureReportOutboxForSupersession({
      kind: 'turn_lifecycle',
      event: 'turn_cancelled',
    })).toBe(true);
  });

  it.each([
    ['task_started'],
    ['assistant_message_end'],
  ] as const)('keeps reports when turn lifecycle event is not an explicit cancellation: %s', (event) => {
    expect(shouldClearRuntimeAuthFailureReportOutboxForSupersession({
      kind: 'turn_lifecycle',
      event,
    })).toBe(false);
  });

  it('clears stale reports when newer user input is accepted for the session', () => {
    expect(shouldClearRuntimeAuthFailureReportOutboxForSupersession({
      kind: 'turn_lifecycle',
      event: 'prompt_or_steer',
    })).toBe(true);
  });

  it('clears stale reports for explicit manual session supersession', () => {
    expect(shouldClearRuntimeAuthFailureReportOutboxForSupersession({
      kind: 'manual_session_supersession',
      reason: 'stop',
    })).toBe(true);
  });

  it('removes matching session reports only when the supersession policy applies', async () => {
    const removeForSession = vi.fn(async () => {});

    await clearRuntimeAuthFailureReportOutboxForSupersession({
      sessionId: 'sess_1',
      event: { kind: 'turn_lifecycle', event: 'turn_cancelled' },
      removeForSession,
    });
    await clearRuntimeAuthFailureReportOutboxForSupersession({
      sessionId: 'sess_2',
      event: { kind: 'turn_lifecycle', event: 'task_started' },
      removeForSession,
    });
    await clearRuntimeAuthFailureReportOutboxForSupersession({
      sessionId: 'sess_3',
      event: { kind: 'turn_lifecycle', event: 'prompt_or_steer' },
      removeForSession,
    });

    expect(removeForSession).toHaveBeenCalledTimes(2);
    expect(removeForSession).toHaveBeenCalledWith('sess_1');
    expect(removeForSession).toHaveBeenCalledWith('sess_3');
  });
});
