import { createSessionStopOperationBarrier } from '../sessions/sessionStopOperationBarrier';
import {
  isTerminalHostPhysicallyRetiredStopResult,
  type StopSessionResult,
} from '../sessions/stopSessionContract';
import type { DisconnectedTerminalHostCandidate, resolveDisconnectedTerminalHostResumeGate } from '../sessions/disconnectedTerminalHostSupervision';

type ResumeGate = ReturnType<typeof resolveDisconnectedTerminalHostResumeGate>;

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
  retireCandidate: (input: RetireCandidateInput) => void | Promise<void>;
}>) {
  const barrier = createSessionStopOperationBarrier();

  return {
    waitForStop: async (sessionId: string): Promise<void> => {
      await barrier.wait(sessionId);
    },
    resolveResumePreGate: async (
      existingSessionIdRaw: string,
      repairUnresolvedTopology?: (sessionId: string) => Promise<StopSessionResult>,
    ): Promise<null | Readonly<{ type: 'resume'; retainedTerminalRecovery: 'adopt' }> | {
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
            errorMessage: 'The existing session has preserved terminal topology that cannot be verified. Reconnect to the original terminal host and retry Resume, or Stop the session if that action is available before resuming on a fresh host.',
          };
        }
      }
      const disconnectedCandidate = input.findDisconnectedCandidate(existingSessionId);
      if (!disconnectedCandidate) return null;
      const gate = await input.resolveResumeGateForCandidate(disconnectedCandidate);
      if (gate.action === 'resume') {
        return gate.retainedTerminalRecovery === 'adopt'
          ? { type: 'resume', retainedTerminalRecovery: 'adopt' }
          : null;
      }
      return {
        type: 'error',
        errorMessage: `The existing session has a preserved terminal host that cannot be resumed (${gate.reason}). Reconnect to the original terminal host and retry Resume, or Stop the session if that action is available before resuming on a fresh host.`,
      };
    },
    runStop: async (
      sessionId: string,
      stop: () => Promise<StopLifecycleResult>,
    ): Promise<StopSessionResult> =>
      await barrier.run(sessionId, async () => {
        const result = await stop();
        if (result.retireCandidate && isTerminalHostPhysicallyRetiredStopResult(result.stopResult)) {
          await input.retireCandidate(result.retireCandidate);
        }
        return result.stopResult;
      }),
  };
}
