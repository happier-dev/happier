import { waitForAccountEncryptionObservation as waitForSharedOperation } from '@happier-dev/sync-client';

const materializationAttemptTailByRootDir = new Map<string, Promise<void>>();
const materializationPromotionTailByRootDir = new Map<string, Promise<void>>();

/** A live predecessor retains write custody even when a queued caller stops waiting. */
async function runSerializedOnRootTail<T>(
  tailByRootDir: Map<string, Promise<void>>,
  rootDir: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previousTail = tailByRootDir.get(rootDir) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const currentTailSegment = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const currentTail = previousTail.catch(() => {}).then(() => currentTailSegment);
  tailByRootDir.set(rootDir, currentTail);
  // A canceled middle segment may retire before its predecessor. Keep that chained
  // tail registered until it settles, so a later writer cannot bypass the predecessor.
  void currentTail.then(() => {
    if (tailByRootDir.get(rootDir) === currentTail) tailByRootDir.delete(rootDir);
  });

  try {
    const predecessor = previousTail.catch(() => {});
    await (signal ? waitForSharedOperation(predecessor, signal) : predecessor);
    signal?.throwIfAborted();
    // Once started, work retains custody until its own abort-aware I/O has settled.
    return await work();
  } finally {
    releaseCurrent();
  }
}

export async function runSerializedMaterializationPromotion<T>(
  rootDir: string,
  promote: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await runSerializedOnRootTail(materializationPromotionTailByRootDir, rootDir, promote, signal);
}

export async function runSerializedMaterialization<T>(
  rootDir: string,
  materialize: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await runSerializedOnRootTail(materializationAttemptTailByRootDir, rootDir, materialize, signal);
}
