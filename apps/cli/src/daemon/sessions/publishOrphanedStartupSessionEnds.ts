import { reportDaemonObservedSessionExit } from '../sessionTermination';

type OrphanedDeadDaemonSession = Readonly<{
  sessionId: string;
  pid: number;
}>;

export function publishOrphanedStartupSessionEnds(params: Readonly<{
  apiMachine: { emitSessionEnd: (payload: any) => void };
  orphanedDeadDaemonSessions: ReadonlyArray<OrphanedDeadDaemonSession>;
  now?: () => number;
}>): void {
  const now = params.now ?? (() => Date.now());

  for (const orphanedSession of params.orphanedDeadDaemonSessions) {
    reportDaemonObservedSessionExit({
      apiMachine: params.apiMachine,
      trackedSession: {
        startedBy: 'daemon',
        happySessionId: orphanedSession.sessionId,
        pid: orphanedSession.pid,
      },
      now,
      exit: {
        reason: 'process-missing',
        code: null,
        signal: null,
      },
    });
  }
}
