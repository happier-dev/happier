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


describe('RestartController intended-restart accounting (RR-2 cross-cycle)', () => {
  it('survives resetCrashBudget (N+1th refused) and never consumes the crash budget', () => {
    let nowMs = 1_000_000;
    const controller = new RestartController(
      {
        mode: 'on_unexpected_exit',
        maxRestarts: 3,
        maxIntendedRestarts: 2,
        intendedRestartWindowMs: 30 * 60_000,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterMs: 0,
      },
      { random: () => 0, now: () => nowMs },
    );

    // Two intended restarts within the window; each cycle ENDS SUCCESSFULLY (crash budget reset).
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    controller.resetCrashBudget();
    nowMs += 60_000;
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    controller.resetCrashBudget();
    nowMs += 60_000;

    // Third intended restart within the window is refused DESPITE the successful cycles.
    expect(controller.nextDecisionForIntendedRestart()).toEqual({
      type: 'no_restart',
      reason: 'max_intended_restarts_exceeded:2',
    });
    expect(controller.hasRecentIntendedRestarts()).toBe(true);

    // The generic crash budget is untouched by intended accounting: a genuine crash still restarts.
    expect(controller.nextDecisionForTermination({ type: 'exited', code: 1 }).type).toBe('restart_after_delay');
  });

  it('window decay re-allows occasional intended restarts', () => {
    let nowMs = 1_000_000;
    const controller = new RestartController(
      {
        mode: 'on_unexpected_exit',
        maxRestarts: 3,
        maxIntendedRestarts: 2,
        intendedRestartWindowMs: 10 * 60_000,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterMs: 0,
      },
      { random: () => 0, now: () => nowMs },
    );

    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    expect(controller.nextDecisionForIntendedRestart().type).toBe('no_restart');

    // After the window passes, occasional restarts decay out of the budget and are allowed again.
    nowMs += 10 * 60_000 + 1;
    expect(controller.hasRecentIntendedRestarts()).toBe(false);
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
  });
});
