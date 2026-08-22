export type ExecutionRunControllerFailureSignal = Readonly<{
  promise: Promise<never>;
  readError: () => Error | null;
  fail: (error: Error) => void;
}>;

const NEVER_FAILURE_PROMISE = new Promise<never>(() => {});

export function failureSignal(): ExecutionRunControllerFailureSignal {
  let failedError: Error | null = null;
  let rejectFailure!: (error: Error) => void;

  const promise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });

  return {
    promise,
    readError: () => failedError,
    fail(error) {
      if (failedError) {
        return;
      }
      failedError = error;
      rejectFailure(error);
    },
  };
}

export function appendExecutionRunControllerHostBarrier(
  currentBarrier: Promise<void> | undefined,
  nextBarrier: Promise<unknown> | (() => Promise<unknown>),
): Promise<void> {
  const startNext = async (): Promise<void> => {
    await (typeof nextBarrier === 'function' ? nextBarrier() : nextBarrier);
  };
  return currentBarrier ? currentBarrier.then(startNext) : startNext();
}

export function readExecutionRunControllerHostBarrier(ctrl: Readonly<{
  pendingHostBarrier?: Promise<void>;
}>): Promise<void> | null {
  return ctrl.pendingHostBarrier ?? null;
}

export async function raceExecutionRunControllerFailure<T>(
  ctrl: Readonly<{
    failureSignal?: ExecutionRunControllerFailureSignal;
  }>,
  task: Promise<T>,
): Promise<T> {
  const failurePromise = ctrl.failureSignal?.promise ?? NEVER_FAILURE_PROMISE;
  return await Promise.race([task, failurePromise]);
}

export function throwIfExecutionRunControllerFailed(ctrl: Readonly<{
  failureSignal?: ExecutionRunControllerFailureSignal;
}>): void {
  const error = ctrl.failureSignal?.readError() ?? null;
  if (error) {
    throw error;
  }
}
