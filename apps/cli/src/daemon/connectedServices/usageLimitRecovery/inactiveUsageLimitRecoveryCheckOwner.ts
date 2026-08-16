import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { hasSameUsageLimitRecoveryIdentity } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';

import {
  type UsageLimitRecoveryIntent,
  type UsageLimitRecoveryCancelExactResult,
  UsageLimitRecoveryScheduler,
} from './UsageLimitRecoveryScheduler';

export function createInactiveUsageLimitRecoveryCheckOwner() {
  let nextMutationSequence = 0;
  const runnersBySessionId = new Map<string, Readonly<{
    issueFingerprint: string;
    armedAtMs: number;
    runtimeAuthRecoveryAttemptId?: string;
    runCheckNow: () => Promise<unknown>;
    mutationSequence: number;
  }>>();

  return {
    hasRunner: (sessionId: string): boolean => runnersBySessionId.has(sessionId),
    run: async (sessionId: string): Promise<unknown | null> => {
      const runner = runnersBySessionId.get(sessionId);
      return runner ? await runner.runCheckNow() : null;
    },
    observe: (input: Readonly<{
      sessionId: string;
      recovery: SessionUsageLimitRecoveryV1;
      runCheckNow: () => Promise<unknown>;
    }>): void => {
      const mutationSequence = ++nextMutationSequence;
      runnersBySessionId.set(input.sessionId, {
        issueFingerprint: input.recovery.issueFingerprint,
        armedAtMs: input.recovery.armedAtMs,
        ...(input.recovery.runtimeAuthRecoveryAttemptId
          ? { runtimeAuthRecoveryAttemptId: input.recovery.runtimeAuthRecoveryAttemptId }
          : {}),
        runCheckNow: input.runCheckNow,
        mutationSequence,
      });
    },
    schedule: (input: Readonly<{
      sessionId: string;
      recovery: SessionUsageLimitRecoveryV1;
      runCheckNow: () => Promise<unknown>;
      scheduler: UsageLimitRecoveryScheduler;
      onPersistenceError: (error: unknown) => void;
    }>): void => {
      const mutationSequence = ++nextMutationSequence;
      const runner = {
        issueFingerprint: input.recovery.issueFingerprint,
        armedAtMs: input.recovery.armedAtMs,
        ...(input.recovery.runtimeAuthRecoveryAttemptId
          ? { runtimeAuthRecoveryAttemptId: input.recovery.runtimeAuthRecoveryAttemptId }
          : {}),
        runCheckNow: input.runCheckNow,
        mutationSequence,
      };
      void input.scheduler.upsertScheduled({
        sessionId: input.sessionId,
        intent: input.recovery,
      }).then((committed) => {
        const fresh = input.scheduler.read(input.sessionId);
        if (
          !hasSameUsageLimitRecoveryIdentity(committed, input.recovery)
          || !fresh
          || !hasSameUsageLimitRecoveryIdentity(fresh, committed)
          || fresh.status !== committed.status
          || fresh.attemptCount !== committed.attemptCount
          || fresh.nextCheckAtMs !== committed.nextCheckAtMs
        ) return;
        const currentRunner = runnersBySessionId.get(input.sessionId);
        if (!currentRunner || currentRunner.mutationSequence <= mutationSequence) {
          runnersBySessionId.set(input.sessionId, runner);
        }
      }).catch((error) => {
        input.onPersistenceError(error);
      });
    },
    cancelExact: async (input: Readonly<{
      sessionId: string;
      issueFingerprint: string;
      armedAtMs: number;
      runtimeAuthRecoveryAttemptId?: string;
      scheduler: UsageLimitRecoveryScheduler;
    }>): Promise<UsageLimitRecoveryCancelExactResult> => {
      const result = await input.scheduler.cancelExact(input);
      if (result.status !== 'cancelled') return result;
      const runner = runnersBySessionId.get(input.sessionId);
      if (runner && hasSameUsageLimitRecoveryIdentity(runner, input)) {
        runnersBySessionId.delete(input.sessionId);
      }
      return result;
    },
    cancelSession: async (input: Readonly<{
      sessionId: string;
      scheduler: UsageLimitRecoveryScheduler;
    }>): Promise<UsageLimitRecoveryIntent | null> => {
      const result = await input.scheduler.cancel({ sessionId: input.sessionId });
      runnersBySessionId.delete(input.sessionId);
      return result;
    },
  };
}
