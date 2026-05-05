import { describe, expect, it } from 'vitest';

import { resolvePendingQueueHandoff } from './pendingQueueHandoffOrchestrator';

const completedTerminalState = {
  state: 'idle',
  confidence: 'definite',
  lastTerminal: {
    type: 'completed',
    turnId: 'turn-1',
    source: 'lifecycle_event',
  },
} as const;

describe('pendingQueueHandoffOrchestrator', () => {
  it('lets remote idle mode materialize pending rows through the existing remote prompt loop', () => {
    expect(
      resolvePendingQueueHandoff({
        currentMode: 'remote',
        remoteTurnInFlight: false,
        terminalTopology: 'exclusive',
        terminalTurnState: { state: 'idle', confidence: 'definite' },
        pendingCount: 1,
        resumeReadiness: { ready: true },
        intent: 'queue',
        nowMs: 10,
      }),
    ).toMatchObject({
      action: { type: 'materialize_remote_pending' },
      status: { status: 'none', pendingCount: 1 },
    });
  });

  it('defers exclusive terminal handoff while the terminal turn is active', () => {
    expect(
      resolvePendingQueueHandoff({
        currentMode: 'terminal',
        remoteTurnInFlight: false,
        terminalTopology: 'exclusive',
        terminalTurnState: { state: 'running', turnId: 'turn-2', source: 'lifecycle_event' },
        pendingCount: 2,
        resumeReadiness: { ready: true },
        intent: 'queue',
        nowMs: 20,
      }),
    ).toMatchObject({
      action: { type: 'defer_until_terminal_turn_finishes' },
      status: {
        status: 'deferred_until_terminal_turn_finishes',
        pendingCount: 2,
        interruptRequired: false,
      },
    });
  });

  it('requests a graceful remote handoff after an exclusive terminal boundary when resume identity is ready', () => {
    expect(
      resolvePendingQueueHandoff({
        currentMode: 'terminal',
        remoteTurnInFlight: false,
        terminalTopology: 'exclusive',
        terminalTurnState: completedTerminalState,
        pendingCount: 1,
        resumeReadiness: { ready: true },
        intent: 'queue',
        nowMs: 30,
      }),
    ).toMatchObject({
      action: { type: 'request_graceful_remote_handoff', reason: 'pending_queue_after_terminal_boundary' },
      status: {
        status: 'switching_to_remote',
        pendingCount: 1,
        lastTerminalState: completedTerminalState.lastTerminal,
      },
    });
  });

  it('blocks without dropping pending rows when resume identity is missing', () => {
    expect(
      resolvePendingQueueHandoff({
        currentMode: 'terminal',
        remoteTurnInFlight: false,
        terminalTopology: 'exclusive',
        terminalTurnState: completedTerminalState,
        pendingCount: 3,
        resumeReadiness: { ready: false, detail: 'no runtime session id' },
        intent: 'queue',
        nowMs: 40,
      }),
    ).toMatchObject({
      action: { type: 'block_waiting_for_resume_identity' },
      status: {
        status: 'blocked_waiting_for_resume_identity',
        pendingCount: 3,
        detail: 'no runtime session id',
      },
    });
  });

  it('does not force shared terminal sessions to switch just to drain pending rows', () => {
    expect(
      resolvePendingQueueHandoff({
        currentMode: 'terminal',
        remoteTurnInFlight: false,
        terminalTopology: 'shared',
        terminalTurnState: { state: 'running', source: 'hook' },
        pendingCount: 1,
        resumeReadiness: { ready: true },
        intent: 'queue',
        nowMs: 50,
      }),
    ).toMatchObject({
      action: { type: 'wait_for_remote_loop' },
      status: { status: 'none', pendingCount: 1 },
    });
  });

  it('models force-send during an exclusive terminal turn as interrupting handoff', () => {
    expect(
      resolvePendingQueueHandoff({
        currentMode: 'terminal',
        remoteTurnInFlight: false,
        terminalTopology: 'exclusive',
        terminalTurnState: { state: 'blocked_on_permission', turnId: 'turn-6', source: 'hook' },
        pendingCount: 1,
        resumeReadiness: { ready: true },
        intent: 'force_send_now',
        nowMs: 60,
      }),
    ).toMatchObject({
      action: {
        type: 'cancel_terminal_turn_then_handoff',
        abortReason: 'user_interrupt',
        detail: 'force_send_now',
      },
      status: {
        status: 'switching_to_remote',
        pendingCount: 1,
        interruptRequired: true,
        detail: 'force_send_now',
      },
    });
  });
});
