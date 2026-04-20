export function createSwitchToTerminalAbortPromise(params: {
  barrier: Promise<void>;
  createAbortError: () => Error;
}): Promise<never> {
  return params.barrier.then(() => {
    throw params.createAbortError();
  });
}
