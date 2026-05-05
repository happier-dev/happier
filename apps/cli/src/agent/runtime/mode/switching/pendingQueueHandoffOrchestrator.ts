import type {
  TerminalPendingHandoffStateV1,
  TerminalTurnState,
  TerminalTurnTerminalState,
} from '@/agent/runtime/terminal/_types';

export type PendingQueueHandoffMode = 'remote' | 'terminal';
export type PendingQueueHandoffTopology = 'exclusive' | 'shared';
export type PendingQueueHandoffIntent = 'queue' | 'switch_now' | 'force_send_now';

export type PendingQueueResumeReadiness = Readonly<{
  ready: boolean;
  detail?: string;
}>;

export type PendingQueueHandoffAction =
  | Readonly<{ type: 'none' }>
  | Readonly<{ type: 'materialize_remote_pending' }>
  | Readonly<{ type: 'wait_for_remote_loop' }>
  | Readonly<{ type: 'defer_until_terminal_turn_finishes' }>
  | Readonly<{ type: 'block_waiting_for_resume_identity' }>
  | Readonly<{ type: 'request_graceful_remote_handoff'; reason: 'pending_queue_after_terminal_boundary' | 'switch_now' }>
  | Readonly<{
      type: 'cancel_terminal_turn_then_handoff';
      abortReason: 'user_interrupt';
      detail: 'force_send_now';
    }>;

export type PendingQueueHandoffDecision = Readonly<{
  action: PendingQueueHandoffAction;
  status: TerminalPendingHandoffStateV1;
}>;

export type ResolvePendingQueueHandoffInput = Readonly<{
  currentMode: PendingQueueHandoffMode;
  remoteTurnInFlight: boolean;
  terminalTopology: PendingQueueHandoffTopology | null;
  terminalTurnState: TerminalTurnState;
  pendingCount: number;
  resumeReadiness: PendingQueueResumeReadiness;
  intent: PendingQueueHandoffIntent;
  nowMs: number;
}>;

function normalizePendingCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function createStatus(params: Readonly<{
  status: TerminalPendingHandoffStateV1['status'];
  pendingCount: number;
  updatedAtMs: number;
  lastTerminalState?: TerminalTurnTerminalState;
  interruptRequired?: boolean;
  detail?: string;
}>): TerminalPendingHandoffStateV1 {
  return {
    v: 1,
    status: params.status,
    pendingCount: params.pendingCount,
    updatedAtMs: params.updatedAtMs,
    ...(params.lastTerminalState ? { lastTerminalState: params.lastTerminalState } : {}),
    ...(typeof params.interruptRequired === 'boolean' ? { interruptRequired: params.interruptRequired } : {}),
    ...(params.detail ? { detail: params.detail } : {}),
  };
}

function lastTerminalState(state: TerminalTurnState): TerminalTurnTerminalState | undefined {
  return state.state === 'idle' ? state.lastTerminal : undefined;
}

function isTerminalActive(state: TerminalTurnState): boolean {
  return state.state === 'running' || state.state === 'blocked_on_permission' || state.state === 'unknown';
}

export function resolvePendingQueueHandoff(input: ResolvePendingQueueHandoffInput): PendingQueueHandoffDecision {
  const pendingCount = normalizePendingCount(input.pendingCount);
  if (pendingCount === 0) {
    return {
      action: { type: 'none' },
      status: createStatus({
        status: 'none',
        pendingCount: 0,
        updatedAtMs: input.nowMs,
      }),
    };
  }

  if (input.currentMode === 'remote') {
    if (input.remoteTurnInFlight && input.intent !== 'force_send_now' && input.intent !== 'switch_now') {
      return {
        action: { type: 'defer_until_terminal_turn_finishes' },
        status: createStatus({
          status: 'deferred_until_terminal_turn_finishes',
          pendingCount,
          updatedAtMs: input.nowMs,
        }),
      };
    }
    return {
      action: { type: 'materialize_remote_pending' },
      status: createStatus({
        status: 'none',
        pendingCount,
        updatedAtMs: input.nowMs,
      }),
    };
  }

  if (input.terminalTopology === 'shared') {
    return {
      action: { type: 'wait_for_remote_loop' },
      status: createStatus({
        status: 'none',
        pendingCount,
        updatedAtMs: input.nowMs,
      }),
    };
  }

  if (input.intent === 'force_send_now' && isTerminalActive(input.terminalTurnState)) {
    return {
      action: {
        type: 'cancel_terminal_turn_then_handoff',
        abortReason: 'user_interrupt',
        detail: 'force_send_now',
      },
      status: createStatus({
        status: 'switching_to_remote',
        pendingCount,
        updatedAtMs: input.nowMs,
        interruptRequired: true,
        detail: 'force_send_now',
      }),
    };
  }

  if (isTerminalActive(input.terminalTurnState)) {
    return {
      action: { type: 'defer_until_terminal_turn_finishes' },
      status: createStatus({
        status: 'deferred_until_terminal_turn_finishes',
        pendingCount,
        updatedAtMs: input.nowMs,
        interruptRequired: false,
      }),
    };
  }

  if (!input.resumeReadiness.ready) {
    return {
      action: { type: 'block_waiting_for_resume_identity' },
      status: createStatus({
        status: 'blocked_waiting_for_resume_identity',
        pendingCount,
        updatedAtMs: input.nowMs,
        lastTerminalState: lastTerminalState(input.terminalTurnState),
        detail: input.resumeReadiness.detail,
      }),
    };
  }

  return {
    action: {
      type: 'request_graceful_remote_handoff',
      reason: input.intent === 'switch_now' ? 'switch_now' : 'pending_queue_after_terminal_boundary',
    },
    status: createStatus({
      status: 'switching_to_remote',
      pendingCount,
      updatedAtMs: input.nowMs,
      lastTerminalState: lastTerminalState(input.terminalTurnState),
    }),
  };
}
