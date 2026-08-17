export type RunnerTerminationReason =
  | Readonly<{ kind: 'exit'; code: number }>
  | Readonly<{ kind: 'signal'; signal: NodeJS.Signals }>
  | Readonly<{ kind: 'killSession' }>
  | Readonly<{ kind: 'unhandledRejection'; reason?: unknown }>
  | Readonly<{ kind: 'uncaughtException'; error?: unknown }>;

export type RunnerTerminationEvent = RunnerTerminationReason;

export type RunnerTerminationOutcome = Readonly<{
  /**
   * Process exit code for the runner.
   *
   * A crash keeps a non-zero code so the daemon can respawn and reattach to the
   * same Happier session id; a planned termination exits cleanly.
   */
  exitCode: number;
  /** Human-readable termination description, used for session exit diagnostics. */
  terminationReason: string;
}>;

/**
 * Describes how the runner process terminated.
 *
 * This deliberately carries no archive directive. Archiving a Happier Session is a
 * user-intent action owned by `setSessionArchivedState`, never a consequence of the
 * runtime stopping: a Session whose runner terminated becomes inactive and stays
 * resumable.
 */
export function computeRunnerTerminationOutcome(reason: RunnerTerminationReason): RunnerTerminationOutcome {
  if (reason.kind === 'unhandledRejection') {
    return { exitCode: 1, terminationReason: 'Unhandled rejection' };
  }

  if (reason.kind === 'uncaughtException') {
    return { exitCode: 1, terminationReason: 'Uncaught exception' };
  }

  if (reason.kind === 'killSession') {
    return { exitCode: 0, terminationReason: 'Killed by user' };
  }

  if (reason.kind === 'signal') {
    const terminationReason = `Signal ${reason.signal}`;
    if (reason.signal === 'SIGTERM' || reason.signal === 'SIGINT') {
      return { exitCode: 0, terminationReason };
    }
    return { exitCode: 1, terminationReason };
  }

  const code = Number.isFinite(reason.code) ? Math.trunc(reason.code) : 1;
  if (code === 0) return { exitCode: 0, terminationReason: 'Exited normally' };
  return { exitCode: Math.max(1, code), terminationReason: `Exited with code ${code}` };
}
