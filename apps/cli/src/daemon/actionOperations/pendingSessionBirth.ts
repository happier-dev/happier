import { projectSessionSpawnNewActionResultV1, type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { ActionOperationScope } from './actionOperationTypes';
import type { ActionOperationStore } from './actionOperationStore';

/** Retains the admitted creator's passive reader, never its executor. */
export function createPendingSessionBirth(store: ActionOperationStore, isActive: (id: string) => boolean) {
  const readers = new Map<string, () => Promise<SessionSpawnNewResultV1 | null>>();
  const pending = new Map<string, Promise<void>>();
  const reconcile = async (scope: ActionOperationScope, id: string): Promise<void> => {
    const read = readers.get(id);
    if (!read || isActive(id)) return;
    const current = store.get(scope, id);
    if (!current) { readers.delete(id); return; }
    if (current.state !== 'running' || current.observation?.kind !== 'outcome_uncertain') {
      readers.delete(id);
      return;
    }
    const joined = pending.get(id);
    if (joined) return await joined;
    const observation = Promise.resolve().then(async () => {
      const result = await read();
      // Explicit same-key resume may have acquired execution while I/O was in flight.
      if (isActive(id) || store.get(scope, id)?.state !== 'running' || !result || result.type === 'pending') return;
      const projected = projectSessionSpawnNewActionResultV1(result);
      if (result.type === 'success') store.succeed(id, projected);
      else store.fail(id, { errorCode: result.code, error: result.code }, projected);
      readers.delete(id);
    }).finally(() => { pending.delete(id); });
    pending.set(id, observation);
    await observation;
  };
  return { retain(id: string, read: () => Promise<SessionSpawnNewResultV1 | null>) { readers.set(id, read); }, reconcile };
}
