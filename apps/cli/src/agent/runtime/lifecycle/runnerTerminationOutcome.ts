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
   * Whether it is safe to archive the Happy session.
   *
   * If the runner crashes, we avoid archiving so the daemon can respawn and
   * reattach to the same Happy session id.
   */
  archive: boolean;
  archiveReason?: string;
}>;

export function computeRunnerTerminationOutcome(reason: RunnerTerminationReason): RunnerTerminationOutcome {
  if (reason.kind === 'unhandledRejection' || reason.kind === 'uncaughtException') {
    return { exitCode: 1, archive: false };
  }

  if (reason.kind === 'killSession') {
    return { exitCode: 0, archive: true, archiveReason: 'Killed by user' };
  }

  if (reason.kind === 'signal') {
    if (reason.signal === 'SIGTERM' || reason.signal === 'SIGINT') {
      return { exitCode: 0, archive: true, archiveReason: `Signal ${reason.signal}` };
    }
    return { exitCode: 1, archive: false };
  }

  const code = Number.isFinite(reason.code) ? Math.trunc(reason.code) : 1;
  if (code === 0) return { exitCode: 0, archive: true, archiveReason: 'Exited normally' };
  return { exitCode: Math.max(1, code), archive: false };
}
