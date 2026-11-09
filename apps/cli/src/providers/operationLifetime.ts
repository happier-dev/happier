import type { RpcOperationDiagnostics } from '@/api/rpc/types';

export type ProviderOperationPhase = 'catalog' | 'registry' | 'dns' | 'purpose_bindings' | 'pre_effect_revalidation' | 'managed_runtime' | 'catalog_dispatch';

/** Provider read/probe observations share the lifetime, including nested reads. */
export function createProviderOperationPhaseObserver(
  report?: (diagnostics: RpcOperationDiagnostics) => void,
  now: () => number = Date.now,
) {
  const origin = now();
  const active: Array<Readonly<{ phase: ProviderOperationPhase }>> = [];
  const phaseDurationsMs: Record<string, number> = {};
  const phaseTimingsMs: Array<RpcOperationDiagnostics['phaseTimingsMs'][number]> = [];
  let startedAtMs = 0;
  let failedPhase: ProviderOperationPhase | undefined;
  let causeCode: 'deadline' | 'cancelled' | undefined;
  let finished = false;
  const publish = () => report?.({
    ...(failedPhase ? { failedPhase, causeCode } : {}),
    phaseDurationsMs: { ...phaseDurationsMs }, phaseTimingsMs: [...phaseTimingsMs],
  });
  const closeInterval = () => {
    const finishedAtMs = Math.max(startedAtMs, now() - origin);
    const phase = active.at(-1)?.phase;
    if (phase) {
      const durationMs = finishedAtMs - startedAtMs;
      phaseDurationsMs[phase] = (phaseDurationsMs[phase] ?? 0) + durationMs;
      phaseTimingsMs.push({ phase, startedAtMs, finishedAtMs, durationMs });
    }
    startedAtMs = finishedAtMs;
  };
  return {
    enter(phase: ProviderOperationPhase) {
      if (finished) return () => {};
      closeInterval();
      const entry = { phase };
      active.push(entry);
      return () => {
        if (finished) return;
        closeInterval();
        active.splice(active.indexOf(entry), 1);
      };
    },
    abandon(reason: 'deadline' | 'cancelled') {
      if (!finished && !failedPhase) {
        failedPhase = active.at(-1)?.phase;
        causeCode = reason;
      }
      return failedPhase;
    },
    finish() {
      if (finished) return;
      closeInterval();
      finished = true;
      publish();
    },
  };
}

export async function observeProviderOperationPhase<T>(
  lifetime: ProviderOperationLifetime | undefined,
  phase: ProviderOperationPhase,
  work: () => Promise<T>,
): Promise<T> {
  const finish = lifetime?.diagnostics?.enter(phase);
  try { return await work(); }
  finally {
    if (lifetime && providerOperationRemainingMs(lifetime) <= 0) lifetime.diagnostics?.abandon('deadline');
    else if (lifetime?.signal?.aborted) lifetime.diagnostics?.abandon('cancelled');
    finish?.();
  }
}

/**
 * One Provider operation, one wall budget.
 *
 * `docs/providers.md` promises a single wall budget covering pre-dispatch
 * resolution, establishment and the complete body. Name resolution is the part
 * of that path the host cannot abort at the OS layer: `node:dns` returns a
 * promise with no signal, so an unresponsive resolver would otherwise hold a
 * probe RPC — or an admitted scheduler slot — open forever.
 *
 * The lifetime carries the caller's existing cancellation signal and any
 * owner-defined deadline. Bounded endpoint operations start that deadline once
 * before registry/DNS work. Launch admission without an owning wall cap keeps
 * cancellation without borrowing an endpoint probe's budget.
 */
export type ProviderOperationLifetime = Readonly<{
  /** The caller's existing cancellation interest, when it has one. */
  signal?: AbortSignal;
  /** Absolute deadline, or Infinity when the containing operation has no wall cap. */
  wallDeadlineAtMs: number;
  diagnostics?: ReturnType<typeof createProviderOperationPhaseObserver>;
}>;

/**
 * Starts the one wall budget shared by a Provider operation. Call this at the
 * public owner before contribution resolution or DNS; downstream work must
 * carry the returned deadline instead of starting a replacement timeout.
 * Omit wallTimeMs when the containing operation defines no wall cap.
 */
export function createProviderOperationLifetime(input: Readonly<{
  signal?: AbortSignal;
  wallTimeMs?: number;
  now?: () => number;
}>): ProviderOperationLifetime {
  const now = input.now ?? Date.now;
  return {
    ...(input.signal ? { signal: input.signal } : {}),
    wallDeadlineAtMs: input.wallTimeMs === undefined ? Infinity : now() + input.wallTimeMs,
  };
}

/** Settled by {@link awaitWithinProviderOperation} when the operation may not continue. */
export class ProviderOperationAbandonedError extends Error {
  readonly reason: 'cancelled' | 'deadline';
  readonly phase?: ProviderOperationPhase;

  constructor(reason: 'cancelled' | 'deadline', phase?: ProviderOperationPhase) {
    super(`Provider operation abandoned: ${reason}`);
    this.name = 'ProviderOperationAbandonedError';
    this.reason = reason;
    this.phase = phase;
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const signal = lifetime.signal;
  const abandoned = (reason: 'cancelled' | 'deadline') =>
    new ProviderOperationAbandonedError(reason, lifetime.diagnostics?.abandon(reason));
  try {
    if (signal?.aborted) throw abandoned('cancelled');
    const remainingMs = providerOperationRemainingMs(lifetime, now);
    if (remainingMs <= 0) throw abandoned('deadline');
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        if (Number.isFinite(remainingMs)) {
          timer = setTimeout(() => reject(abandoned('deadline')), remainingMs);
        }
        if (!signal) return;
        onAbort = () => reject(abandoned('cancelled'));
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

/** Give an abortable transport the same containing operation budget. A caller
 * without a signal still withdraws the transport when that budget settles. */
export async function awaitAbortableWithinProviderOperation<T>(
  work: (signal: AbortSignal) => Promise<T>,
  lifetime: ProviderOperationLifetime,
  now: () => number = Date.now,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  lifetime.signal?.addEventListener('abort', cancel, { once: true });
  if (lifetime.signal?.aborted) controller.abort();
  try {
    const result = await awaitWithinProviderOperation(work(controller.signal), lifetime, now);
    // Aborting a transport may synchronously settle its promise. Such a
    // withdrawal result cannot outrun the containing operation's cancellation.
    if (lifetime.signal?.aborted) throw new ProviderOperationAbandonedError('cancelled', lifetime.diagnostics?.abandon('cancelled'));
    if (providerOperationRemainingMs(lifetime, now) <= 0) throw new ProviderOperationAbandonedError('deadline', lifetime.diagnostics?.abandon('deadline'));
    return result;
  } finally {
    lifetime.signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}
