import {
  reportDaemonObservedSessionExit,
  type DaemonSessionEndPayload,
} from '../sessionTermination';

type OrphanedDeadDaemonSession = Readonly<{
  sessionId: string;
  pid: number;
}>;

export function publishOrphanedStartupSessionEnds(params: Readonly<{
  apiMachine: {
    emitSessionEnd: (payload: DaemonSessionEndPayload) => void;
    enqueueSessionEndMutation?: (payload: DaemonSessionEndPayload) => void;
  };
  orphanedDeadDaemonSessions: ReadonlyArray<OrphanedDeadDaemonSession>;
  now?: () => number;
}>): void {
  const now = params.now ?? (() => Date.now());
  const publishSessionEnd = (payload: DaemonSessionEndPayload): void => {
    if (params.apiMachine.enqueueSessionEndMutation) {
      params.apiMachine.enqueueSessionEndMutation(payload);
      return;
    }
    params.apiMachine.emitSessionEnd(payload);
  };

  for (const orphanedSession of params.orphanedDeadDaemonSessions) {
    reportDaemonObservedSessionExit({
      apiMachine: { emitSessionEnd: publishSessionEnd },
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
