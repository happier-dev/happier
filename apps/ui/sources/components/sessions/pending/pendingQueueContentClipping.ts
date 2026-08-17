/**
 * A single queued utterance is the send crossover, not a backlog: it is about to be replaced by
 * its own committed transcript row. Capping or line-clamping that one row makes the replacement
 * jump in height. Queues and discarded tombstones retain the compact presentation.
 *
 * This decision is shared by the renderer and the unmeasured-row estimator so Legend never places
 * the tail from a shape different from the one the pending block paints.
 */
export function shouldClipPendingQueueContent(params: Readonly<{
    pendingCount: number;
    discardedCount: number;
}>): boolean {
    return !(params.pendingCount === 1 && params.discardedCount === 0);
}
