import { describe, expect, it } from 'vitest';

import {
  resolvePendingQueueHandoff,
  type ResolvePendingQueueHandoffInput,
} from './pendingQueueHandoffOrchestrator';

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

  it('injects pending input into an active terminal only when explicit injection capability is ready', () => {
    const input: ResolvePendingQueueHandoffInput & {
      terminalPromptInjectionAvailable: true;
      terminalInputReadiness: {
        status: 'writable';
        observedAt: number;
        activeTurnId: string;
        duplicateRisk: 'none';
      };
    } = {
      currentMode: 'terminal',
      remoteTurnInFlight: false,
      terminalTopology: 'shared',
      terminalTurnState: { state: 'running', turnId: 'turn-7', source: 'hook' },
      pendingCount: 1,
      resumeReadiness: { ready: true },
      intent: 'queue',
      nowMs: 70,
      terminalPromptInjectionAvailable: true,
      terminalInputReadiness: {
        status: 'writable',
        observedAt: 70,
        activeTurnId: 'turn-7',
        duplicateRisk: 'none',
      },
    };

    expect(
      resolvePendingQueueHandoff(input),
    ).toMatchObject({
      action: { type: 'inject_pending_into_active_terminal' },
      status: {
        status: 'none',
        pendingCount: 1,
      },
    });
  });

  it('defers terminal-only pending input while provider acceptance is ambiguous', () => {
    const input: ResolvePendingQueueHandoffInput & {
      terminalPromptInjectionAvailable: true;
      terminalInputReadiness: {
        status: 'awaiting_provider_acceptance';
        observedAt: number;
        activeTurnId: string;
        pendingPromptId: string;
        duplicateRisk: 'possible';
      };
    } = {
      currentMode: 'terminal',
      remoteTurnInFlight: false,
      terminalTopology: 'shared',
      terminalTurnState: { state: 'running', turnId: 'turn-8', source: 'hook' },
      pendingCount: 1,
      resumeReadiness: { ready: true },
      intent: 'queue',
      nowMs: 80,
      terminalPromptInjectionAvailable: true,
      terminalInputReadiness: {
        status: 'awaiting_provider_acceptance',
        observedAt: 80,
        activeTurnId: 'turn-8',
        pendingPromptId: 'prompt-8',
        duplicateRisk: 'possible',
      },
    };

    expect(
      resolvePendingQueueHandoff(input),
    ).toMatchObject({
      action: { type: 'defer_terminal_input', reason: 'awaiting_provider_acceptance' },
      status: {
        status: 'deferred_until_terminal_turn_finishes',
        pendingCount: 1,
        detail: 'awaiting_provider_acceptance',
      },
    });
  });

  it('requires explicit user action for ambiguous terminal injection failures', () => {
    const input: ResolvePendingQueueHandoffInput & {
      terminalPromptInjectionAvailable: true;
      terminalInputReadiness: {
        status: 'failed_ambiguous';
        observedAt: number;
        activeTurnId: string;
        pendingPromptId: string;
        duplicateRisk: 'likely';
        recoverable: true;
      };
    } = {
      currentMode: 'terminal',
      remoteTurnInFlight: false,
      terminalTopology: 'shared',
      terminalTurnState: { state: 'running', turnId: 'turn-9', source: 'hook' },
      pendingCount: 1,
      resumeReadiness: { ready: true },
      intent: 'queue',
      nowMs: 90,
      terminalPromptInjectionAvailable: true,
      terminalInputReadiness: {
        status: 'failed_ambiguous',
        observedAt: 90,
        activeTurnId: 'turn-9',
        pendingPromptId: 'prompt-9',
        duplicateRisk: 'likely',
        recoverable: true,
      },
    };

    expect(
      resolvePendingQueueHandoff(input),
    ).toMatchObject({
      action: { type: 'require_user_action', reason: 'failed_ambiguous' },
      status: {
        status: 'manual_action_required',
        pendingCount: 1,
        detail: 'failed_ambiguous',
      },
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
