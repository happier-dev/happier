export type RunnerTerminationReason =
  | Readonly<{ kind: 'exit'; code: number }>
  | Readonly<{ kind: 'signal'; signal: NodeJS.Signals }>
  | Readonly<{ kind: 'killSession' }>
  | Readonly<{ kind: 'unhandledRejection'; reason?: unknown }>
  | Readonly<{ kind: 'uncaughtException'; error?: unknown }>;

export type RunnerTerminationEvent = RunnerTerminationReason;

export type RunnerTerminationOutcome = Readonly<{
  exitCode: number;
  /**
   * Human-readable description of why the runner terminated, for diagnostics only.
   *
   * Termination never decides Happy session archiving. A runner that exits leaves its
   * session inactive and resumable; archiving is a user-intent action requested through
   * the session archive owner, not a consequence of the runtime finishing.
   */
  terminationReason: string;
}>;

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
