import { z } from 'zod';

/**
 * The single presentation vocabulary for "an agent is doing work" (R-6).
 *
 * Every provider/wire status enum keeps its own contract and maps into this one at a boundary
 * adapter under `./adapters/**` — none of them is replaced or deleted. Surfaces render from this
 * vocabulary and never from a provider enum, so a raw untranslated provider value can no longer
 * reach a screen.
 *
 * Deliberately absent, because each folds into a member above rather than growing the vocabulary:
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
