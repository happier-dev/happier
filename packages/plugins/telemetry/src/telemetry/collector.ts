import type { CaptureRuntime } from '../runtime.js';
import { createTelemetryAssignments, telemetryPartition, TELEMETRY_PARTITION_PREFIX, type TelemetryAssignment } from './assignments.js';

export interface TelemetryCollectorOptions {
    port: number;
    host?: '127.0.0.1' | '0.0.0.0';
    runtime: CaptureRuntime;
    readAssignments: () => Promise<readonly TelemetryAssignment[]>;
    /** The existing Machine-change transport invokes this once per addressed change. */
    subscribeAssignmentsChanged: (refresh: () => Promise<void>) => () => void;
    onEndpointChanged?: (endpoint: string | null) => void;
    /** Affected exception groups after their occurrences committed, for the native issue writer. */
    onExceptionsCommitted?: (environment: Readonly<{ partition: string; environmentId: string }>, fingerprints: readonly string[]) => void;
}

export interface TelemetryCollector {
    endpoint(): string | null;
    refresh(): Promise<void>;
    stop(): Promise<void>;
}

export async function startTelemetryCollector(options: TelemetryCollectorOptions): Promise<TelemetryCollector> {
    const admission = createTelemetryAssignments();
    const knownPartitions = new Set<string>();
    let receiver: { endpoint: string; release: () => Promise<void> } | null = null;
    let stopped = false;
    // Reconcile offline removal from the same store, without a second persisted
    // assignment record. Local capture partitions are never selected for deletion.
    for (const partition of await options.runtime.store.listPartitions()) {
        if (partition.startsWith(TELEMETRY_PARTITION_PREFIX)) knownPartitions.add(partition);
    }
    let pending = Promise.resolve();

    async function reconcile(): Promise<void> {
        if (stopped) return;
        const assignments = await options.readAssignments();
        admission.replace(assignments);
        const assigned = new Set(assignments.map(assignment => telemetryPartition(assignment.environmentId)));
        if (assigned.size > 0 && !receiver) {
            receiver = await options.runtime.acquireReceiver({
                port: options.port,
                host: options.host,
                // Required only by the generic receiver; admission always supplies
                // the authenticated Environment context before any body is read.
                context: { partition: '' },
                admit: request => admission.admit(request),
                onExceptionsCommitted: (context, fingerprints) => options.onExceptionsCommitted?.({ partition: context.partition,
                    environmentId: context.partition.slice(TELEMETRY_PARTITION_PREFIX.length) }, fingerprints),
            });
            options.onEndpointChanged?.(receiver.endpoint);
        } else if (assigned.size === 0 && receiver) {
            options.onEndpointChanged?.(null);
            await receiver.release();
            receiver = null;
        }
        for (const partition of assigned) knownPartitions.add(partition);
        for (const partition of knownPartitions) {
            if (assigned.has(partition)) continue;
            await options.runtime.clear(partition);
            knownPartitions.delete(partition);
        }
    }

    function refresh(): Promise<void> {
        if (stopped) return Promise.resolve();
        // Changes and initial adoption share one reconciliation. A failed read is
        // reported to its caller; a later pushed change can still recover it.
        pending = pending.then(reconcile, reconcile);
        return pending;
    }
    const unsubscribe = options.subscribeAssignmentsChanged(refresh);
    async function stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        try { await pending; }
        finally {
            admission.replace([]);
            if (receiver) options.onEndpointChanged?.(null);
            await receiver?.release();
            receiver = null;
        }
    }
    try { await refresh(); }
    catch (error) {
        await stop().catch(() => {});
        throw error;
    }
    return { endpoint: () => receiver?.endpoint ?? null, refresh, stop };
}
