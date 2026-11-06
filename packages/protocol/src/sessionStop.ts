import { z } from 'zod';
import { lazySchema } from './lazySchema.js';

export const StopSessionIncompleteReasonSchema = lazySchema(() => z.enum([
  'invalid_session_id',
  'legacy_attachment',
  'missing_attachment_identity',
  'tracked_runner_absent',
  'runner_signal_incomplete',
  'runner_exit_observer_unavailable',
  'runner_exit_timeout',
  'terminal_host_adapter_unavailable',
  'attachment_mismatch',
  'missing_topology_proof',
  'disposition_in_progress',
  'destroy_failed',
  'terminal_control_serviceability_retirement_failed',
  'terminal_attachment_descriptor_retirement_failed',
]));

export type StopSessionIncompleteReason = z.infer<typeof StopSessionIncompleteReasonSchema>;

/**
 * Who is asking the daemon to stop a session. The `stop-session` machine RPC is
 * the single choke point every session-stop caller funnels through; `origin` is
 * the optional caller attribution that lets the daemon guard unattended callers.
 *
 * Absent origin (legacy clients, spawn cleanup, archive and transition flows)
 * keeps today's semantics: the stop dispatches unguarded.
 */
export const StopSessionOriginSchema = lazySchema(() => z.enum(['user-explicit', 'agent-action']));

export type StopSessionOrigin = z.infer<typeof StopSessionOriginSchema>;

/**
 * Params of the `stop-session` machine RPC. The released shape is
 * `{ sessionId }`; `origin` and `force` are optional additions newer clients
 * send. `force: true` skips the agent-action turn guard.
 */
export const StopSessionRpcParamsSchema = lazySchema(() => z.object({
  sessionId: z.string().min(1),
  origin: StopSessionOriginSchema.optional(),
  force: z.boolean().optional(),
}));

export type StopSessionRpcParams = z.infer<typeof StopSessionRpcParamsSchema>;

export const StopSessionResultSchema = lazySchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('stopped') }).strict(),
  z.object({ status: z.literal('requested') }).strict(),
  z.object({ status: z.literal('not_found') }).strict(),
  z.object({
    status: z.literal('incomplete'),
    reason: StopSessionIncompleteReasonSchema,
  }).strict(),
  // An agent-attributed stop was refused because a turn is in flight: the
  // session was NOT signalled. No shipped caller sends `force: true`; a human who
  // truly wants the turn dead stops from the app or CLI (user-explicit dispatches
  // unguarded).
  z.object({ status: z.literal('refused_turn_in_flight') }).strict(),
]));

export type StopSessionResult = z.infer<typeof StopSessionResultSchema>;
