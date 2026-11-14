/**
 * Content-free invalidation for Follow wake reconciliation.
 * It carries no source identity or authority: every awakened destination must
 * re-observe, hydrate, authorize and fence the durable edge before admission.
 *
 * Process-wide invalidations come from transports that do not know the
 * destination (the daemon's Account feed, the restricted Machine receiver).
 * A fact owned by one Session (its own durable Session change, its own context
 * usage) wakes only that Session's signal: a session host runs many Sessions,
 * and every awakened Session pays Home reads to re-observe.
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

type SessionScopedWake = Readonly<{ readSessionId: () => string | null | undefined; source: WakeSource }>;
/** Live hosted Session signals; each runtime removes its own on dispose. */
const sessionScoped = new Set<SessionScopedWake>();

/**
 * Without a Session id: every Session in this process. With one: only the
 * signals currently hosting that Session (a change to Session A cannot produce
 * context for its hosted siblings).
 */
export function publishSessionFollowWakeInvalidation(sessionId?: string): void {
  if (sessionId === undefined) {
    publish(processWide);
    return;
  }
  for (const entry of sessionScoped) if (entry.readSessionId() === sessionId) publish(entry.source);
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
  /** Stops receiving Session-addressed invalidations. */
  dispose: () => void;
}>;

/**
 * One Session's Follow wake: process-wide invalidations plus its own.
 * `readSessionId` names the Session it currently hosts (it may swap), so
 * Session-addressed invalidations for that id reach it.
 */
export function createSessionFollowWakeSignal(readSessionId?: () => string | null | undefined): SessionFollowWakeSignal {
  const own: WakeSource = { generation: 0, waiters: new Set() };
  const readGeneration = () => processWide.generation + own.generation;
  const scoped: SessionScopedWake | null = readSessionId ? { readSessionId, source: own } : null;
  if (scoped) sessionScoped.add(scoped);
  return {
    publish: () => publish(own),
    readGeneration,
    waitForChange: (afterGeneration, signal) => waitFor([processWide, own], readGeneration, afterGeneration, signal),
    dispose: () => { if (scoped) sessionScoped.delete(scoped); },
  };
}
