import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { MachineAccessRefusalCodeV1Schema } from '../machines/machineAccessV1.js';

/** Identifier-only refusal facts; these codes grant no publication authority. */
export const DISCUSSION_PUBLICATION_DENIAL_CODES_V1 = [
  'discussion_replay_approval_version_unsupported', 'discussion_replay_approval_not_executing',
  'discussion_replay_approval_not_approved', 'discussion_replay_approval_already_executed',
  'discussion_replay_action_mismatch', 'discussion_replay_decision_authority_mismatch',
  'discussion_replay_return_missing', 'discussion_replay_return_invalid',
  'discussion_replay_caller_mismatch', 'discussion_replay_run_mismatch',
  'discussion_replay_server_mismatch', 'discussion_replay_machine_mismatch',
  'discussion_replay_home_mismatch', 'discussion_replay_account_mismatch',
  'discussion_replay_approved_input_invalid', 'discussion_replay_local_id_mismatch',
  'discussion_replay_discussion_mismatch', 'discussion_replay_reply_target_mismatch',
  'discussion_replay_content_mismatch', 'discussion_replay_mentions_not_empty',
  'discussion_replay_source_invalid', 'discussion_replay_invocation_mismatch',
  'discussion_replay_attempt_mismatch', 'discussion_replay_review_pending',
  'discussion_replay_delivery_missing', 'discussion_replay_delivery_mismatch',
  'discussion_replay_result_mismatch', 'discussion_replay_resource_unavailable',
  'discussion_replay_resource_not_ready', 'discussion_replay_envelope_invalid',
  'discussion_replay_sealed_content_mismatch', 'discussion_replay_approval_missing',
  'discussion_replay_machine_context_unavailable', 'discussion_replay_machine_client_unavailable',
  'discussion_replay_approval_context_missing',
  'discussion_replay_context_return_missing', 'discussion_replay_context_return_invalid',
  'discussion_replay_current_machine_mismatch', 'discussion_replay_current_home_mismatch',
  'discussion_action_session_missing', 'discussion_action_session_mismatch',
  'discussion_action_approval_origin_invalid', 'discussion_action_approval_session_mismatch',
  'discussion_action_session_publisher_missing',
  'discussion_machine_publication_invalid', 'discussion_machine_identity_missing',
  'discussion_machine_identity_mismatch', 'discussion_machine_installation_missing',
  'discussion_machine_credential_not_current', 'discussion_machine_custodian_mismatch',
  'discussion_machine_installation_mismatch',
  'discussion_workflow_custody_missing', 'discussion_workflow_invocation_custody_mismatch',
  'discussion_workflow_attempt_mismatch', 'discussion_workflow_lifecycle_mismatch',
  'discussion_workflow_discussion_mismatch', 'discussion_workflow_question_missing',
  'discussion_workflow_frontier_mismatch', 'discussion_workflow_reply_target_mismatch',
  'discussion_workflow_local_id_mismatch', 'discussion_workflow_producer_mismatch',
  'discussion_workflow_runtime_principal_conflict', 'discussion_workflow_return_conflict',
  'discussion_publication_context_unavailable', 'discussion_publication_read_only',
] as const;

export const DISCUSSION_ERROR_CODES_V1 = [
  ...DISCUSSION_PUBLICATION_DENIAL_CODES_V1,
  'discussions_unavailable', 'discussion_not_found', 'discussion_archived', 'discussion_read_denied',
  'discussion_post_denied', 'discussion_manage_denied', 'discussion_access_forbidden', 'discussion_owner_grant_invalid',
  'discussion_content_unavailable', 'discussion_encryption_mode_mismatch', 'discussion_invalid_content',
  'discussion_invalid_mention', 'discussion_invalid_reply_target', 'discussion_idempotency_conflict',
  'discussion_read_cursor_invalid', 'discussion_owner_transfer_required', 'discussion_subject_not_found',
  'discussion_subject_ineligible', 'discussion_invalid_recipient_envelope', 'discussion_data_key_changed',
  'recipient_key_unavailable', 'data_key_not_required',
] as const;

export const DiscussionErrorCodeV1Schema = lazyZodSchema(() => z.union([
  z.enum(DISCUSSION_ERROR_CODES_V1), MachineAccessRefusalCodeV1Schema,
]));
export type DiscussionErrorCodeV1 = z.infer<typeof DiscussionErrorCodeV1Schema>;
