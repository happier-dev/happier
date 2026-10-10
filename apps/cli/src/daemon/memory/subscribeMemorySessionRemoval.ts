import type { MemoryWorkerHandle } from './memoryWorker';

type Unsubscribe = () => void;

type Subscribe<T> = (listener: (change: T) => void | Promise<void>) => Unsubscribe;

/**
 * Connects the incumbent Account-change and Session-update seams to the daemon
 * memory owner's removal operation.
 *
 * Deletion, access revocation, and cursor-loss reconciliation are consumed
 * inside the change carrier's custody window: this listener deliberately does
 * not swallow cleanup failures, so the Account cursor stays put and recovery
 * retries. Archive-state transitions carry no such custody and are handed to
 * the memory owner, which holds the archived-eligibility decision.
 */
export function subscribeMemorySessionRemoval(params: Readonly<{
  memoryWorker: Pick<
    MemoryWorkerHandle,
    'removeSessions' | 'reconcileRetainedSessionAccess' | 'applySessionArchivedState' | 'noteSessionTranscriptRevised'
  >;
  onSessionTranscriptRevised?: Subscribe<Readonly<{ sessionId: string; seq: number; messageId?: string }>>;
  onSessionDeletedChange: Subscribe<Readonly<{ sessionId: string }>>;
  onSessionAccessRevoked: Subscribe<Readonly<{ sessionId: string }>>;
  onSessionAccessReset: Subscribe<Readonly<{ cursor: number }>>;
  onSessionArchivedStateChange: Subscribe<Readonly<{ sessionId: string; archived: boolean }>>;
}>): Unsubscribe {
  const purge = async (change: Readonly<{ sessionId: string }>): Promise<void> => {
    await params.memoryWorker.removeSessions([change.sessionId]);
  };

  const unsubscribes = [
    params.onSessionDeletedChange(purge),
    params.onSessionAccessRevoked(purge),
    params.onSessionAccessReset(
      async () => await params.memoryWorker.reconcileRetainedSessionAccess(),
    ),
    params.onSessionArchivedStateChange(
      async (change) => await params.memoryWorker.applySessionArchivedState(change),
    ),
  ];
  if (params.onSessionTranscriptRevised && params.memoryWorker.noteSessionTranscriptRevised) {
    const noteRevision = params.memoryWorker.noteSessionTranscriptRevised;
    unsubscribes.push(params.onSessionTranscriptRevised(async change => await noteRevision(change)));
  }

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
