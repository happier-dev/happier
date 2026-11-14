/**
 * Content-free invalidation for Follow wake reconciliation.
 * It carries no source identity or authority: every awakened destination must
 * re-observe, hydrate, authorize and fence the durable edge before admission.
 *
 * Process-wide invalidations come from transports that do not know the
 * destination (Account change fallbacks, the restricted Machine receiver).
 * A fact owned by one Session (its own context usage) wakes only that
 * Session's signal: a session host runs many Sessions, and every awakened
 * Session pays Home reads to re-observe.
 */
type WakeSource = { generation: number; readonly waiters: Set<() => void> };

const processWide: WakeSource = { generation: 0, waiters: new Set() };

function publish(source: WakeSource): void {
  source.generation += 1;
  for (const wake of [...source.waiters]) wake();
}

function waitFor(sources: readonly WakeSource[], readGeneration: () => number, afterGeneration: number,
  signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (readGeneration() !== afterGeneration) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (changed: boolean) => {
      for (const source of sources) source.waiters.delete(onWake);
      signal.removeEventListener('abort', onAbort);
      resolve(changed);
    };
    const onWake = () => finish(true);
    const onAbort = () => finish(false);
    for (const source of sources) source.waiters.add(onWake);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function publishSessionFollowWakeInvalidation(): void {
  publish(processWide);
}

export function readSessionFollowWakeInvalidationGeneration(): number {
  return processWide.generation;
}

export function waitForSessionFollowWakeInvalidation(
  afterGeneration: number,
  signal: AbortSignal,
): Promise<boolean> {
  return waitFor([processWide], readSessionFollowWakeInvalidationGeneration, afterGeneration, signal);
}

export type SessionFollowWakeSignal = Readonly<{
  /** Wakes only this Session's waiters. */
  publish: () => void;
  /** Monotonic over process-wide and this Session's invalidations. */
  readGeneration: () => number;
  waitForChange: (afterGeneration: number, signal: AbortSignal) => Promise<boolean>;
}>;

/** One Session's Follow wake: process-wide invalidations plus its own. */
export function createSessionFollowWakeSignal(): SessionFollowWakeSignal {
  const own: WakeSource = { generation: 0, waiters: new Set() };
  const readGeneration = () => processWide.generation + own.generation;
  return {
    publish: () => publish(own),
    readGeneration,
    waitForChange: (afterGeneration, signal) => waitFor([processWide, own], readGeneration, afterGeneration, signal),
  };
}
