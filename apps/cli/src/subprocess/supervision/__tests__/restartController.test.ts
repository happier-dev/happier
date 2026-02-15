import { describe, expect, it } from 'vitest';

import { RestartController } from '../restartController';

describe('RestartController', () => {
  it('does not restart when stop was requested', () => {
    const controller = new RestartController(
      { mode: 'on_unexpected_exit', maxRestarts: 10, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
      { random: () => 0 },
    );
    controller.markStopRequested({ reason: 'user_request', requestedAtMs: Date.now() });
    const decision = controller.nextDecisionForTermination({ type: 'exited', code: 1 });
    expect(decision).toEqual({ type: 'no_restart', reason: 'stop_requested:user_request' });
  });

  it('enforces maxRestarts', () => {
    const controller = new RestartController(
      { mode: 'on_unexpected_exit', maxRestarts: 1, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
      { random: () => 0 },
    );
    expect(controller.nextDecisionForTermination({ type: 'exited', code: 1 }).type).toBe('restart_after_delay');
    expect(controller.nextDecisionForTermination({ type: 'exited', code: 1 })).toEqual({
      type: 'no_restart',
      reason: 'max_restarts_exceeded:1',
    });
  });
});

