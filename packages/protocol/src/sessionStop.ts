import type { SessionStopOutcome } from './sessionControl/contract.js';
import { z } from 'zod';
import { lazySchema } from './lazySchema.js';

/** Self-reported diagnostic context, never authority to stop a session. */
export const StopSessionRequestSourceSchema = lazySchema(() => z.object({
  surface: z.string().trim().min(1).optional(),
  requestingSessionId: z.string().trim().min(1).optional(),
  toolCallId: z.string().trim().min(1).optional(),
}));

export type StopSessionRequestSource = z.infer<typeof StopSessionRequestSourceSchema>;

export const StopSessionRequestSchema = lazySchema(() => z.object({
  sessionId: z.string(),
  // Malformed optional diagnostics must not prevent an otherwise valid Stop.
  source: StopSessionRequestSourceSchema.optional().catch(undefined),
}));

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

export const StopSessionResultSchema = lazySchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('stopped') }).strict(),
  z.object({ status: z.literal('requested') }).strict(),
  z.object({ status: z.literal('not_found') }).strict(),
  z.object({
    status: z.literal('incomplete'),
    reason: StopSessionIncompleteReasonSchema,
  }).strict(),
]));

export type StopSessionResult = z.infer<typeof StopSessionResultSchema>;

/** Classifies an absent runtime using the canonical server Session observation. */
export function resolveSessionStopAbsenceOutcome(params: Readonly<{
  sessionInactive: boolean | null;
  targetKind?: 'caller_local' | 'owning_machine';
}>): Extract<SessionStopOutcome, { status: 'already_stopped' | 'physical_stop_unconfirmed' }> {
  if (params.sessionInactive === true) {
    return { status: 'already_stopped', reason: 'no_runtime_session_inactive' };
  }
  return {
    status: 'physical_stop_unconfirmed',
    reason: params.targetKind === 'owning_machine' ? 'target_session_not_found' : 'local_session_not_found',
  };
}
