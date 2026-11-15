// Adapted from generalaction/emdash keystroke-injection patterns
// © 2026 General Action, Inc. Apache-2.0

import type { TerminalInputInjectionResult, TerminalTurnState } from '../_types';

export const TERMINAL_INPUT_QUIET_PERIOD_MS = 800;
export const TERMINAL_INPUT_MAX_WAIT_MS = 15_000;
/**
 * Input held because the provider's terminal turn is running is normally released by that turn's
 * end signal. This bounded fallback re-checks the provider even if the signal never arrives, so
 * held input cannot starve; it keeps waiting while the provider still reports a running turn.
 */
export const TERMINAL_INPUT_BUSY_TURN_FALLBACK_WAKE_MS = 15_000;

export type TerminalInjectionReadinessState = Readonly<{
  nowMs: number;
  firstObservedAtMs: number;
  outputObserved: boolean;
  lastOutputAtMs: number | null;
  permissionBlocked: boolean;
  turnState: TerminalTurnState;
  userTyping: boolean;
  userTypingObservedAtMs?: number | null | undefined;
}>;

export type TerminalInjectionReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{
      ready: false;
      reason: Extract<TerminalInputInjectionResult, { status: 'deferred' }>['reason'] | 'timeout';
      retryAfterMs?: number | undefined;
    }>;

export function resolveTerminalInjectionReadiness(
  state: TerminalInjectionReadinessState,
  opts?: Readonly<{
    quietPeriodMs?: number | undefined;
    maxWaitMs?: number | undefined;
  }>,
): TerminalInjectionReadiness {
  const quietPeriodMs = Math.max(0, Math.trunc(opts?.quietPeriodMs ?? TERMINAL_INPUT_QUIET_PERIOD_MS));
  const maxWaitMs = Math.max(0, Math.trunc(opts?.maxWaitMs ?? TERMINAL_INPUT_MAX_WAIT_MS));

  if (state.permissionBlocked || state.turnState === 'blocked_on_permission') {
    return { ready: false, reason: 'permission_blocked' };
  }

  if (state.turnState === 'finalizing') {
    return { ready: false, reason: 'pane_initializing' };
  }

  if (state.userTyping) {
    const userTypingObservedAtMs = state.userTypingObservedAtMs ?? state.firstObservedAtMs;
    const userTypingForMs = Math.max(0, state.nowMs - userTypingObservedAtMs);
    if (userTypingForMs < maxWaitMs) {
      return { ready: false, reason: 'user_typing', retryAfterMs: maxWaitMs - userTypingForMs };
    }
  }

  if (!state.outputObserved || state.lastOutputAtMs === null) {
    return state.nowMs - state.firstObservedAtMs > maxWaitMs
      ? { ready: false, reason: 'timeout' }
      : { ready: false, reason: 'pane_initializing' };
  }

  const quietForMs = state.nowMs - state.lastOutputAtMs;
  if (quietForMs < quietPeriodMs) {
    return { ready: false, reason: 'pane_initializing', retryAfterMs: quietPeriodMs - quietForMs };
  }

  return { ready: true };
}
