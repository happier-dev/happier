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

export class RestartController {
  private stopRequest: StopRequest | null = null;
  private restartAttempt = 0;

  constructor(
    private readonly policy: ManagedProcessRestartPolicy,
    private readonly deps: Readonly<{ random: () => number }>,
  ) {}

  markStopRequested(request: StopRequest): void {
    this.stopRequest = request;
  }

  clearStopRequested(): void {
    this.stopRequest = null;
  }

  reset(): void {
    this.restartAttempt = 0;
    this.stopRequest = null;
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

