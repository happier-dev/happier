import type {
  TerminalLifecycleObservation,
  TerminalTurnState,
  TerminalTurnTerminalState,
} from './_types';

export const TERMINAL_COMPLETION_QUIET_WINDOW_MS = 350;

type CompletionCandidate = Readonly<{
  observedAtMs: number;
  turnId?: string | null;
  source: 'hook' | 'transcript';
}>;

export type TerminalTurnStateMachineOptions = Readonly<{
  nowMs?: () => number;
  quietWindowMs?: number;
  initialState?: TerminalTurnState;
}>;

export type TerminalTurnStateMachine = Readonly<{
  observe: (observation: TerminalLifecycleObservation) => TerminalTurnState;
  advanceClock: () => TerminalTurnState;
  getState: () => TerminalTurnState;
}>;

function resolveQuietWindowMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : TERMINAL_COMPLETION_QUIET_WINDOW_MS;
}

function normalizeTurnId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function terminalIdle(
  lastTerminal: TerminalTurnTerminalState,
  confidence: 'definite' | 'best_effort' = 'definite',
): TerminalTurnState {
  return { state: 'idle', confidence, lastTerminal };
}

export function createTerminalTurnStateMachine(
  options: TerminalTurnStateMachineOptions = {},
): TerminalTurnStateMachine {
  const nowMs = options.nowMs ?? Date.now;
  const quietWindowMs = resolveQuietWindowMs(options.quietWindowMs);
  let state: TerminalTurnState = options.initialState ?? { state: 'idle', confidence: 'definite' };
  let pendingCompletion: CompletionCandidate | null = null;

  const clearPendingCompletion = (): void => {
    pendingCompletion = null;
  };

  const promoteCandidateIfQuiet = (): TerminalTurnState => {
    const candidate = pendingCompletion;
    if (!candidate) return state;
    if (nowMs() - candidate.observedAtMs < quietWindowMs) return state;
    pendingCompletion = null;
    state = terminalIdle({
      type: 'completed',
      turnId: candidate.turnId,
      source: candidate.source,
    });
    return state;
  };

  const observe = (observation: TerminalLifecycleObservation): TerminalTurnState => {
    switch (observation.type) {
      case 'prompt_submitted':
        clearPendingCompletion();
        state = {
          state: 'running',
          turnId: normalizeTurnId(observation.turnId),
          source: observation.source,
        };
        return state;

      case 'completion_candidate':
        pendingCompletion = {
          observedAtMs: nowMs(),
          turnId: normalizeTurnId(observation.turnId),
          source: observation.source,
        };
        if (state.state !== 'running' && state.state !== 'blocked_on_permission') {
          state = {
            state: 'running',
            turnId: normalizeTurnId(observation.turnId),
            source: observation.source,
          };
        }
        return state;

      case 'completion_candidate_invalidated':
        clearPendingCompletion();
        state = {
          state: 'running',
          turnId: normalizeTurnId(observation.turnId),
          source: 'transcript',
        };
        return state;

      case 'turn_completed':
        clearPendingCompletion();
        state = terminalIdle({
          type: 'completed',
          turnId: normalizeTurnId(observation.turnId),
          source: observation.source,
        });
        return state;

      case 'turn_aborted':
        clearPendingCompletion();
        state = terminalIdle({
          type: 'aborted',
          turnId: normalizeTurnId(observation.turnId),
          reason: observation.reason,
          ...(observation.detail ? { detail: observation.detail } : {}),
          source: observation.source,
        });
        return state;

      case 'turn_failed':
        clearPendingCompletion();
        state = terminalIdle({
          type: 'failed',
          turnId: normalizeTurnId(observation.turnId),
          reason: observation.reason,
          ...(observation.detail ? { detail: observation.detail } : {}),
          source: observation.source,
        });
        return state;

      case 'permission_blocked':
        clearPendingCompletion();
        state = {
          state: 'blocked_on_permission',
          turnId: normalizeTurnId(observation.turnId),
          source: observation.source,
        };
        return state;

      case 'process_exited':
        clearPendingCompletion();
        state = terminalIdle(
          {
            type: 'unknown_exit',
            exitCode: typeof observation.exitCode === 'number' ? observation.exitCode : null,
            signal: typeof observation.signal === 'string' ? observation.signal : null,
          },
          'best_effort',
        );
        return state;
    }
  };

  return Object.freeze({
    observe,
    advanceClock: promoteCandidateIfQuiet,
    getState: () => promoteCandidateIfQuiet(),
  });
}
