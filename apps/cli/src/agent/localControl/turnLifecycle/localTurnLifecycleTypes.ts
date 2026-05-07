export type LocalTurnTerminalReason =
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'session-ended'
  | 'process-exited'
  | 'unknown';

export type LocalTurnLifecycleEvent =
  | { type: 'turn_started'; providerTurnId?: string | null; source: string; atMs?: number }
  | { type: 'completion_candidate'; providerTurnId?: string | null; source: string; atMs?: number }
  | {
      type: 'turn_terminal';
      providerTurnId?: string | null;
      reason: LocalTurnTerminalReason;
      source: string;
      detail?: string;
      atMs?: number;
    }
  | { type: 'continuation_detected'; providerTurnId?: string | null; source: string; atMs?: number }
  | { type: 'session_ended'; source: string; atMs?: number };

export type LocalTurnLifecycleSnapshot = Readonly<{
  active: boolean;
  terminal: boolean;
  waitingForQuiescence: boolean;
  providerTurnId: string | null;
  lastTerminalReason: LocalTurnTerminalReason | null;
}>;

export type LocalTurnLifecycleController = Readonly<{
  observe: (event: LocalTurnLifecycleEvent) => void;
  snapshot: () => LocalTurnLifecycleSnapshot;
  waitForSafeRemoteHandoff: (abortSignal?: AbortSignal) => Promise<LocalTurnLifecycleSnapshot>;
  dispose: () => void;
}>;
