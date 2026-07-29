/**
 * Per-service lifecycle guard (refinement 5 of FP-LSV-MANAGED-1).
 *
 * Two layers, both mirroring the reference lifecycle defenses:
 *  1. A per-`serviceKey` in-flight promise map so concurrent start/stop/restart of the
 *     SAME service serialize (different services stay parallel). This is the reference
 *     `pendingWorkspaceServicePortPlans` single-flight, generalized to all lifecycle ops.
 *  2. A process-local monotonic run-identity sequence with the current stamp retained per
 *     `serviceKey`. A captured stamp lets a stale process-exit / health tick short-circuit
 *     when it is no longer the current run (the
 *     `current.terminalId !== terminal.id` short-circuit, worktree-bootstrap.ts:920).
 *     This complements the registry's pid guard so the runtime/preview/port-release layer
 *     cannot be torn down by a dead run's exit, including after stop then restart.
 */
export type LocalServiceLifecycleGuard = Readonly<{
    /** Serialize an operation per serviceKey; concurrent same-key ops queue behind it. */
    run<T>(serviceKey: string, operation: () => Promise<T>): Promise<T>;
    /** Bump and return the new run-identity stamp for a serviceKey (call at spawn). */
    nextRunId(serviceKey: string): number;
    /** The current run-identity stamp for a serviceKey (0 if never spawned). */
    currentRunId(serviceKey: string): number;
    /** True when the captured stamp is still the current run for that serviceKey. */
    isCurrentRun(serviceKey: string, runId: number): boolean;
    /** Drop run-identity state for a serviceKey (call on stop). */
    forget(serviceKey: string): void;
}>;

export function createLocalServiceLifecycleGuard(): LocalServiceLifecycleGuard {
    const inFlight = new Map<string, Promise<unknown>>();
    const runIds = new Map<string, number>();
    let lastIssuedRunId = 0;

    return {
        run<T>(serviceKey: string, operation: () => Promise<T>): Promise<T> {
            const previous = inFlight.get(serviceKey) ?? Promise.resolve();
            const next = previous.catch(() => undefined).then(operation);
            inFlight.set(serviceKey, next);
            // Clean the map once this is the tail so it does not grow unbounded.
            void next.catch(() => undefined).finally(() => {
                if (inFlight.get(serviceKey) === next) {
                    inFlight.delete(serviceKey);
                }
            });
            return next;
        },
        nextRunId(serviceKey) {
            const next = ++lastIssuedRunId;
            runIds.set(serviceKey, next);
            return next;
        },
        currentRunId(serviceKey) {
            return runIds.get(serviceKey) ?? 0;
        },
        isCurrentRun(serviceKey, runId) {
            return (runIds.get(serviceKey) ?? 0) === runId;
        },
        forget(serviceKey) {
            runIds.delete(serviceKey);
        },
    };
}
