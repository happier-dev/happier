import { retainIfEqual, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import type { WorkflowActivityLiveBatch, WorkflowActivityLiveFact } from '@/sync/domains/workflows/workflowActivityTypes';
import { socketApplyFrame, type SocketApplyFrameScheduler } from '../sessions/socketApplyFrame';

const EMPTY_KEYS: readonly string[] = Object.freeze([]);
type Listener = () => void;

export type WorkflowActivityProjection = Readonly<{
    apply(batch: WorkflowActivityLiveBatch): void;
    getKeys(): readonly string[];
    getRow(key: string): WorkflowActivityLiveFact | undefined;
    subscribeKeys(listener: Listener): () => void;
    subscribeRow(key: string, listener: Listener): () => void;
    dispose(): void;
}>;

/**
 * The shared list materialization, never an event source. Both hosts share the source-bound
 * instance; VirtualizedList consumes stable keys and mounted rows subscribe to their own key.
 * No row models, source subscriptions, retention cap, or cadence belongs to a host.
 */
export function createWorkflowActivityProjection(
    scheduler: Pick<SocketApplyFrameScheduler, 'schedule'> = socketApplyFrame,
): WorkflowActivityProjection {
    const rows = new Map<string, WorkflowActivityLiveFact>();
    const pending = new Map<string, WorkflowActivityLiveFact>();
    const keyListeners = new Set<Listener>();
    const rowListeners = new Map<string, Set<Listener>>();
    let keys = EMPTY_KEYS;
    let cancelFrame: (() => void) | null = null;
    let disposed = false;

    function compareKeys(left: string, right: string): number {
        const time = rows.get(right)!.occurredAt - rows.get(left)!.occurredAt;
        return time || (left === right ? 0 : left < right ? 1 : -1);
    }

    function flush(): void {
        cancelFrame = null;
        const changed = [...pending.values()];
        pending.clear();
        let ordered: string[] | undefined;
        for (const row of changed) {
            const previous = rows.get(row.key);
            rows.set(row.key, row);
            if (previous !== undefined && previous.occurredAt === row.occurredAt) continue;
            ordered ??= [...keys];
            if (previous !== undefined) ordered.splice(ordered.indexOf(row.key), 1);
            let start = 0;
            let end = ordered.length;
            while (start < end) {
                const middle = (start + end) >>> 1;
                if (compareKeys(row.key, ordered[middle]!) < 0) end = middle;
                else start = middle + 1;
            }
            ordered.splice(start, 0, row.key);
        }
        const previousKeys = keys;
        if (ordered) keys = retainKeyedRows(keys, ordered, key => key);
        // Every callback sees the complete frame, including any changed ordering.
        for (const row of changed) {
            const listeners = rowListeners.get(row.key);
            if (listeners) for (const listener of listeners) listener();
        }
        if (keys !== previousKeys) for (const listener of keyListeners) listener();
    }

    return {
        apply(batch) {
            if (disposed) return;
            for (const incoming of batch) {
                const committed = rows.get(incoming.key);
                const row = retainIfEqual(committed, incoming);
                if (row === committed) pending.delete(incoming.key);
                else pending.set(incoming.key, retainIfEqual(pending.get(incoming.key), row));
            }
            if (pending.size === 0) {
                cancelFrame?.();
                cancelFrame = null;
            } else if (cancelFrame === null) {
                cancelFrame = scheduler.schedule(flush, 0);
            }
        },
        getKeys: () => keys,
        getRow: key => rows.get(key),
        subscribeKeys(listener) {
            keyListeners.add(listener);
            return () => { keyListeners.delete(listener); };
        },
        subscribeRow(key, listener) {
            const listeners = rowListeners.get(key) ?? new Set<Listener>();
            rowListeners.set(key, listeners);
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) rowListeners.delete(key);
            };
        },
        dispose() {
            disposed = true;
            cancelFrame?.();
            cancelFrame = null;
            pending.clear();
            rows.clear();
            keys = EMPTY_KEYS;
            rowListeners.clear();
            keyListeners.clear();
        },
    };
}
