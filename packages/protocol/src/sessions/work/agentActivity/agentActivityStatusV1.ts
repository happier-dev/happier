import { z } from 'zod';

/**
 * The single presentation vocabulary for "an agent is doing work".
 *
 * Every provider/wire status enum keeps its own contract and maps into this one at a boundary
 * adapter under `./adapters/**` — none of them is replaced or deleted. Surfaces render from this
 * vocabulary and never from a provider enum, so a raw untranslated provider value can no longer
 * reach a screen.
 *
 * Deliberately absent, because each folds into a member below rather than growing the vocabulary:
 * `paused` (-> `blocked` plus a reason), `terminated` (-> `cancelled`), `expired` (-> `timedOut`),
 * `claimed` (-> `queued`), `permission_pending` / `permission_blocked` (-> `waiting`, told apart by
 * the entry's attention kind). "Stale" is presentation, not status: a stale entry keeps its last
 * known non-terminal status and changes only how it is drawn.
 *
 * Order is part of the contract — it is the ladder from admission to outcome, and tests pin it.
 */
export const AGENT_ACTIVITY_STATUSES_V1 = [
  /** Admitted but not started (a workflow agent still pending, a run accepted but not dispatched). */
  'queued',
  /** Backend booting. An observed cold ACP handshake can take minutes, so this is not `running`. */
  'starting',
  /** Producing work. */
  'running',
  /** Blocked on the human. The only status that escalates. */
  'waiting',
  /** Blocked on a sibling or dependency, not on a person. */
  'blocked',
  'succeeded',
  'failed',
  /** Distinct recovery (raise the budget) from `failed` (read the error). */
  'timedOut',
  /** User- or system-stopped. Never painted as danger. */
  'cancelled',
  /** The source is genuinely ambiguous. Never a fallback for an unmapped known value. */
  'unknown',
] as const;

export const AgentActivityStatusV1Schema = z.enum(AGENT_ACTIVITY_STATUSES_V1);
export type AgentActivityStatusV1 = z.infer<typeof AgentActivityStatusV1Schema>;

/**
 * Whether this status still claims the work is happening.
 *
 * The vocabulary owns this rather than each surface, because the answer decides whether a clock may
 * keep counting — and a clock still counting on work that is over is the same class of lie as a
 * `timeout` painted green. Two members are easy to get wrong:
 *
 * - `waiting` IS in progress. The agent has not finished; a person is the blocker, and how long it
 *   has been waiting is precisely the datum that makes someone act.
 * - `unknown` is NOT. It is the one thing an ambiguous entry certainly is not — work we can still
 *   claim is happening.
 *
 * **Not the negation of `isTerminalAgentActivityStatus` below**, and the gap is deliberate:
 * `unknown` answers `false` to both, because "we have no outcome" and "it is still going" are
 * different claims and an ambiguous entry supports neither. Do not "reconcile" them into one
 * predicate — that reconciliation is what would put a running clock back on an ambiguous row.
 *
 * Exhaustive by construction: a new status fails to compile here rather than defaulting either way.
 */
export function isInProgressAgentActivityStatus(status: AgentActivityStatusV1): boolean {
  switch (status) {
    case 'queued':
    case 'starting':
    case 'running':
    case 'waiting':
    case 'blocked':
      return true;
    case 'succeeded':
    case 'failed':
    case 'timedOut':
    case 'cancelled':
    case 'unknown':
      return false;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * Has this entry reached an outcome we have EVIDENCE for?
 *
 * Completion is evidence-based, never time-based, so `unknown` answers NO: the source is ambiguous,
 * which is not the same as finished. That matters at exactly one place today — the headline bounds
 * terminal history and leaves the rest uncapped, so calling `unknown` terminal would let an
 * ambiguous entry be dropped from the roster by a cap while it may still be working.
 *
 * Paired with `isInProgressAgentActivityStatus` above, which is NOT its negation: `unknown` answers
 * `false` to both. The two are mutually exclusive and jointly non-exhaustive, and both properties
 * are pinned by tests.
 */
export function isTerminalAgentActivityStatus(status: AgentActivityStatusV1): boolean {
  switch (status) {
    case 'succeeded':
    case 'failed':
    case 'timedOut':
    case 'cancelled':
      return true;
    case 'queued':
    case 'starting':
    case 'running':
    case 'waiting':
    case 'blocked':
    case 'unknown':
      return false;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
