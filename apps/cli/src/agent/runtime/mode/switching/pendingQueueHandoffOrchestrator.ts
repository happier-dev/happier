import type {
  TerminalInputReadinessV1,
  TerminalInputReadinessStatusV1,
} from '@happier-dev/agents';
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
  | Readonly<{ type: 'inject_pending_into_active_terminal' }>
  | Readonly<{ type: 'defer_terminal_input'; reason: TerminalInputReadinessStatusV1 }>
  | Readonly<{ type: 'relaunch_terminal_with_pending'; reason: TerminalInputReadinessStatusV1 }>
  | Readonly<{ type: 'surface_runtime_issue'; reason: TerminalInputReadinessStatusV1 }>
  | Readonly<{ type: 'require_user_action'; reason: TerminalInputReadinessStatusV1 }>
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
  terminalPromptInjectionAvailable?: boolean;
  terminalInputReadiness?: TerminalInputReadinessV1 | null;
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

function createTerminalInputDeferralStatus(
  status: TerminalInputReadinessStatusV1,
  pendingCount: number,
  updatedAtMs: number,
): TerminalPendingHandoffStateV1 {
  return createStatus({
    status: 'deferred_until_terminal_turn_finishes',
    pendingCount,
    updatedAtMs,
    interruptRequired: false,
    detail: status,
  });
}

function resolveTerminalInputAction(
  readiness: TerminalInputReadinessV1,
): Exclude<PendingQueueHandoffAction, { type: 'none' | 'materialize_remote_pending' | 'wait_for_remote_loop' | 'defer_until_terminal_turn_finishes' | 'block_waiting_for_resume_identity' | 'request_graceful_remote_handoff' | 'cancel_terminal_turn_then_handoff' }> {
  switch (readiness.status) {
    case 'writable':
      return { type: 'inject_pending_into_active_terminal' };
    case 'failed_retryable':
      return { type: 'relaunch_terminal_with_pending', reason: readiness.status };
    case 'failed_ambiguous':
      return { type: 'require_user_action', reason: readiness.status };
    case 'failed_terminal':
      return { type: 'surface_runtime_issue', reason: readiness.status };
    case 'defer_finalizing':
    case 'defer_permission':
    case 'defer_user_typing':
    case 'defer_host_not_ready':
    case 'defer_liveness_uncertain':
    case 'defer_provider_starting':
    case 'awaiting_provider_acceptance':
      return { type: 'defer_terminal_input', reason: readiness.status };
  }
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
    if (input.terminalPromptInjectionAvailable === true && input.terminalInputReadiness) {
      const action = resolveTerminalInputAction(input.terminalInputReadiness);
      switch (action.type) {
        case 'inject_pending_into_active_terminal':
          return {
            action,
            status: createStatus({
              status: 'none',
              pendingCount,
              updatedAtMs: input.nowMs,
            }),
          };
        case 'defer_terminal_input':
          return {
            action,
            status: createTerminalInputDeferralStatus(action.reason, pendingCount, input.nowMs),
          };
        case 'relaunch_terminal_with_pending':
          return {
            action,
            status: createStatus({
              status: 'manual_action_required',
              pendingCount,
              updatedAtMs: input.nowMs,
              detail: action.reason,
            }),
          };
        case 'surface_runtime_issue':
        case 'require_user_action':
          return {
            action,
            status: createStatus({
              status: 'manual_action_required',
              pendingCount,
              updatedAtMs: input.nowMs,
              detail: action.reason,
            }),
          };
      }
    }

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
