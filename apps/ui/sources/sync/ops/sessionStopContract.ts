export type SessionStopRecovery =
    | 'wait_for_inactive'
    | 'retry_when_runtime_available';

export type SessionStopResponseCode =
    | 'session_stop_requested'
    | 'session_stop_not_found'
    | 'session_stop_control_unavailable'
    | 'session_stop_failed';
