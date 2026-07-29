/**
 * Managed subprocess supervision types.
 *
 * This module defines the provider-agnostic contract for processes we spawn or track.
 * It is shared by daemon-side supervision (session runners) and runner-side backends
 * (Claude Code, ACP agents, Codex TUI, Pi RPC, etc.).
 */

export type ManagedProcessId = string;

export type ManagedProcessKind =
  | 'daemon-session-runner'
  | 'daemon-instance'
  | 'acp-agent'
  | 'claude-code'
  | 'codex-tui'
  | 'pi-rpc'
  | 'caffeinate'
  | 'other';

export type ManagedProcessRestartPolicy =
  | Readonly<{ mode: 'never' }>
  | Readonly<{
      mode: 'on_unexpected_exit';
      /**
       * Maximum restart attempts after the initial spawn.
       *
       * - `null` means unlimited (use sparingly; prefer a finite number).
       * - `0` means no restarts.
       */
      maxRestarts: number | null;
      /**
       * Maximum INTENDED restarts (connected-service-initiated relaunches) on their OWN budget,
       * separate from `maxRestarts`. Intended restarts are wanted, not crash symptoms, so they must
       * not consume the generic crash budget — but a storm of them must still be bounded (RR-2).
       *
       * - `undefined` falls back to `DEFAULT_MAX_INTENDED_RESTARTS`.
       * - `null` means unlimited (avoid).
       * - `0` means no intended restarts.
       */
      maxIntendedRestarts?: number | null;
      /**
       * Rolling window for intended-restart accounting: restarts inside the window count against
       * `maxIntendedRestarts` even across SUCCESSFUL respawns (a successful restart loop must still
       * trip the limiter); older restarts decay out. `undefined` falls back to
       * `DEFAULT_INTENDED_RESTART_WINDOW_MS`.
       */
      intendedRestartWindowMs?: number;
      baseDelayMs: number;
      maxDelayMs: number;
      jitterMs: number;
    }>;

export type ManagedProcessLoggingPolicy = Readonly<{
  /**
   * Whether to log termination events via the domain logger.
   * (Termination reports/artifacts may still be written regardless.)
   */
  logTerminationEvents: boolean;
}>;

export type ManagedProcessArtifactsPolicy = Readonly<{
  captureStderr: boolean;
  /**
   * A short label for stderr artifacts (e.g. "claude-code", "acp", "codex").
   * Used to construct diagnostic filenames.
   */
  stderrLabel?: string;
}>;

export type ManagedProcessPolicy = Readonly<{
  kind: ManagedProcessKind;
  restart: ManagedProcessRestartPolicy;
  logging: ManagedProcessLoggingPolicy;
  artifacts: ManagedProcessArtifactsPolicy;
  terminateGraceMs: number;
}>;

export type TerminationEvent =
  | Readonly<{ type: 'exited'; code: number }>
  | Readonly<{ type: 'signaled'; signal: NodeJS.Signals }>
  | Readonly<{ type: 'spawn_error'; errorName: string; errorMessage: string }>
  | Readonly<{ type: 'missing' }>;

export type StopReason =
  | 'user_request'
  | 'daemon_stop_session'
  | 'shutdown'
  | 'switch_mode'
  | 'test_cleanup'
  | 'other';

export type StopRequest = Readonly<{
  reason: StopReason;
  requestedAtMs: number;
}>;

