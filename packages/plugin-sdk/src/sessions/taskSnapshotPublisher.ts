import type { WorkStateItem, WorkStatePublisher } from '../services/sessions.js';

export type SessionTaskSnapshotEntry = Readonly<Pick<WorkStateItem, 'title' | 'status' | 'priority'>>;

/** Reports complete ordered checklists through the already-bound work-state source. */
export function createSessionTaskSnapshotPublisher(
  publisher: WorkStatePublisher,
  owner: Readonly<Pick<WorkStateItem, 'kind' | 'origin'>>,
): (entries: readonly SessionTaskSnapshotEntry[], signal?: AbortSignal) => Promise<void> {
  let sourceSequence = 0;
  let latest: Readonly<{ fingerprint: string; publication: Promise<void> }> | undefined;
  return (entries, signal) => {
    signal?.throwIfAborted();
    const fingerprint = JSON.stringify(entries.map(({ title, status, priority }) => [title, status, priority]));
    if (latest?.fingerprint === fingerprint) return latest.publication;
    const observedAtMs = Date.now();
    const publication = publisher.publish({
      sourceSequence: ++sourceSequence,
      observedAtMs,
      items: entries.map(({ title, status, priority }, order) => ({
        ...owner, localId: String(order), title, status, order, updatedAtMs: observedAtMs,
        ...(priority === undefined ? {} : { priority }),
      })),
    }, signal ? { signal } : undefined).then(result => {
      if (result.status !== 'applied' && result.status !== 'unchanged') {
        throw new Error('diagnostic' in result ? result.diagnostic.code : 'agent_work_state_publication_unconfirmed');
      }
    }).catch((error: unknown) => {
      if (latest?.publication === publication) latest = undefined;
      throw error;
    });
    latest = { fingerprint, publication };
    return publication;
  };
}
