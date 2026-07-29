/**
 * Restart controller.
 *
 * Centralizes:
 * - stop-request suppression (never restart when stop was requested),
 * - max restart attempt accounting,
 * - delay/backoff calculation inputs.
 */

import { computeRestartDelayMs } from './backoff';
import type { ManagedProcessRestartPolicy, StopRequest, TerminationEvent } from './types';
import { isUnexpectedTermination } from './exitClassifier';

export type RestartDecision =
  | Readonly<{ type: 'no_restart'; reason: string }>
  | Readonly<{ type: 'restart_after_delay'; attempt: number; delayMs: number }>;

/**
 * Default cap for INTENDED restarts (connected-service-initiated relaunches) when the policy leaves
 * `maxIntendedRestarts` unset. Bounded so an intended-restart storm can never run away, while being
 * generous enough for legitimate switch/refresh churn.
 */
export const DEFAULT_MAX_INTENDED_RESTARTS = 20;

/**
 * Default rolling window for intended-restart accounting (RR-2 cross-cycle): intended restarts
 * within the window count against the budget even across SUCCESSFUL respawns; older restarts decay
 * out so occasional restarts spread over time never trip the limiter.
 */
export const DEFAULT_INTENDED_RESTART_WINDOW_MS = 30 * 60_000;

export class RestartController {
  private stopRequest: StopRequest | null = null;
  private restartAttempt = 0;
  private intendedRestartTimesMs: number[] = [];

  constructor(
    private readonly policy: ManagedProcessRestartPolicy,
    private readonly deps: Readonly<{ random: () => number; now?: () => number }>,
  ) {}

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  private pruneIntendedRestartWindow(nowMs: number): void {
    const windowMs = this.policy.mode === 'on_unexpected_exit'
      && typeof this.policy.intendedRestartWindowMs === 'number'
      ? Math.max(0, Math.trunc(this.policy.intendedRestartWindowMs))
      : DEFAULT_INTENDED_RESTART_WINDOW_MS;
    this.intendedRestartTimesMs = this.intendedRestartTimesMs.filter(
      (atMs) => nowMs - atMs < windowMs,
    );
  }

  markStopRequested(request: StopRequest): void {
    this.stopRequest = request;
  }

  clearStopRequested(): void {
    this.stopRequest = null;
  }

  reset(): void {
    this.restartAttempt = 0;
    this.intendedRestartTimesMs = [];
    this.stopRequest = null;
  }

  /**
   * Ends a respawn cycle after a SUCCESSFUL spawn: the generic crash budget starts fresh (matching
   * the historical delete-on-success semantics), but the intended-restart rolling window survives —
   * intended accounting must span successful respawns or a successful restart loop is unbounded
   * across cycles (RR-2 cross-cycle, the incident-#1 restart-loop shape).
   */
  resetCrashBudget(): void {
    this.restartAttempt = 0;
  }

  /** Whether any intended restarts remain inside the rolling window (drives state retention). */
  hasRecentIntendedRestarts(): boolean {
    this.pruneIntendedRestartWindow(this.nowMs());
    return this.intendedRestartTimesMs.length > 0;
  }

  /**
   * Decision for an INTENDED restart (a connected-service-initiated relaunch, e.g. an auth-group
   * switch or refresh-triggered restart). These are deliberately requested, not crash symptoms, so
   * they run on a SEPARATE budget and never consume the generic crash counter (RR-2). A stop
   * request still vetoes them; the rolling window bounds an intended-restart storm even when every
   * individual respawn SUCCEEDS, while letting occasional restarts decay out of the budget.
   */
  nextDecisionForIntendedRestart(): RestartDecision {
    if (this.policy.mode === 'never') {
      return { type: 'no_restart', reason: 'restart_policy_never' };
    }

    if (this.stopRequest) {
      return { type: 'no_restart', reason: `stop_requested:${this.stopRequest.reason}` };
    }

    const nowMs = this.nowMs();
    this.pruneIntendedRestartWindow(nowMs);

    const maxIntendedRestarts = this.policy.maxIntendedRestarts === undefined
      ? DEFAULT_MAX_INTENDED_RESTARTS
      : this.policy.maxIntendedRestarts;
    const nextAttempt = this.intendedRestartTimesMs.length + 1;
    if (typeof maxIntendedRestarts === 'number') {
      const cap = Math.max(0, Math.trunc(maxIntendedRestarts));
      if (nextAttempt > cap) {
        return { type: 'no_restart', reason: `max_intended_restarts_exceeded:${cap}` };
      }
    }

    this.intendedRestartTimesMs.push(nowMs);

    const delayMs = computeRestartDelayMs({
      attempt: nextAttempt,
      baseDelayMs: this.policy.baseDelayMs,
      maxDelayMs: this.policy.maxDelayMs,
      jitterMs: this.policy.jitterMs,
      random: this.deps.random,
    });
    return { type: 'restart_after_delay', attempt: nextAttempt, delayMs };
  }

  nextDecisionForTermination(event: TerminationEvent): RestartDecision {
    if (this.policy.mode === 'never') {
      return { type: 'no_restart', reason: 'restart_policy_never' };
    }

    if (this.stopRequest) {
      return { type: 'no_restart', reason: `stop_requested:${this.stopRequest.reason}` };
    }

    if (!isUnexpectedTermination(event)) {
      return { type: 'no_restart', reason: 'expected_termination' };
    }

    const maxRestarts = this.policy.maxRestarts;
    const nextAttempt = this.restartAttempt + 1;
    if (typeof maxRestarts === 'number') {
      const cap = Math.max(0, Math.trunc(maxRestarts));
      if (nextAttempt > cap) {
        return { type: 'no_restart', reason: `max_restarts_exceeded:${cap}` };
      }
    }

    this.restartAttempt = nextAttempt;

    const delayMs = computeRestartDelayMs({
      attempt: nextAttempt,
      baseDelayMs: this.policy.baseDelayMs,
      maxDelayMs: this.policy.maxDelayMs,
      jitterMs: this.policy.jitterMs,
      random: this.deps.random,
    });
    return { type: 'restart_after_delay', attempt: nextAttempt, delayMs };
  }
}

