import { ActionFailureCauseV1Schema } from './actions/actionExecutionResult.js';
import { lazyZodSchema } from './lazyZodSchema.js';
import { z } from './zodRuntimePolicy.js';

export const StopSessionIncompleteReasonSchema = lazyZodSchema(() => z.enum([
  'invalid_session_id',
  'explicit_stop_failed',
  'legacy_attachment',
  'missing_attachment_identity',
  'tracked_runner_absent',
  'runner_signal_incomplete',
  'process_owner_observation_unavailable',
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

/** Secret-free native diagnostic codes; these facts never grant signal authority. */
export const SessionStopProcessFailureSchema = lazyZodSchema(() => z.strictObject({
  phase: z.enum(['tree_capture', 'ownership_view']),
  reason: z.string().check(z.regex(/^[a-z][a-z0-9_]*$/)),
}));
export type SessionStopProcessFailure = z.infer<typeof SessionStopProcessFailureSchema>;

export const StopSessionResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('stopped') }),
  z.strictObject({ status: z.literal('requested') }),
  z.strictObject({ status: z.literal('not_found') }),
  z.strictObject({
    status: z.literal('incomplete'),
    reason: StopSessionIncompleteReasonSchema,
    processFailure: z.optional(SessionStopProcessFailureSchema),
    failureCause: z.optional(ActionFailureCauseV1Schema),
    effectAttempted: z.optional(z.boolean()),
  }),
]));

export type StopSessionResult = z.infer<typeof StopSessionResultSchema>;
