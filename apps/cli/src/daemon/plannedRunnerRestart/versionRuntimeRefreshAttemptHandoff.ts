import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

type Attempt<TCompletion> = Readonly<{
  settle: (completion: TCompletion) => void;
  takeTransientSpawnOptions: () => SpawnSessionOptions | undefined;
  transferToPid: (pid: number) => void;
}>;

export function createVersionRuntimeRefreshAttemptHandoff<TCompletion>(params: Readonly<{
  timeoutMs: number;
  timeoutCompletion: TCompletion;
  supersededCompletion: TCompletion;
  cancelledCompletion: TCompletion;
}>) {
  const attemptsBySessionAndPid = new Map<string, Attempt<TCompletion>>();
  const key = (sessionId: string, pid: number): string => `${sessionId}\u0000${pid}`;

  const settle = (sessionId: string, pid: number, completion: TCompletion): void => {
    const attemptKey = key(sessionId, pid);
    const attempt = attemptsBySessionAndPid.get(attemptKey);
    if (!attempt) return;
    attemptsBySessionAndPid.delete(attemptKey);
    attempt.settle(completion);
  };

  const create = (input: Readonly<{
    sessionId: string;
    previousPid: number;
    transientSpawnOptions?: SpawnSessionOptions;
    /**
     * `null` delegates completion exclusively to the canonical respawn owner.
     * Omit this field to retain the bounded public/manual restart behavior.
     */
    timeoutMs?: number | null;
  }>): Readonly<{
    promise: Promise<TCompletion>;
    cancel: () => void;
  }> => {
    let currentPid = input.previousPid;
    let pendingTransientSpawnOptions = input.transientSpawnOptions;
    let resolved = false;
    let resolveCompletion!: (completion: TCompletion) => void;
    const promise = new Promise<TCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const timeoutMs =
      input.timeoutMs === undefined
        ? params.timeoutMs
        : input.timeoutMs;
    const timer = timeoutMs === null
      ? null
      : setTimeout(() => {
          settle(
            input.sessionId,
            currentPid,
            params.timeoutCompletion,
          );
        }, timeoutMs) as NodeJS.Timeout & {
          unref?: () => void;
        };
    timer?.unref?.();
    const settleAttempt = (completion: TCompletion) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      resolveCompletion(completion);
    };
    const attemptKey = key(input.sessionId, input.previousPid);
    attemptsBySessionAndPid.get(attemptKey)?.settle(params.supersededCompletion);
    attemptsBySessionAndPid.set(attemptKey, {
      settle: settleAttempt,
      takeTransientSpawnOptions: () => {
        const value = pendingTransientSpawnOptions;
        pendingTransientSpawnOptions = undefined;
        return value;
      },
      transferToPid: (pid) => {
        currentPid = pid;
      },
    });
    return {
      promise,
      cancel: () => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        attemptsBySessionAndPid.delete(key(input.sessionId, currentPid));
        resolveCompletion(params.cancelledCompletion);
      },
    };
  };

  return {
    create,
    settle,
    takeTransientSpawnOptions: (sessionId: string, pid: number): SpawnSessionOptions | undefined => {
      return attemptsBySessionAndPid.get(key(sessionId, pid))?.takeTransientSpawnOptions();
    },
    transferPid: (sessionId: string, fromPid: number, toPid: number): void => {
      const fromKey = key(sessionId, fromPid);
      const attempt = attemptsBySessionAndPid.get(fromKey);
      if (!attempt) return;
      attemptsBySessionAndPid.delete(fromKey);
      const toKey = key(sessionId, toPid);
      attemptsBySessionAndPid.get(toKey)?.settle(params.supersededCompletion);
      attempt.transferToPid(toPid);
      attemptsBySessionAndPid.set(toKey, attempt);
    },
  };
}
