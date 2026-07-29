import { z } from 'zod';

export const StopSessionIncompleteReasonSchema = z.enum([
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
]);

export type StopSessionIncompleteReason = z.infer<typeof StopSessionIncompleteReasonSchema>;

export const StopSessionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('stopped') }).strict(),
  z.object({ status: z.literal('requested') }).strict(),
  z.object({ status: z.literal('not_found') }).strict(),
  z.object({
    status: z.literal('incomplete'),
    reason: StopSessionIncompleteReasonSchema,
  }).strict(),
]);

export type StopSessionResult = z.infer<typeof StopSessionResultSchema>;
