/**
 * One Provider operation, one wall budget.
 *
 * `docs/providers.md` promises a single wall budget covering pre-dispatch
 * resolution, establishment and the complete body. Name resolution is the part
 * of that path the host cannot abort at the OS layer: `node:dns` returns a
 * promise with no signal, so an unresponsive resolver would otherwise hold a
 * probe RPC — or an admitted scheduler slot — open forever.
 *
 * The lifetime is a deadline plus the caller's existing cancellation signal, not
 * a second timeout: the owner starts it once, before registry/DNS work, and
 * every later stage spends the remaining time rather than restarting the budget.
 */
export type ProviderOperationLifetime = Readonly<{
  /** The caller's existing cancellation interest, when it has one. */
  signal?: AbortSignal;
  /** Absolute time at which the whole operation's wall budget is spent. */
  wallDeadlineAtMs: number;
}>;

/**
 * Starts the one wall budget shared by a Provider operation. Call this at the
 * public owner before contribution resolution or DNS; downstream work must
 * carry the returned deadline instead of starting a replacement timeout.
 */
export function createProviderOperationLifetime(input: Readonly<{
  signal?: AbortSignal;
  wallTimeMs: number;
  now?: () => number;
}>): ProviderOperationLifetime {
  const now = input.now ?? Date.now;
  return {
    ...(input.signal ? { signal: input.signal } : {}),
    wallDeadlineAtMs: now() + input.wallTimeMs,
  };
}

/** Settled by {@link awaitWithinProviderOperation} when the operation may not continue. */
export class ProviderOperationAbandonedError extends Error {
  readonly reason: 'cancelled' | 'deadline';

  constructor(reason: 'cancelled' | 'deadline') {
    super(`Provider operation abandoned: ${reason}`);
    this.name = 'ProviderOperationAbandonedError';
    this.reason = reason;
  }
}

export function providerOperationRemainingMs(
  lifetime: ProviderOperationLifetime,
  now: () => number = Date.now,
): number {
  return lifetime.wallDeadlineAtMs - now();
}

/**
 * Races an unabortable await against the operation's remaining budget and
 * cancellation signal. The underlying work may continue in the OS/libuv layer;
 * the application promise detaches so the owner can settle through its existing
 * typed refusal and release its slot, lease and listeners.
 */
export async function awaitWithinProviderOperation<T>(
  work: Promise<T>,
  lifetime: ProviderOperationLifetime,
  now: () => number = Date.now,
): Promise<T> {
  if (lifetime.signal?.aborted) throw new ProviderOperationAbandonedError('cancelled');
  const remainingMs = providerOperationRemainingMs(lifetime, now);
  if (remainingMs <= 0) throw new ProviderOperationAbandonedError('deadline');

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const signal = lifetime.signal;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderOperationAbandonedError('deadline')), remainingMs);
        if (!signal) return;
        onAbort = () => reject(new ProviderOperationAbandonedError('cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    // A detached rejection must not surface as an unhandled rejection.
    void work.catch(() => {});
  }
}
