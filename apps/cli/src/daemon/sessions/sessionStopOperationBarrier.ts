import type { StopSessionResult } from './stopSessionContract';

export type SessionStopOperationBarrier = Readonly<{
  run: (sessionId: string, operation: () => Promise<StopSessionResult>) => Promise<StopSessionResult>;
  wait: (sessionId: string) => Promise<void>;
  has: (sessionId: string) => boolean;
}>;

function normalizeSessionId(sessionId: string): string {
  return String(sessionId ?? '').trim();
}

export function createSessionStopOperationBarrier(): SessionStopOperationBarrier {
  const inFlightBySessionId = new Map<string, Promise<StopSessionResult>>();

  return {
    run: async (sessionId, operation) => {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId) return { status: 'incomplete', reason: 'invalid_session_id' };
      const existing = inFlightBySessionId.get(normalizedSessionId);
      if (existing) return await existing;

      const inFlight = operation();
      inFlightBySessionId.set(normalizedSessionId, inFlight);
      try {
        return await inFlight;
      } finally {
        if (inFlightBySessionId.get(normalizedSessionId) === inFlight) {
          inFlightBySessionId.delete(normalizedSessionId);
        }
      }
    },
    wait: async (sessionId) => {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId) return;
      await inFlightBySessionId.get(normalizedSessionId);
    },
    has: (sessionId) => inFlightBySessionId.has(normalizeSessionId(sessionId)),
  };
}
