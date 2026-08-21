import { createSessionStopOperationBarrier } from '../sessions/sessionStopOperationBarrier';
import {
  isTerminalHostPhysicallyRetiredStopResult,
  type StopSessionResult,
} from '../sessions/stopSessionContract';
import type { DisconnectedTerminalHostCandidate } from '../sessions/disconnectedTerminalHostSupervision';

type ResumeGate =
  | Readonly<{ action: 'resume' }>
  | Readonly<{ action: 'fence'; reason: string }>;

type RetireCandidateInput = Readonly<{
  sessionId: string;
  attachmentId?: string;
}>;

type StopLifecycleResult = Readonly<{
  stopResult: StopSessionResult;
  retireCandidate?: RetireCandidateInput;
}>;

export function createDisconnectedTerminalHostResumeLifecycle(input: Readonly<{
  unresolvedTerminalHostSessionIds: ReadonlySet<string>;
  clearUnresolvedTerminalHostSession: (sessionId: string) => void;
  findDisconnectedCandidate: (sessionId: string) => DisconnectedTerminalHostCandidate | null;
  resolveResumeGateForCandidate: (candidate: DisconnectedTerminalHostCandidate) => Promise<ResumeGate>;
  retireCandidate: (input: RetireCandidateInput) => void;
}>) {
  const barrier = createSessionStopOperationBarrier();

  return {
    waitForStop: async (sessionId: string): Promise<void> => {
      await barrier.wait(sessionId);
    },
    resolveResumePreGate: async (
      existingSessionIdRaw: string,
      repairUnresolvedTopology?: (sessionId: string) => Promise<StopSessionResult>,
    ): Promise<null | {
      type: 'error';
      errorMessage: string;
    }> => {
      const existingSessionId = existingSessionIdRaw.trim();
      if (!existingSessionId) return null;
      await barrier.wait(existingSessionId);
      if (input.unresolvedTerminalHostSessionIds.has(existingSessionId)) {
        const repairResult = repairUnresolvedTopology
          ? await repairUnresolvedTopology(existingSessionId)
          : null;
        if (
          repairResult
          && (
            repairResult.status === 'not_found'
            || isTerminalHostPhysicallyRetiredStopResult(repairResult)
          )
        ) {
          input.clearUnresolvedTerminalHostSession(existingSessionId);
        } else {
          return {
            type: 'error',
            errorMessage: 'The existing session has preserved terminal topology that cannot be verified. Stop it explicitly before retrying resume.',
          };
        }
      }
      const disconnectedCandidate = input.findDisconnectedCandidate(existingSessionId);
      if (!disconnectedCandidate) return null;
      const gate = await input.resolveResumeGateForCandidate(disconnectedCandidate);
      if (gate.action === 'resume') return null;
      return {
        type: 'error',
        errorMessage: `The existing session has a preserved terminal host that cannot be resumed (${gate.reason}). Stop it explicitly before retrying resume.`,
      };
    },
    runStop: async (
      sessionId: string,
      stop: () => Promise<StopLifecycleResult>,
    ): Promise<StopSessionResult> =>
      await barrier.run(sessionId, async () => {
        const result = await stop();
        if (result.retireCandidate && isTerminalHostPhysicallyRetiredStopResult(result.stopResult)) {
          input.retireCandidate(result.retireCandidate);
        }
        return result.stopResult;
      }),
  };
}
