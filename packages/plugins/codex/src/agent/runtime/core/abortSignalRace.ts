export function makeAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function awaitWithAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  extraAbort?: Promise<never>,
): Promise<T> {
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const abortError = makeAbortError('Aborted by user');
    if (signal.aborted) {
      reject(abortError);
      return;
    }
    onAbort = () => reject(abortError);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race(extraAbort ? [promise, abortPromise, extraAbort] : [promise, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
      onAbort = null;
    }
  }
}
