import type { TrackedSession } from './types';

type DaemonObservedExit = {
  reason: string;
  code?: number | null;
  signal?: string | null;
};

export type DaemonSessionEndPayload = Readonly<{
  sid: string;
  time: number;
  exit: Readonly<{
    observedBy: 'daemon';
    pid: number;
    reason: string;
    code: number | null;
    signal: string | null;
  }>;
}>;

export type DaemonSessionTurnSettlementPayload = Readonly<{
  sid: string;
  time: number;
}>;

/**
 * Settle the canonical turn of a runner the daemon observed exiting. A dead runner cannot
 * complete its open turn, and a replacement runner begins NEW turns — so the daemon (the one
 * component that always observes the exit, including kills it issued itself) durably enqueues
 * an `end_session` turn settlement regardless of whether a live replacement exists. The server
 * no-ops the settlement when no turn is open or when the open turn began AFTER the observed
 * exit (a replacement runner's newer turn).
 */
export function settleDaemonObservedOpenTurn(opts: {
  apiMachine: {
    enqueueSessionTurnSettlementMutation?: (payload: DaemonSessionTurnSettlementPayload) => void;
  };
  trackedSession: TrackedSession;
  now: () => number;
}): void {
  const { apiMachine, trackedSession, now } = opts;
  if (!trackedSession.happySessionId) {
    return;
  }
  apiMachine.enqueueSessionTurnSettlementMutation?.({
    sid: trackedSession.happySessionId,
    time: now(),
  });
}

export function reportDaemonObservedSessionExit(opts: {
  apiMachine: {
    emitSessionEnd: (payload: DaemonSessionEndPayload) => void;
    enqueueSessionEndMutation?: (payload: DaemonSessionEndPayload) => void;
  };
  trackedSession: TrackedSession;
  now: () => number;
  exit: DaemonObservedExit;
}) {
  const { apiMachine, trackedSession, now, exit } = opts;

  if (!trackedSession.happySessionId) {
    return;
  }

  const payload = {
    sid: trackedSession.happySessionId,
    time: now(),
    exit: {
      observedBy: 'daemon',
      pid: trackedSession.pid,
      reason: exit.reason,
      code: exit.code ?? null,
      signal: exit.signal ?? null,
    },
  } satisfies DaemonSessionEndPayload;

  if (apiMachine.enqueueSessionEndMutation) {
    apiMachine.enqueueSessionEndMutation(payload);
    return;
  }

  apiMachine.emitSessionEnd(payload);
}
