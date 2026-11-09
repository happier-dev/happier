import type { SessionMetadataMutationFailureCodeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

export type SessionStopRecovery =
    | 'wait_for_inactive'
    | 'retry_when_runtime_available';

export type SessionStopResponseCode =
    | SessionMetadataMutationFailureCodeV1
    | 'session_stop_requested'
    | 'session_stop_not_found'
    | 'session_stop_control_unavailable'
    | 'session_stop_failed';
