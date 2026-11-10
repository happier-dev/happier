import * as z from '../zodRuntimePolicy.js';

/** Failed authority/custody facts only: no ids, policy values or credential content. */
export const ApprovalStaleReasonSchema = z.enum([
  'origin_not_current', 'origin_version', 'origin_invalid', 'origin_action_changed',
  'currentness_owner_unavailable', 'currentness_read_failed',
  'home_changed', 'home_unavailable', 'machine_changed', 'account_changed', 'account_unavailable',
  'credential_changed', 'credential_expired', 'target_unavailable', 'plugin_source_changed',
  'automation_run_changed', 'session_changed', 'permission_changed', 'run_occurrence_changed',
  'requester_account_unavailable',
  'workflow_authorization_unavailable', 'workflow_authorization_changed',
  'spawn_policy_unavailable', 'spawn_policy_changed',
  'directory_approval_missing', 'directory_changed', 'live_invocation_unavailable',
]);
export type ApprovalStaleReason = z.infer<typeof ApprovalStaleReasonSchema>;
export const ApprovalStaleFailureDetailsSchema = z.strictObject({ reason: ApprovalStaleReasonSchema });
