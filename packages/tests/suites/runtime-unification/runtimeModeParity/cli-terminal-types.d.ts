declare module '@/agent/runtime/terminal/_types' {
  export type TerminalTurnStateSource = 'hook' | 'transcript' | 'lifecycle_event' | 'process';

  export type TerminalTurnAbortReason =
    | 'user_interrupt'
    | 'replaced_by_new_turn'
    | 'process_kill'
    | 'timeout'
    | 'other';

  export type TerminalTurnFailureReason =
    | 'stop_failure_hook'
    | 'process_error'
    | 'api_error'
    | 'other';

  export type TerminalTurnTerminalState =
    | Readonly<{
        type: 'completed';
        turnId?: string | null;
        source: 'hook' | 'transcript' | 'lifecycle_event';
      }>
    | Readonly<{
        type: 'aborted';
        turnId?: string | null;
        reason: TerminalTurnAbortReason;
        detail?: string;
        source: 'transcript' | 'lifecycle_event' | 'process';
      }>
    | Readonly<{
        type: 'failed';
        turnId?: string | null;
        reason: TerminalTurnFailureReason;
        detail?: string;
        source: 'hook' | 'process';
      }>
    | Readonly<{
        type: 'unknown_exit';
        exitCode?: number | null;
        signal?: string | null;
      }>;

  export type TerminalTurnState =
    | Readonly<{
        state: 'idle';
        confidence: 'definite' | 'best_effort';
        lastTerminal?: TerminalTurnTerminalState;
      }>
    | Readonly<{
        state: 'running';
        turnId?: string | null;
        source: TerminalTurnStateSource;
      }>
    | Readonly<{
        state: 'blocked_on_permission';
        turnId?: string | null;
        source: TerminalTurnStateSource;
      }>
    | Readonly<{
        state: 'unknown';
        reason?: string;
      }>;

  export type TerminalPendingHandoffStateV1 = Readonly<{
    v: 1;
    status:
      | 'none'
      | 'deferred_until_terminal_turn_finishes'
      | 'switching_to_remote'
      | 'blocked_waiting_for_resume_identity'
      | 'switch_failed'
      | 'manual_action_required';
    pendingCount: number;
    updatedAtMs: number;
    lastTerminalState?: TerminalTurnTerminalState;
    interruptRequired?: boolean;
    detail?: string;
  }>;
}
