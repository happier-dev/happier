/** Closed, content-free refusal codes shared by the group fence and Run transport. */
export const CONNECTED_SERVICE_GROUP_MUTATION_CURRENTNESS_FAILURE_CODES = [
  'shared_generation_application_superseded',
  'credential_revision_superseded',
  'connected_account_group_unavailable',
  'connected_account_group_read_unavailable',
  'connected_account_credential_read_unavailable',
] as const;

export type ConnectedServiceGroupMutationCurrentnessFailureCode =
  typeof CONNECTED_SERVICE_GROUP_MUTATION_CURRENTNESS_FAILURE_CODES[number];

/** Existing requester authority refuses independently of the group tuple. */
export const CONNECTED_SERVICE_CURRENTNESS_AUTHORITY_FAILURE_CODES = [
  'requester_account_context_unavailable', 'requester_session_not_current', 'project_requester_home_unavailable',
] as const;

export class ConnectedServiceGroupMutationCurrentnessError extends Error {
  readonly retryable = false;

  constructor(readonly code: ConnectedServiceGroupMutationCurrentnessFailureCode) {
    super(code);
    this.name = 'ConnectedServiceGroupMutationCurrentnessError';
  }
}
