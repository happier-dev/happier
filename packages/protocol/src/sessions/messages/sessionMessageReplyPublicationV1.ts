import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DISCUSSION_ERROR_CODES_V1 } from '../../discussions/errors.js';
import { MachineAccessRefusalCodeV1Schema } from '../../machines/machineAccessV1.js';
import { WorkflowOperationErrorCodeV1Schema } from '../../workflows/workflowProgressV1.js';

function isRetryableSessionMessageReplyPublicationCodeV1(code: unknown): boolean {
  return code === 'discussions_unavailable' || code === 'discussion_content_unavailable'
    || code === 'discussion_data_key_changed' || code === 'recipient_key_unavailable'
    || code === 'approval_context_unavailable' || code === 'cancelled'
    || code === 'outcome_unknown' || code === 'action_outcome_unknown';
}

/** Publication is separate from the protected native outcome; diagnostics carry no content. */
export const SessionMessageReplyPublicationFailureV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.union([MachineAccessRefusalCodeV1Schema, WorkflowOperationErrorCodeV1Schema, z.enum([...DISCUSSION_ERROR_CODES_V1,
    'action_disabled', 'present_user_required', 'run_access_denied', 'approval_stale', 'action_failed',
    'unsupported_action', 'invalid_action_output', 'invalid_parameters', 'discussion_participant_required', 'discussion_answer_policy_denied',
    'approval_context_unavailable', 'approval_invalid', 'approval_rejected', 'approval_canceled', 'cancelled', 'outcome_unknown', 'action_outcome_unknown',
    'workflow_authorization_revoked'])]),
  phase: z.enum(['action_admission', 'workflow_publication', 'publisher_request', 'session_transport', 'session_publisher', 'machine_publisher']),
  retryable: z.boolean(),
}).check(z.refine(value => value.retryable === isRetryableSessionMessageReplyPublicationCodeV1(value.code),
  'Publication retryability belongs to its failure code')));
export type SessionMessageReplyPublicationFailureV1 = z.infer<typeof SessionMessageReplyPublicationFailureV1Schema>;

/** One classification shared by the publisher and every original/Workflow recovery consumer. */
export function classifySessionMessageReplyPublicationFailureV1(code: unknown,
  phase: SessionMessageReplyPublicationFailureV1['phase']): SessionMessageReplyPublicationFailureV1 | undefined {
  const retryable = isRetryableSessionMessageReplyPublicationCodeV1(code);
  const parsed = SessionMessageReplyPublicationFailureV1Schema.safeParse({ code, phase, retryable });
  return parsed.success ? parsed.data : undefined;
}

export const SessionMessageReplyPublicationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('failed'), failure: SessionMessageReplyPublicationFailureV1Schema }),
  z.strictObject({ kind: z.literal('approval_pending'), artifactId: z.string().check(z.minLength(1)) }),
]));
export type SessionMessageReplyPublicationV1 = z.infer<typeof SessionMessageReplyPublicationV1Schema>;
