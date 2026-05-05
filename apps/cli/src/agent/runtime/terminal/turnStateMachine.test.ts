import { describe, expect, it } from 'vitest';

import {
  TERMINAL_COMPLETION_QUIET_WINDOW_MS,
  createTerminalTurnStateMachine,
} from './turnStateMachine';

describe('terminal turn state machine', () => {
  it('promotes a completion candidate only after the quiet window', () => {
    let nowMs = 1_000;
    const machine = createTerminalTurnStateMachine({
      nowMs: () => nowMs,
      quietWindowMs: TERMINAL_COMPLETION_QUIET_WINDOW_MS,
    });

    machine.observe({
      type: 'prompt_submitted',
      agentId: 'codex',
      turnId: 'turn-1',
      source: 'lifecycle_event',
    });
    machine.observe({
      type: 'completion_candidate',
      agentId: 'codex',
      turnId: 'turn-1',
      source: 'hook',
    });

    nowMs += TERMINAL_COMPLETION_QUIET_WINDOW_MS - 1;
    expect(machine.advanceClock()).toMatchObject({ state: 'running', turnId: 'turn-1' });

    nowMs += 1;
    expect(machine.advanceClock()).toMatchObject({
      state: 'idle',
      confidence: 'definite',
      lastTerminal: {
        type: 'completed',
        turnId: 'turn-1',
        source: 'hook',
      },
    });
  });

  it('keeps the turn running when continuation invalidates the completion candidate', () => {
    let nowMs = 10_000;
    const machine = createTerminalTurnStateMachine({
      nowMs: () => nowMs,
      quietWindowMs: TERMINAL_COMPLETION_QUIET_WINDOW_MS,
    });

    machine.observe({
      type: 'prompt_submitted',
      agentId: 'claude',
      turnId: 'turn-2',
      source: 'hook',
    });
    machine.observe({
      type: 'completion_candidate',
      agentId: 'claude',
      turnId: 'turn-2',
      source: 'transcript',
    });
    machine.observe({
      type: 'completion_candidate_invalidated',
      agentId: 'claude',
      turnId: 'turn-2',
      reason: 'continuation',
    });

    nowMs += TERMINAL_COMPLETION_QUIET_WINDOW_MS + 1;
    expect(machine.advanceClock()).toEqual({
      state: 'running',
      turnId: 'turn-2',
      source: 'transcript',
    });
  });

  it('records abort, failure, permission blocking, and unknown exits without treating them as completed', () => {
    const machine = createTerminalTurnStateMachine({ nowMs: () => 1 });

    machine.observe({
      type: 'prompt_submitted',
      agentId: 'codex',
      turnId: 'turn-3',
      source: 'lifecycle_event',
    });
    machine.observe({
      type: 'permission_blocked',
      agentId: 'codex',
      turnId: 'turn-3',
      source: 'lifecycle_event',
    });
    expect(machine.getState()).toMatchObject({ state: 'blocked_on_permission', turnId: 'turn-3' });

    machine.observe({
      type: 'turn_aborted',
      agentId: 'codex',
      turnId: 'turn-3',
      reason: 'user_interrupt',
      detail: 'force_send_now',
      source: 'lifecycle_event',
    });
    expect(machine.getState()).toMatchObject({
      state: 'idle',
      lastTerminal: {
        type: 'aborted',
        reason: 'user_interrupt',
        detail: 'force_send_now',
      },
    });

    machine.observe({
      type: 'prompt_submitted',
      agentId: 'codex',
      turnId: 'turn-4',
      source: 'lifecycle_event',
    });
    machine.observe({
      type: 'turn_failed',
      agentId: 'codex',
      turnId: 'turn-4',
      reason: 'stop_failure_hook',
      source: 'hook',
    });
    expect(machine.getState()).toMatchObject({
      state: 'idle',
      lastTerminal: { type: 'failed', reason: 'stop_failure_hook' },
    });

    machine.observe({
      type: 'prompt_submitted',
      agentId: 'codex',
      turnId: 'turn-5',
      source: 'lifecycle_event',
    });
    machine.observe({
      type: 'process_exited',
      agentId: 'codex',
      exitCode: 143,
      signal: 'SIGTERM',
    });
    expect(machine.getState()).toMatchObject({
      state: 'idle',
      confidence: 'best_effort',
      lastTerminal: { type: 'unknown_exit', exitCode: 143, signal: 'SIGTERM' },
    });
  });
});
