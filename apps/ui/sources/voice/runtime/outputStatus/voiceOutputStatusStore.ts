type VoiceOutputTurnStatus = Readonly<{
  sessionId: string;
  turnId: string;
  statusId: string;
  text: string;
}>;

type VoiceOutputAttemptStatus = Readonly<{
  sessionId: string;
  attemptId: number;
  statusId: string;
  text: string;
}>;

type VoiceOutputStatus =
  | (VoiceOutputTurnStatus & Readonly<{ scope: 'turn' }>)
  | (VoiceOutputAttemptStatus & Readonly<{ scope: 'attempt' }>);

function sameStatusOwner(left: VoiceOutputStatus | null, right: VoiceOutputStatus | null): boolean {
  if (left?.scope !== right?.scope) return false;
  if (left?.scope === 'turn' && right?.scope === 'turn') return left.turnId === right.turnId;
  if (left?.scope === 'attempt' && right?.scope === 'attempt') return left.attemptId === right.attemptId;
  return left === right;
}

export function createVoiceOutputStatusStore() {
  let snapshot: VoiceOutputStatus | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: VoiceOutputStatus | null) => {
    if (
      snapshot?.sessionId === next?.sessionId
      && sameStatusOwner(snapshot, next)
      && snapshot?.statusId === next?.statusId
      && snapshot?.text === next?.text
    ) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return Object.freeze({
    getSnapshot: () => snapshot,
    readForSession: (sessionId: string | null | undefined) =>
      sessionId && snapshot?.sessionId === sessionId ? snapshot : null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    show: (status: VoiceOutputTurnStatus) => publish({ ...status, scope: 'turn' }),
    showAttempt: (status: VoiceOutputAttemptStatus) => publish({ ...status, scope: 'attempt' }),
    clear: (input: Readonly<{ sessionId: string; turnId: string }>) => {
      if (
        snapshot?.scope === 'turn'
        && snapshot.sessionId === input.sessionId
        && snapshot.turnId === input.turnId
      ) publish(null);
    },
    clearAttemptForSession: (sessionId: string) => {
      if (snapshot?.scope === 'attempt' && snapshot.sessionId === sessionId) publish(null);
    },
  });
}

export const voiceOutputStatusStore = createVoiceOutputStatusStore();
