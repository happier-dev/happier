export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts?: {
    timeoutMs?: number;
    intervalMs?: number;
    failFast?: boolean;
    shouldRetryOnError?: (error: unknown) => boolean;
    context?: string;
  },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 50;
  const failFast = opts?.failFast === true;
  const shouldRetryOnError = opts?.shouldRetryOnError ?? (() => true);
  const contextSuffix = typeof opts?.context === 'string' && opts.context.trim().length > 0 ? ` (${opts.context.trim()})` : '';
  const startedAt = Date.now();
  let lastError: unknown = null;

  const describeError = (error: unknown): string => {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  };

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
      if (failFast || !shouldRetryOnError(error)) {
        throw error;
      }
    }
    await sleep(intervalMs);
  }

  if (lastError) {
    throw new Error(`Timed out waiting for condition${contextSuffix}; last error: ${describeError(lastError)}`);
  }
  throw new Error(`Timed out waiting for condition${contextSuffix}`);
}
