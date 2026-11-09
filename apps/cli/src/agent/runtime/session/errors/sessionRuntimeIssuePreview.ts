import {
  TEAM_CREDENTIAL_FAILURE_PREVIEW,
  type SessionRuntimeIssueSourceV1,
} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

/** Closed source summaries are safe for both private issues and server-readable status. */
export const SESSION_RUNTIME_ISSUE_PREVIEW_BY_SOURCE = {
  agent_status_error: 'Provider reported an error',
  agent_process_exit: 'Provider process exited',
  agent_process_exit_after_switch: 'Provider process exited after connected-service switch',
  agent_session_error: 'Provider session failed',
  usage_limit: 'Usage limit reached',
  team_credential: TEAM_CREDENTIAL_FAILURE_PREVIEW,
  auth_error: 'Authentication failed',
  dependency_failure: 'Provider dependency failed',
  stream_error: 'Provider stream failed',
  permission_blocked: 'Permission blocked',
  unknown: 'Session runtime failed',
} as const satisfies Record<SessionRuntimeIssueSourceV1, string>;
