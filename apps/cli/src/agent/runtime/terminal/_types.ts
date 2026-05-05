export type AgentId = string;

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

export type TerminalLifecycleObservation =
  | Readonly<{
      type: 'prompt_submitted';
      agentId: AgentId;
      turnId?: string | null;
      source: 'hook' | 'transcript' | 'lifecycle_event';
    }>
  | Readonly<{
      type: 'completion_candidate';
      agentId: AgentId;
      turnId?: string | null;
      source: 'hook' | 'transcript';
      details?: unknown;
    }>
  | Readonly<{
      type: 'completion_candidate_invalidated';
      agentId: AgentId;
      turnId?: string | null;
      reason: 'stop_hook_feedback' | 'continuation' | 'new_prompt';
    }>
  | Readonly<{
      type: 'turn_completed';
      agentId: AgentId;
      turnId?: string | null;
      source: 'transcript' | 'lifecycle_event';
    }>
  | Readonly<{
      type: 'turn_aborted';
      agentId: AgentId;
      turnId?: string | null;
      reason: TerminalTurnAbortReason;
      detail?: string;
      source: 'transcript' | 'lifecycle_event' | 'process';
    }>
  | Readonly<{
      type: 'turn_failed';
      agentId: AgentId;
      turnId?: string | null;
      reason: TerminalTurnFailureReason;
      detail?: string;
      source: 'hook' | 'process';
    }>
  | Readonly<{
      type: 'permission_blocked';
      agentId: AgentId;
      turnId?: string | null;
      source: 'hook' | 'transcript' | 'lifecycle_event';
    }>
  | Readonly<{
      type: 'process_exited';
      agentId: AgentId;
      exitCode?: number | null;
      signal?: string | null;
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
